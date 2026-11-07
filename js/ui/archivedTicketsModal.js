export class ArchivedTicketsModal {
  constructor({ modalEl, ticketService, onRestored }) {
    this.modalEl = modalEl;
    this.ticketService = ticketService;
    this.onRestored = onRestored;
    this.tickets = [];
    this.previousFocus = null;
    this.boundEscape = (event) => {
      if (event.key === 'Escape' && !this.modalEl.classList.contains('hidden')) this.close();
    };
    this.bindEvents();
  }

  bindEvents() {
    document.getElementById('btnCloseArchivedModal')?.addEventListener('click', () => this.close());
    this.modalEl.addEventListener('click', (event) => {
      if (event.target === this.modalEl) this.close();
    });
    document.getElementById('inputSearchArchived')?.addEventListener('input', () => this.render());
    document.getElementById('archivedTicketsList')?.addEventListener('click', (event) => {
      const button = event.target.closest('[data-unarchive-ticket]');
      if (button) void this.restore(button.dataset.unarchiveTicket, button);
    });
  }

  async open() {
    this.previousFocus = document.activeElement;
    this.modalEl.classList.remove('hidden');
    document.body.classList.add('modal-open');
    window.addEventListener('keydown', this.boundEscape);
    document.getElementById('inputSearchArchived').value = '';
    await this.load();
    document.getElementById('inputSearchArchived')?.focus();
  }

  close() {
    window.removeEventListener('keydown', this.boundEscape);
    this.modalEl.classList.add('hidden');
    document.body.classList.remove('modal-open');
    if (this.previousFocus instanceof HTMLElement) this.previousFocus.focus();
  }

  async load() {
    const list = document.getElementById('archivedTicketsList');
    if (!list) return;
    list.innerHTML = '<p class="archived-empty-state">Cargando tickets archivados...</p>';
    try {
      this.tickets = await this.ticketService.getArchivedTickets();
      this.render();
    } catch (error) {
      list.innerHTML = `<p class="archived-empty-state archived-load-error">${this.escapeHtml(error.message || 'No se pudieron cargar los tickets archivados.')}</p>`;
    }
  }

  render() {
    const list = document.getElementById('archivedTicketsList');
    const search = document.getElementById('inputSearchArchived')?.value.trim().toLowerCase() || '';
    if (!list) return;
    const tickets = this.tickets.filter((ticket) => (
      `${ticket.id} ${ticket.title} ${ticket.category || ''}`.toLowerCase().includes(search)
    ));

    if (tickets.length === 0) {
      list.innerHTML = '<div class="archived-empty-state"><strong>No hay tickets en el archivo histórico</strong><span>Los tickets archivados aparecerán aquí.</span></div>';
      return;
    }

    list.innerHTML = tickets.map((ticket) => `
      <article class="archived-ticket-row">
        <div class="archived-ticket-main">
          <span class="archived-ticket-code">#${this.escapeHtml(ticket.id)}</span>
          <h4>${this.escapeHtml(ticket.title)}</h4>
          <p>${this.escapeHtml(ticket.category || 'Sin categoría')} · ${this.formatDate(ticket.archivedAt)}</p>
        </div>
        <button type="button" class="btn ui-button ui-button--secondary ui-button--md archived-restore-button"
          data-unarchive-ticket="${this.escapeHtml(ticket.id)}">
          <svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M9 14 4 9l5-5"/><path d="M4 9h10a6 6 0 0 1 6 6v4"/></svg>
          Restaurar al tablero
        </button>
      </article>
    `).join('');
  }

  async restore(ticketId, button) {
    button.disabled = true;
    try {
      await this.ticketService.unarchiveTicket(ticketId);
      this.tickets = this.tickets.filter((ticket) => ticket.id !== ticketId);
      this.render();
      this.onRestored?.(ticketId);
      window.dispatchEvent(new CustomEvent('ticket:unarchived', { detail: { id: ticketId } }));
    } catch (error) {
      button.disabled = false;
      window.dispatchEvent(new CustomEvent('ticket:archive-error', { detail: { message: error.message } }));
    }
  }

  formatDate(value) {
    if (!value) return 'Fecha no disponible';
    const date = new Date(value);
    return Number.isNaN(date.getTime())
      ? 'Fecha no disponible'
      : date.toLocaleString('es', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
  }

  escapeHtml(value) {
    return String(value ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }
}
