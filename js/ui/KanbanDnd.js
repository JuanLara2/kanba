const DRAG_THRESHOLD = 7;
const EDGE_SIZE = 64;
const EDGE_SCROLL_MAX = 14;
const STATUS_SWITCH_DELAY = 550;

function closestElement(target, selector) {
  const element = target?.nodeType === 1 ? target : target?.parentElement;
  return element?.closest?.(selector) || null;
}

function directCards(zone) {
  return [...zone.children].filter((child) =>
    child.matches?.('.ticket-card') && !child.classList.contains('is-dnd-source')
  );
}

function nextFrame(callback) {
  return globalThis.requestAnimationFrame
    ? globalThis.requestAnimationFrame(callback)
    : globalThis.setTimeout(callback, 16);
}

function cancelFrame(frameId) {
  if (frameId === null) return;
  if (globalThis.cancelAnimationFrame) globalThis.cancelAnimationFrame(frameId);
  else globalThis.clearTimeout(frameId);
}

export class KanbanDnd {
  /**
   * Controlador delegado de Pointer Events y teclado. `onTaskMoved` recibe
   * taskId, newStatus, newPosition desde cero y los IDs opcionales de vecinos.
   */
  constructor({
    boardEl,
    statuses,
    onTaskMoved,
    onEditRequest,
    canMove = () => true,
    canReorder = () => true,
    onStatusPreview = () => {},
    onError = (error) => console.error(error)
  }) {
    if (!boardEl) throw new TypeError('KanbanDnd requiere el elemento del tablero.');
    if (typeof onTaskMoved !== 'function') {
      throw new TypeError('KanbanDnd requiere un callback onTaskMoved.');
    }
    this.boardEl = boardEl;
    this.statuses = statuses || [];
    this.onTaskMoved = onTaskMoved;
    this.onEditRequest = onEditRequest;
    this.canMove = canMove;
    this.canReorder = canReorder;
    this.onStatusPreview = onStatusPreview;
    this.onError = onError;
    this.state = null;
    this.frameId = null;
    this.liveRegion = document.createElement('div');
    this.liveRegion.className = 'sr-only';
    this.liveRegion.setAttribute('aria-live', 'polite');
    this.liveRegion.setAttribute('aria-atomic', 'true');
    this.boardEl.parentElement?.appendChild(this.liveRegion);

    this.handlePointerDown = this.handlePointerDown.bind(this);
    this.handlePointerMove = this.handlePointerMove.bind(this);
    this.handlePointerUp = this.handlePointerUp.bind(this);
    this.handlePointerCancel = this.handlePointerCancel.bind(this);
    this.handleKeyDown = this.handleKeyDown.bind(this);
    this.handleClick = this.handleClick.bind(this);
    this.handleWindowBlur = this.handleWindowBlur.bind(this);
    this.handleVisibilityChange = this.handleVisibilityChange.bind(this);

    this.boardEl.addEventListener('pointerdown', this.handlePointerDown);
    this.boardEl.addEventListener('pointermove', this.handlePointerMove);
    this.boardEl.addEventListener('pointerup', this.handlePointerUp);
    this.boardEl.addEventListener('pointercancel', this.handlePointerCancel);
    this.boardEl.addEventListener('keydown', this.handleKeyDown);
    this.boardEl.addEventListener('click', this.handleClick);
    window.addEventListener('blur', this.handleWindowBlur);
    document.addEventListener('visibilitychange', this.handleVisibilityChange);
  }

  handlePointerDown(event) {
    if (this.state || event.button !== 0) return;
    const handle = closestElement(event.target, '[data-dnd-handle]');
    const card = closestElement(handle, '.ticket-card');
    if (!handle || !card || !this.canMove(card.dataset.ticketId)) return;

    // La captura mantiene los eventos en el control mientras el puntero cruza columnas.
    event.preventDefault();
    handle.setPointerCapture?.(event.pointerId);
    this.previewStatus = card.dataset.status;
    const rect = card.getBoundingClientRect();
    this.state = {
      mode: 'pointer',
      pointerId: event.pointerId,
      captureTarget: handle,
      handle,
      card,
      ticketId: card.dataset.ticketId,
      sourceStatus: card.dataset.status,
      sourceParent: card.parentElement,
      rect,
      startX: event.clientX,
      startY: event.clientY,
      x: event.clientX,
      y: event.clientY,
      offsetX: event.clientX - rect.left,
      offsetY: event.clientY - rect.top,
      dragging: false,
      targetZone: null,
      placeholder: null,
      ghost: null,
      originalBeforeId: null,
      originalAfterId: null,
      lastStatusSwitch: 0
    };
  }

  handlePointerMove(event) {
    const state = this.state;
    if (!state || state.mode !== 'pointer' || event.pointerId !== state.pointerId) return;
    state.x = event.clientX;
    state.y = event.clientY;

    if (!state.dragging) {
      // Exige un movimiento intencional para no convertir un clic en un arrastre.
      const distance = Math.hypot(state.x - state.startX, state.y - state.startY);
      if (distance < DRAG_THRESHOLD) return;
      this.startDrag();
    }

    event.preventDefault();
    this.schedulePointerFrame();
  }

  startDrag() {
    const state = this.state;
    if (!state || state.dragging) return;
    state.dragging = true;
    state.card.classList.add('is-dnd-source');
    // El marcador conserva el espacio; la copia fija sigue el puntero sin mover la tarjeta.
    this.createPlaceholder(state);
    this.createGhost(state);
    state.card.setAttribute('aria-grabbed', 'true');
    this.setDropEffects('move');
    this.announce(`Moviendo ${state.ticketId}. Arrastra a una columna y suelta para colocar.`);
    this.updatePointerDrag();
    if (this.shouldContinueAutoScroll(state)) this.schedulePointerFrame();
  }

  schedulePointerFrame() {
    if (this.frameId !== null) return;
    this.frameId = nextFrame(() => {
      this.frameId = null;
      const state = this.state;
      if (!state?.dragging || state.mode !== 'pointer') return;
      this.updatePointerDrag();
      if (this.shouldContinueAutoScroll(state)) this.schedulePointerFrame();
    });
  }

  createPlaceholder(state) {
    const rect = state.rect;
    const placeholder = document.createElement('div');
    placeholder.className = 'kanban-dnd-placeholder';
    placeholder.setAttribute('aria-hidden', 'true');
    placeholder.style.height = `${Math.max(48, rect.height)}px`;
    state.sourceParent.insertBefore(placeholder, state.card);
    state.placeholder = placeholder;
    state.targetZone = state.sourceParent;
    this.setEmptyState(state.sourceParent, true);
    const position = this.getPosition(placeholder);
    state.originalBeforeId = position.beforeTaskId;
    state.originalAfterId = position.afterTaskId;
  }

  createGhost(state) {
    const rect = state.rect;
    const ghost = state.card.cloneNode(true);
    ghost.classList.remove('is-dnd-source');
    ghost.classList.add('kanban-dnd-ghost');
    ghost.hidden = false;
    ghost.setAttribute('aria-hidden', 'true');
    ghost.style.width = `${rect.width}px`;
    ghost.style.height = `${rect.height}px`;
    ghost.style.left = `${rect.left}px`;
    ghost.style.top = `${rect.top}px`;
    ghost.style.transform = 'translate3d(0, 0, 0) rotate(1deg)';
    document.body.appendChild(ghost);
    state.ghost = ghost;
  }

  updatePointerDrag() {
    const state = this.state;
    if (!state?.dragging || state.mode !== 'pointer') return;
    this.scrollAtPointer(state.x, state.y);
    if (state.ghost) {
      state.ghost.style.transform = `translate3d(${state.x - state.startX}px, ${state.y - state.startY}px, 0) rotate(1deg)`;
    }

    // Evalúa el punto visible, no el control que capturó el puntero, para detectar el destino.
    const target = document.elementFromPoint(state.x, state.y);
    let zone = closestElement(target, '.drop-zone');
    if (!zone) zone = closestElement(target, '.kanban-col')?.querySelector('.drop-zone') || null;
    if (!zone) {
      this.switchStatusAtScreenEdge(state);
      zone = this.getZoneForStatus(this.previewStatus);
    }
    if (!zone) {
      state.validTarget = false;
      return;
    }

    this.movePlaceholder(zone, this.getPointerInsertionIndex(zone, state.x, state.y));
    state.targetZone = zone;
    state.validTarget = true;
  }

  getPointerInsertionIndex(zone, x, y) {
    const cards = directCards(zone);
    for (let index = 0; index < cards.length; index += 1) {
      const rect = cards[index].getBoundingClientRect();
      if (y < rect.top + rect.height / 2) return index;
      if (y < rect.bottom) return index + 1;
    }
    return cards.length;
  }

  movePlaceholder(zone, index) {
    const state = this.state;
    if (!state?.placeholder || !zone) return;
    const previousZone = state.targetZone;
    if (previousZone !== zone) this.setEmptyState(previousZone, false);
    const cards = directCards(zone);
    const insertionIndex = Math.max(0, Math.min(index, cards.length));
    const reference = cards[insertionIndex] || null;
    if (state.placeholder.parentElement !== zone || state.placeholder.nextElementSibling !== reference) {
      zone.insertBefore(state.placeholder, reference);
    }
    this.setEmptyState(zone, true);
    state.targetZone = zone;
    if (this.previewStatus !== zone.dataset.status) {
      this.previewStatus = zone.dataset.status;
      this.onStatusPreview(this.previewStatus);
    }
    const position = this.getPosition(state.placeholder);
    const changed = state.sourceStatus !== zone.dataset.status
      || position.beforeTaskId !== state.originalBeforeId
      || position.afterTaskId !== state.originalAfterId;
    zone.classList.toggle('is-dnd-target', changed);
    this.boardEl.querySelectorAll('.drop-zone.is-dnd-target').forEach((item) => {
      if (item !== zone) item.classList.remove('is-dnd-target');
    });
    const announcementKey = `${zone.dataset.status}:${position.newPosition}`;
    if (state.lastAnnouncedPosition !== announcementKey) {
      state.lastAnnouncedPosition = announcementKey;
      this.announcePosition(zone, position.newPosition);
    }
  }

  getPosition(placeholder) {
    const zone = placeholder.parentElement;
    const children = [...zone.children];
    const placeholderIndex = children.indexOf(placeholder);
    const before = children.slice(0, placeholderIndex).reverse()
      .find((child) => child.matches?.('.ticket-card') && !child.classList.contains('is-dnd-source'));
    const after = children.slice(placeholderIndex + 1)
      .find((child) => child.matches?.('.ticket-card') && !child.classList.contains('is-dnd-source'));
    return {
      newPosition: directCards(zone).filter((card) => {
        return [...zone.children].indexOf(card) < placeholderIndex;
      }).length,
      beforeTaskId: before?.dataset.ticketId || null,
      afterTaskId: after?.dataset.ticketId || null
    };
  }

  announcePosition(zone, position) {
    const status = this.statusName(zone.dataset.status);
    this.announce(`${status}, posición ${position + 1}.`);
  }

  switchStatusAtScreenEdge(state) {
    if (window.innerWidth > 768 || state.y < 0 || state.y > window.innerHeight) return;
    const atLeft = state.x <= EDGE_SIZE;
    const atRight = state.x >= window.innerWidth - EDGE_SIZE;
    if (!atLeft && !atRight) return;
    const now = Date.now();
    if (now - state.lastStatusSwitch < STATUS_SWITCH_DELAY) return;
    const currentStatus = this.previewStatus || state.sourceStatus;
    const index = this.statuses.findIndex((status) => status.id === currentStatus);
    const nextIndex = index + (atRight ? 1 : -1);
    if (index < 0 || nextIndex < 0 || nextIndex >= this.statuses.length) return;
    state.lastStatusSwitch = now;
    // En móvil solo se muestra una columna; acercarse al borde cambia la pestaña de estado.
    this.previewStatus = this.statuses[nextIndex].id;
    this.onStatusPreview(this.previewStatus);
  }

  getZoneForStatus(status) {
    if (!status) return null;
    return [...this.boardEl.querySelectorAll('.drop-zone')]
      .find((zone) => zone.dataset.status === status) || null;
  }

  scrollAtPointer(x, y) {
    const containers = [];
    let element = this.boardEl;
    while (element && element !== document.body) {
      containers.push(element);
      element = element.parentElement;
    }
    containers.push(document.scrollingElement);

    // Desplaza solo contenedores con espacio disponible dentro de sus límites.
    containers.forEach((container) => {
      if (!container) return;
      const rect = container === document.scrollingElement
        ? { left: 0, right: window.innerWidth, top: 0, bottom: window.innerHeight }
        : container.getBoundingClientRect();
      if (container.scrollHeight > container.clientHeight) {
        const topDistance = y - rect.top;
        const bottomDistance = rect.bottom - y;
        if (topDistance >= 0 && topDistance < EDGE_SIZE) {
          container.scrollTop -= this.edgeVelocity(topDistance);
        } else if (bottomDistance >= 0 && bottomDistance < EDGE_SIZE) {
          container.scrollTop += this.edgeVelocity(bottomDistance);
        }
      }
      if (container.scrollWidth > container.clientWidth) {
        const leftDistance = x - rect.left;
        const rightDistance = rect.right - x;
        if (leftDistance >= 0 && leftDistance < EDGE_SIZE) {
          container.scrollLeft -= this.edgeVelocity(leftDistance);
        } else if (rightDistance >= 0 && rightDistance < EDGE_SIZE) {
          container.scrollLeft += this.edgeVelocity(rightDistance);
        }
      }
    });
  }

  edgeVelocity(distance) {
    return Math.max(2, Math.round(EDGE_SCROLL_MAX * (1 - distance / EDGE_SIZE)));
  }

  shouldContinueAutoScroll(state) {
    if (window.innerWidth <= 768
      && (state.x <= EDGE_SIZE || state.x >= window.innerWidth - EDGE_SIZE)) {
      const index = this.statuses.findIndex((status) => status.id === (this.previewStatus || state.sourceStatus));
      const adjacentIndex = index + (state.x <= EDGE_SIZE ? -1 : 1);
      if (adjacentIndex >= 0 && adjacentIndex < this.statuses.length) return true;
    }

    let element = this.boardEl;
    while (element && element !== document.body) {
      const rect = element.getBoundingClientRect();
      if (element.scrollHeight > element.clientHeight
        && ((state.y - rect.top < EDGE_SIZE && element.scrollTop > 0)
          || (rect.bottom - state.y < EDGE_SIZE
            && element.scrollTop + element.clientHeight < element.scrollHeight))) {
        return true;
      }
      if (element.scrollWidth > element.clientWidth
        && ((state.x - rect.left < EDGE_SIZE && element.scrollLeft > 0)
          || (rect.right - state.x < EDGE_SIZE
            && element.scrollLeft + element.clientWidth < element.scrollWidth))) {
        return true;
      }
      element = element.parentElement;
    }
    const scrollElement = document.scrollingElement;
    return Boolean(scrollElement
      && ((state.y <= EDGE_SIZE && scrollElement.scrollTop > 0)
        || (window.innerHeight - state.y <= EDGE_SIZE
          && scrollElement.scrollTop + scrollElement.clientHeight < scrollElement.scrollHeight)));
  }

  setEmptyState(zone, dragging) {
    const emptyState = zone?.querySelector('.empty-column');
    if (emptyState) emptyState.hidden = dragging;
  }

  setDropEffects(effect) {
    this.boardEl.querySelectorAll('.drop-zone').forEach((zone) => {
      zone.setAttribute('aria-dropeffect', effect);
    });
  }

  handlePointerUp(event) {
    const state = this.state;
    if (!state || state.mode !== 'pointer' || event.pointerId !== state.pointerId) return;
    if (!state.dragging) {
      this.cleanup(false);
      return;
    }
    state.x = event.clientX;
    state.y = event.clientY;
    this.updatePointerDrag();
    if (!state.validTarget) {
      this.cleanup(false);
      return;
    }
    this.finishDrag();
  }

  handlePointerCancel(event) {
    if (this.state?.mode === 'pointer' && event.pointerId === this.state.pointerId) {
      this.cleanup(false);
    }
  }

  handleKeyDown(event) {
    if (this.state?.mode === 'keyboard') {
      this.handleKeyboardDrag(event);
      return;
    }
    const handle = closestElement(event.target, '[data-dnd-handle]');
    if (!handle || event.repeat || ![' ', 'Enter'].includes(event.key)) return;
    const card = closestElement(handle, '.ticket-card');
    if (!card || !this.canMove(card.dataset.ticketId)) return;
    event.preventDefault();
    this.startKeyboardDrag(card, handle);
  }

  startKeyboardDrag(card, handle) {
    this.state = {
      mode: 'keyboard',
      handle,
      card,
      ticketId: card.dataset.ticketId,
      sourceStatus: card.dataset.status,
      sourceParent: card.parentElement,
      rect: card.getBoundingClientRect(),
      dragging: true,
      targetZone: card.parentElement,
      placeholder: null,
      ghost: null
    };
    card.classList.add('is-dnd-source');
    this.createPlaceholder(this.state);
    card.setAttribute('aria-grabbed', 'true');
    this.setDropEffects('move');
    this.previewStatus = this.state.sourceStatus;
    this.announce(`Seleccionado ${this.state.ticketId}. Usa flechas para moverlo, Enter para colocar o Escape para cancelar.`);
  }

  handleKeyboardDrag(event) {
    const state = this.state;
    if (event.repeat && [' ', 'Enter'].includes(event.key)) return;
    const currentPosition = this.getPosition(state.placeholder);
    if (event.key === 'Escape') {
      event.preventDefault();
      this.cleanup(false);
      state.handle.focus();
      this.announce('Movimiento cancelado.');
      return;
    }
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      this.finishDrag();
      return;
    }
    if (!['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(event.key)) return;
    event.preventDefault();

    // Arriba/abajo cambia la posición; izquierda/derecha selecciona la columna vecina.
    const zone = state.targetZone;
    let nextZone = zone;
    let nextPosition = currentPosition.newPosition;
    if (event.key === 'ArrowUp') nextPosition -= 1;
    if (event.key === 'ArrowDown') nextPosition += 1;
    if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
      const index = this.statuses.findIndex((status) => status.id === zone.dataset.status);
      const direction = event.key === 'ArrowRight' ? 1 : -1;
      const nextStatus = this.statuses[index + direction];
      if (!nextStatus) return;
      this.previewStatus = nextStatus.id;
      this.onStatusPreview(nextStatus.id);
      nextZone = this.getZoneForStatus(nextStatus.id);
    } else if (!this.canReorder()) {
      return;
    }
    if (!nextZone) return;
    this.movePlaceholder(nextZone, nextPosition);
  }

  finishDrag() {
    const state = this.state;
    if (!state?.placeholder?.parentElement) {
      this.cleanup(false);
      return;
    }
    const zone = state.placeholder.parentElement;
    const position = this.getPosition(state.placeholder);
    const changed = zone.dataset.status !== state.sourceStatus
      || position.beforeTaskId !== state.originalBeforeId
      || position.afterTaskId !== state.originalAfterId;
    if (!changed || (zone.dataset.status === state.sourceStatus && !this.canReorder())) {
      this.cleanup(false);
      state.handle.focus();
      this.announce(changed ? 'Activa el orden manual para reordenar tickets.' : 'El ticket conserva su posición.');
      return;
    }

    const movedTask = {
      taskId: state.ticketId,
      newStatus: zone.dataset.status,
      newPosition: position.newPosition,
      beforeTaskId: position.beforeTaskId,
      afterTaskId: position.afterTaskId
    };
    this.cleanup(true);
    this.announce(`${state.ticketId} movido a ${this.statusName(movedTask.newStatus)}.`);
    Promise.resolve(this.onTaskMoved(movedTask))
      .then(() => {
        if (state.mode !== 'keyboard') return;
        const movedCard = [...this.boardEl.querySelectorAll('.ticket-card')]
          .find((card) => card.dataset.ticketId === state.ticketId);
        movedCard?.querySelector('[data-dnd-handle]')?.focus();
      })
      .catch((error) => this.onError(error));
  }

  cleanup(committed) {
    const state = this.state;
    if (!state) return;
    // Libera recursos temporales al soltar, cancelar, perder el foco o destruir el controlador.
    cancelFrame(this.frameId);
    this.frameId = null;
    this.setEmptyState(state.targetZone, false);
    state.placeholder?.remove();
    state.ghost?.remove();
    state.card.hidden = false;
    state.card.classList.remove('is-dnd-source');
    state.card.setAttribute('aria-grabbed', 'false');
    state.card.parentElement?.classList.remove('is-dnd-target');
    this.boardEl.querySelectorAll('.drop-zone.is-dnd-target').forEach((zone) => {
      zone.classList.remove('is-dnd-target');
    });
    this.setDropEffects('none');
    if (state.mode === 'pointer' && state.captureTarget?.hasPointerCapture?.(state.pointerId)) {
      state.captureTarget.releasePointerCapture(state.pointerId);
    }
    if (!committed) {
      this.previewStatus = state.sourceStatus;
      this.onStatusPreview(state.sourceStatus);
    }
    this.state = null;
  }

  handleClick(event) {
    const card = closestElement(event.target, '.ticket-card');
    if (!card || closestElement(event.target, 'button, a, input, select, textarea')) return;
    this.onEditRequest?.(card.dataset.ticketId);
  }

  handleWindowBlur() {
    if (this.state?.mode === 'pointer') this.cleanup(false);
  }

  handleVisibilityChange() {
    if (document.hidden && this.state?.mode === 'pointer') this.cleanup(false);
  }

  statusName(statusId) {
    return this.statuses.find((status) => status.id === statusId)?.name || statusId;
  }

  announce(message) {
    this.liveRegion.textContent = '';
    this.liveRegion.textContent = message;
  }

  destroy() {
    this.cleanup(false);
    this.boardEl.removeEventListener('pointerdown', this.handlePointerDown);
    this.boardEl.removeEventListener('pointermove', this.handlePointerMove);
    this.boardEl.removeEventListener('pointerup', this.handlePointerUp);
    this.boardEl.removeEventListener('pointercancel', this.handlePointerCancel);
    this.boardEl.removeEventListener('keydown', this.handleKeyDown);
    this.boardEl.removeEventListener('click', this.handleClick);
    window.removeEventListener('blur', this.handleWindowBlur);
    document.removeEventListener('visibilitychange', this.handleVisibilityChange);
    this.liveRegion.remove();
  }
}
