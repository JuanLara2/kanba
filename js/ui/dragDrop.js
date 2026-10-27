function closestElement(target, selector) {
  const element = target?.nodeType === 1 ? target : target?.parentElement;
  return element?.closest?.(selector) || null;
}

export class DragDropController {
  constructor({ boardEl, onStatusChange, onEditRequest }) {
    this.boardEl = boardEl;
    this.onStatusChange = onStatusChange;
    this.onEditRequest = onEditRequest;
    this.bindEvents();
  }

  bindEvents() {
    this.boardEl.addEventListener('dragstart', (event) => {
      const card = closestElement(event.target, '.ticket-card');
      if (!card) return;
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
      if (!card) return;
      if (this.onEditRequest) {
        this.onEditRequest(card.dataset.ticketId);
      }
    });
  }
}
