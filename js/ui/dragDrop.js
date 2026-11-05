function closestElement(target, selector) {
  const element = target?.nodeType === 1 ? target : target?.parentElement;
  return element?.closest?.(selector) || null;
}

export class DragDropController {
  constructor({ boardEl, onStatusChange, onEditRequest }) {
    this.boardEl = boardEl;
    this.onStatusChange = onStatusChange;
    this.onEditRequest = onEditRequest;
    this.pointerDrag = null;
    this.bindEvents();
  }

  bindEvents() {
    this.boardEl.addEventListener('pointerdown', (event) => {
      if (event.pointerType !== 'touch' || !event.isPrimary || event.button !== 0) return;
      const handle = closestElement(event.target, '.card-drag-handle');
      const card = handle && closestElement(handle, '.ticket-card');
      if (!handle || !card) return;

      const rect = card.getBoundingClientRect();
      const drag = {
        pointerId: event.pointerId,
        handle,
        card,
        startX: event.clientX,
        startY: event.clientY,
        offsetX: event.clientX - rect.left,
        offsetY: event.clientY - rect.top,
        ghost: null,
        dropZone: null,
        timerId: window.setTimeout(() => this.startPointerDrag(drag), 220)
      };
      this.pointerDrag = drag;
      handle.setPointerCapture(event.pointerId);
    });

    this.boardEl.addEventListener('pointermove', (event) => {
      const drag = this.pointerDrag;
      if (!drag || drag.pointerId !== event.pointerId) return;
      if (!drag.ghost) {
        if (Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY) > 10) {
          this.startPointerDrag(drag);
        }
        if (!drag.ghost) return;
      }

      event.preventDefault();
      drag.ghost.style.transform = `translate3d(${event.clientX - drag.offsetX}px, ${event.clientY - drag.offsetY}px, 0)`;
      const target = document.elementFromPoint(event.clientX, event.clientY);
      const nextDropZone = closestElement(target, '.drop-zone');
      if (drag.dropZone !== nextDropZone) {
        drag.dropZone?.classList.remove('is-dnd-target');
        drag.dropZone = nextDropZone;
        drag.dropZone?.classList.add('is-dnd-target');
      }
    });

    this.boardEl.addEventListener('pointerup', (event) => {
      const drag = this.pointerDrag;
      if (!drag || drag.pointerId !== event.pointerId) return;
      if (drag.ghost) {
        event.preventDefault();
        const target = document.elementFromPoint(event.clientX, event.clientY);
        const dropZone = closestElement(target, '.drop-zone');
        const nextStatus = dropZone?.dataset.status;
        const ticketId = drag.card.dataset.ticketId;
        this.clearPointerDrag(drag);
        if (ticketId && nextStatus && this.onStatusChange) {
          this.onStatusChange(ticketId, nextStatus);
        }
        return;
      }
      this.clearPointerDrag(drag);
    });

    this.boardEl.addEventListener('pointercancel', (event) => {
      if (this.pointerDrag?.pointerId === event.pointerId) {
        this.clearPointerDrag(this.pointerDrag);
      }
    });

    this.boardEl.addEventListener('dragstart', (event) => {
      const card = closestElement(event.target, '.ticket-card');
      if (!card) return;
      if (!closestElement(event.target, '.card-drag-handle')) {
        event.preventDefault();
        return;
      }
      card.classList.add('dragging');
      event.dataTransfer.effectAllowed = 'move';
      event.dataTransfer.setData('text/plain', card.dataset.ticketId);
    });

    this.boardEl.addEventListener('dragend', (event) => {
      const card = closestElement(event.target, '.ticket-card');
      if (card) {
        card.classList.remove('dragging');
      }
    });

    this.boardEl.addEventListener('dragover', (event) => {
      const dropZone = closestElement(event.target, '.drop-zone');
      if (!dropZone) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = 'move';
    });

    this.boardEl.addEventListener('drop', async (event) => {
      const dropZone = closestElement(event.target, '.drop-zone');
      if (!dropZone) return;
      event.preventDefault();
      const nextStatus = dropZone.dataset.status;
      const ticketId = event.dataTransfer.getData('text/plain');
      if (ticketId && nextStatus && this.onStatusChange) {
        await this.onStatusChange(ticketId, nextStatus);
      }
    });

    this.boardEl.addEventListener('click', (event) => {
      const card = closestElement(event.target, '.ticket-card');
      if (!card || closestElement(event.target, 'button, a, input, select, textarea')) return;
      if (this.onEditRequest) {
        this.onEditRequest(card.dataset.ticketId);
      }
    });
  }

  startPointerDrag(drag) {
    if (this.pointerDrag !== drag || !drag.card.isConnected) return;
    window.clearTimeout(drag.timerId);
    const rect = drag.card.getBoundingClientRect();
    const ghost = drag.card.cloneNode(true);
    ghost.classList.add('kanban-dnd-ghost');
    ghost.setAttribute('aria-hidden', 'true');
    ghost.removeAttribute('tabindex');
    ghost.querySelectorAll('button, a, input, select, textarea').forEach((control) => {
      control.remove();
    });
    ghost.style.width = `${rect.width}px`;
    ghost.style.height = `${rect.height}px`;
    ghost.style.top = '0';
    ghost.style.left = '0';
    ghost.style.transform = `translate3d(${drag.startX - drag.offsetX}px, ${drag.startY - drag.offsetY}px, 0)`;
    document.body.appendChild(ghost);
    drag.ghost = ghost;
    drag.card.classList.add('dragging');
    drag.handle.classList.add('is-dragging');
  }

  clearPointerDrag(drag) {
    window.clearTimeout(drag.timerId);
    drag.dropZone?.classList.remove('is-dnd-target');
    drag.ghost?.remove();
    drag.card.classList.remove('dragging');
    drag.handle.classList.remove('is-dragging');
    if (drag.handle.hasPointerCapture?.(drag.pointerId)) {
      drag.handle.releasePointerCapture(drag.pointerId);
    }
    if (this.pointerDrag === drag) this.pointerDrag = null;
  }
}
