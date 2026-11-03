import assert from 'node:assert/strict';
import test from 'node:test';
import { FilterSortService } from '../js/services/filterService.js';
import { KanbanDnd } from '../js/ui/KanbanDnd.js';

function installDomMocks(t) {
  const listeners = new Map();
  const liveRegion = {
    setAttribute() {},
    remove() {},
    textContent: ''
  };
  const parent = { appendChild() {} };
  const boardEl = {
    parentElement: parent,
    addEventListener(type, handler) {
      listeners.set(type, handler);
    },
    removeEventListener(type) {
      listeners.delete(type);
    },
    querySelectorAll() {
      return [];
    }
  };
  const windowRef = {
    innerWidth: 1200,
    innerHeight: 800,
    addEventListener() {},
    removeEventListener() {}
  };
  const documentRef = {
    hidden: false,
    body: {},
    scrollingElement: null,
    createElement() {
      return liveRegion;
    },
    addEventListener() {},
    removeEventListener() {}
  };
  const previousWindow = globalThis.window;
  const previousDocument = globalThis.document;
  globalThis.window = windowRef;
  globalThis.document = documentRef;
  t.after(() => {
    if (previousWindow === undefined) delete globalThis.window;
    else globalThis.window = previousWindow;
    if (previousDocument === undefined) delete globalThis.document;
    else globalThis.document = previousDocument;
  });
  return { boardEl, listeners };
}

test('KanbanDnd delegates pointer and keyboard events without native HTML drag events', (t) => {
  const { boardEl, listeners } = installDomMocks(t);
  const controller = new KanbanDnd({ boardEl, onTaskMoved() {} });

  assert.deepEqual(
    [...listeners.keys()].sort(),
    ['click', 'keydown', 'pointercancel', 'pointerdown', 'pointermove', 'pointerup']
  );
  controller.destroy();
  assert.equal(listeners.size, 0);
});

test('pointer cancellation releases the captured pointer without moving the task', (t) => {
  const { boardEl, listeners } = installDomMocks(t);
  const zone = {
    dataset: { status: 'new' },
    classList: { remove() {} },
    querySelector() {
      return null;
    }
  };
  let capturedPointer = null;
  let releasedPointer = null;
  const card = {
    dataset: { ticketId: 'TCK-1001', status: 'new' },
    parentElement: zone,
    classList: { add() {}, remove() {} },
    setAttribute() {},
    getBoundingClientRect() {
      return { left: 0, top: 0, width: 200, height: 100 };
    }
  };
  const handle = {
    nodeType: 1,
    closest(selector) {
      if (selector === '[data-dnd-handle]') return this;
      if (selector === '.ticket-card') return card;
      return null;
    },
    setPointerCapture(pointerId) {
      capturedPointer = pointerId;
    },
    hasPointerCapture(pointerId) {
      return capturedPointer === pointerId;
    },
    releasePointerCapture(pointerId) {
      releasedPointer = pointerId;
    }
  };
  let moveCount = 0;
  const controller = new KanbanDnd({
    boardEl,
    onTaskMoved: () => { moveCount += 1; }
  });

  listeners.get('pointerdown')({
    target: handle,
    button: 0,
    pointerId: 7,
    clientX: 20,
    clientY: 20,
    preventDefault() {}
  });
  listeners.get('pointercancel')({ pointerId: 7 });

  assert.equal(capturedPointer, 7);
  assert.equal(releasedPointer, 7);
  assert.equal(moveCount, 0);
  assert.equal(controller.state, null);
  controller.destroy();
});

test('delegated card clicks open details but ignore interactive controls', (t) => {
  const { boardEl, listeners } = installDomMocks(t);
  const card = {
    nodeType: 1,
    dataset: { ticketId: 'TCK-1001' },
    closest(selector) {
      return selector === '.ticket-card' ? this : null;
    }
  };
  const button = {
    nodeType: 1,
    closest(selector) {
      if (selector === '.ticket-card') return card;
      if (selector.includes('button')) return this;
      return null;
    }
  };
  const openedTickets = [];
  const controller = new KanbanDnd({
    boardEl,
    onTaskMoved() {},
    onEditRequest: (ticketId) => openedTickets.push(ticketId)
  });

  listeners.get('click')({ target: button });
  listeners.get('click')({ target: card });

  assert.deepEqual(openedTickets, ['TCK-1001']);
  controller.destroy();
});

test('manual ticket sorting honors sparse order values and keeps stable ties', () => {
  const tickets = [
    { id: 'later', status: 'open', sortOrder: 2048 },
    { id: 'first', status: 'open', sortOrder: 1024 },
    { id: 'tie', status: 'open', sortOrder: 1024 }
  ];

  assert.deepEqual(
    FilterSortService.apply(tickets, { sortField: 'manual' }, new Map()).map((ticket) => ticket.id),
    ['first', 'tie', 'later']
  );
});
