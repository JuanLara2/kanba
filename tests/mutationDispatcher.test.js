import assert from 'node:assert/strict';
import test from 'node:test';
import { MutationDispatcher } from '../js/services/mutationDispatcher.js';

class MemoryOutbox {
  constructor() {
    this.actions = [];
  }

  async add(action) {
    const record = { ...action, id: `action-${this.actions.length + 1}` };
    this.actions.push(record);
    return record;
  }

  async list(scope) {
    return this.actions
      .filter((action) => action.userId === scope.userId && action.workspaceId === scope.workspaceId)
      .slice()
      .sort((first, second) => first.createdAt.localeCompare(second.createdAt));
  }

  async remove(id) {
    this.actions = this.actions.filter((action) => action.id !== id);
  }
}

test('queues offline mutations and replays them sequentially within their scope', async () => {
  const outbox = new MemoryOutbox();
  const order = [];
  let online = false;
  let status = 'new';
  const dispatcher = new MutationDispatcher({ outbox, isOnline: () => online });
  dispatcher.setScope({ userId: 'user-1', workspaceId: 'workspace-1' });
  dispatcher.register('ticket.status.set', {
    async execute(action) {
      order.push(action.payload.status);
      return { id: action.entityId, status: action.payload.status };
    },
    applyPending(ticket, payload) {
      return { ...ticket, status: payload.status };
    }
  });

  const result = await dispatcher.dispatch({
    type: 'ticket.status.set',
    entityId: 'ticket-1',
    payload: { status: 'open' },
    optimistic: () => { status = 'open'; },
    rollback: () => { status = 'new'; }
  });
  const secondResult = await dispatcher.dispatch({
    type: 'ticket.status.set',
    entityId: 'ticket-1',
    payload: { status: 'closed' },
    optimistic: () => { status = 'closed'; },
    rollback: () => { status = 'open'; }
  });

  assert.equal(result.status, 'queued');
  assert.equal(secondResult.status, 'queued');
  assert.equal(status, 'closed');
  assert.equal(outbox.actions.length, 2);
  assert.equal(outbox.actions[0].userId, 'user-1');
  assert.equal(outbox.actions[0].workspaceId, 'workspace-1');
  assert.deepEqual(
    await dispatcher.applyPending([{ id: 'ticket-1', status: 'new' }]),
    [{ id: 'ticket-1', status: 'closed' }]
  );

  online = true;
  assert.equal(await dispatcher.flush(), 2);
  assert.deepEqual(order, ['open', 'closed']);
  assert.equal(outbox.actions.length, 0);
});

test('rolls back a permanent rejection and reports the failure', async () => {
  const errors = [];
  const outbox = new MemoryOutbox();
  const dispatcher = new MutationDispatcher({
    outbox,
    isOnline: () => true,
    onError: (error) => errors.push(error.message)
  });
  let state = 'new';
  let recovered = false;
  dispatcher.setScope({ userId: 'user-1', workspaceId: 'workspace-1' });
  dispatcher.register('ticket.status.set', {
    async execute() {
      const error = new Error('Permiso denegado por RLS.');
      error.status = 403;
      throw error;
    },
    async onRejected() {
      recovered = true;
    }
  });

  const result = await dispatcher.dispatch({
    type: 'ticket.status.set',
    entityId: 'ticket-1',
    payload: { status: 'open' },
    optimistic: () => { state = 'open'; },
    rollback: () => { state = 'new'; }
  });

  assert.equal(result.status, 'rejected');
  assert.equal(state, 'new');
  assert.equal(recovered, true);
  assert.deepEqual(errors, ['Permiso denegado por RLS.']);
  assert.equal(outbox.actions.length, 0);
});

test('retains a transient server failure in the outbox without rolling back', async () => {
  const outbox = new MemoryOutbox();
  const dispatcher = new MutationDispatcher({ outbox, isOnline: () => true });
  let state = 'new';
  dispatcher.setScope({ userId: 'user-1', workspaceId: 'workspace-1' });
  dispatcher.register('ticket.status.set', {
    async execute() {
      const error = new Error('Servicio temporalmente no disponible.');
      error.status = 503;
      throw error;
    }
  });

  const result = await dispatcher.dispatch({
    type: 'ticket.status.set',
    entityId: 'ticket-1',
    payload: { status: 'open' },
    optimistic: () => { state = 'open'; },
    rollback: () => { state = 'new'; }
  });

  assert.equal(result.status, 'queued');
  assert.equal(state, 'open');
  assert.equal(outbox.actions.length, 1);
});

test('keeps pending changes visible for a manual retry after a transient failure', async () => {
  const outbox = new MemoryOutbox();
  let online = false;
  let attempts = 0;
  const dispatcher = new MutationDispatcher({ outbox, isOnline: () => online });
  dispatcher.setScope({ userId: 'user-1', workspaceId: 'workspace-1' });
  dispatcher.register('ticket.status.set', {
    async execute(action) {
      attempts += 1;
      if (attempts === 1) {
        const error = new Error('Servicio temporalmente no disponible.');
        error.status = 503;
        throw error;
      }
      return { id: action.entityId, status: action.payload.status };
    }
  });

  await dispatcher.dispatch({
    type: 'ticket.status.set',
    entityId: 'ticket-1',
    payload: { status: 'open' }
  });
  online = true;

  assert.equal(await dispatcher.flush(), 0);
  assert.equal(outbox.actions.length, 1);
  assert.equal(await dispatcher.flush(), 1);
  assert.equal(outbox.actions.length, 0);
  assert.equal(attempts, 2);
});
