function isNetworkError(error, isOnline) {
  if (!isOnline()) return true;
  if ([408, 429].includes(error?.status) || error?.status >= 500) return true;
  return /no fue posible conectar con supabase|failed to fetch|fetch failed|networkerror|load failed/i
    .test(error?.message || '');
}

export class MutationDispatcher {
  constructor({
    outbox,
    isOnline = () => globalThis.navigator?.onLine !== false,
    onError = () => {},
    onQueued = () => {},
    onSynced = () => {}
  }) {
    this.outbox = outbox;
    this.isOnline = isOnline;
    this.onError = onError;
    this.onQueued = onQueued;
    this.onSynced = onSynced;
    this.handlers = new Map();
    this.scope = null;
    this.tail = Promise.resolve();
    this.flushPromise = null;
  }

  setScope(scope) {
    this.scope = scope?.userId && scope?.workspaceId ? { ...scope } : null;
  }

  register(type, handler) {
    if (!type || typeof handler?.execute !== 'function') {
      throw new TypeError('Cada mutación requiere un tipo y un ejecutor.');
    }
    this.handlers.set(type, handler);
  }

  dispatch({ type, entityId, payload, optimistic, rollback }) {
    const handler = this.handlers.get(type);
    if (!handler) return Promise.reject(new Error(`Tipo de mutación no registrado: ${type}`));
    if (!this.scope) return Promise.reject(new Error('Se requiere una sesión para modificar datos.'));

    optimistic?.();
    const action = {
      type,
      entityId,
      payload,
      userId: this.scope.userId,
      workspaceId: this.scope.workspaceId,
      createdAt: new Date().toISOString()
    };

    const operation = this.tail.then(() => this.execute(action, handler, { rollback }));
    this.tail = operation.catch(() => {});
    return operation;
  }

  async execute(action, handler, hooks = {}) {
    if (!this.isOnline()) return this.enqueue(action, hooks);

    let pending;
    try {
      pending = await this.outbox.list(this.scope);
    } catch (error) {
      hooks.rollback?.();
      this.onError(error, action);
      return { status: 'rejected', error };
    }
    if (pending.length > 0) {
      await this.flushPending();
      try {
        pending = await this.outbox.list(this.scope);
      } catch (error) {
        hooks.rollback?.();
        this.onError(error, action);
        return { status: 'rejected', error };
      }
      if (pending.length > 0) return this.enqueue(action, hooks);
    }

    let result;
    try {
      result = await handler.execute(action);
    } catch (error) {
      if (isNetworkError(error, this.isOnline)) return this.enqueue(action, hooks);
      hooks.rollback?.();
      try {
        await handler.onRejected?.(action, error);
      } catch (recoveryError) {
        this.onError(recoveryError, action);
      }
      this.onError(error, action);
      return { status: 'rejected', error };
    }
    try {
      await this.onSynced(action, result);
    } catch (error) {
      this.onError(error, action);
    }
    return { status: 'synced', result };
  }

  async enqueue(action, hooks) {
    try {
      await this.outbox.add(action);
      this.onQueued(action);
      return { status: 'queued' };
    } catch (error) {
      hooks.rollback?.();
      this.onError(error, action);
      return { status: 'rejected', error };
    }
  }

  async applyPending(tickets, scope = this.scope) {
    if (!scope) return tickets;
    const actions = await this.outbox.list(scope);
    const ticketMap = new Map(tickets.map((ticket) => [ticket.id, { ...ticket }]));

    actions.forEach((action) => {
      const handler = this.handlers.get(action.type);
      const ticket = ticketMap.get(action.entityId);
      if (ticket && handler?.applyPending) {
        ticketMap.set(action.entityId, handler.applyPending(ticket, action.payload));
      }
    });
    return [...ticketMap.values()];
  }

  flush() {
    if (this.flushPromise) return this.flushPromise;
    const operation = this.tail.then(() => this.flushPending());
    this.tail = operation.catch(() => {});
    this.flushPromise = operation.finally(() => {
      this.flushPromise = null;
    });
    return this.flushPromise;
  }

  async flushPending() {
    if (!this.scope || !this.isOnline()) return 0;

    const actions = await this.outbox.list(this.scope);
    let synced = 0;
    for (const action of actions) {
      if (!this.isOnline()) break;
      const handler = this.handlers.get(action.type);
      if (!handler) {
        const error = new Error(`No hay un ejecutor registrado para la acción offline ${action.type}.`);
        this.onError(error, action);
        break;
      }

      let result;
      try {
        result = await handler.execute(action);
      } catch (error) {
        if (isNetworkError(error, this.isOnline)) break;
        try {
          await this.outbox.remove(action.id);
        } catch (storageError) {
          this.onError(storageError, action);
          break;
        }
        try {
          await handler.onRejected?.(action, error);
        } catch (recoveryError) {
          this.onError(recoveryError, action);
        }
        this.onError(error, action);
        continue;
      }

      try {
        await this.outbox.remove(action.id);
      } catch (error) {
        this.onError(error, action);
        break;
      }
      try {
        await this.onSynced(action, result);
      } catch (error) {
        this.onError(error, action);
      }
      synced += 1;
    }
    return synced;
  }
}
