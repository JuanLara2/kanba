const WEEKDAY_LABELS = ['Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb', 'Dom'];

export function localDateKey(value) {
  if (value == null || value === '') return '';
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

export function getMonthGridDates(monthDate) {
  const firstDay = new Date(monthDate.getFullYear(), monthDate.getMonth(), 1);
  const mondayOffset = (firstDay.getDay() + 6) % 7;
  const gridStart = new Date(firstDay.getFullYear(), firstDay.getMonth(), 1 - mondayOffset);
  return Array.from({ length: 42 }, (_, index) => (
    new Date(gridStart.getFullYear(), gridStart.getMonth(), gridStart.getDate() + index)
  ));
}

export function dueDateForCalendarDay(day, previousDueDate = null) {
  const previous = previousDueDate ? new Date(previousDueDate) : null;
  const hours = previous && !Number.isNaN(previous.getTime()) ? previous.getHours() : 17;
  const minutes = previous && !Number.isNaN(previous.getTime()) ? previous.getMinutes() : 0;
  return new Date(day.getFullYear(), day.getMonth(), day.getDate(), hours, minutes, 0, 0).toISOString();
}

export class CalendarView {
  constructor({ container, onDateChange, onTicketClick, canReschedule = false }) {
    this.container = container;
    this.onDateChange = onDateChange;
    this.onTicketClick = onTicketClick;
    this.canReschedule = canReschedule;
    this.month = new Date(new Date().getFullYear(), new Date().getMonth(), 1);
    this.tickets = [];
    this.bindEvents();
  }

  bindEvents() {
    this.container.addEventListener('click', (event) => {
      const monthButton = event.target.closest('[data-calendar-month]');
      if (monthButton) {
        this.month = new Date(this.month.getFullYear(), this.month.getMonth() + Number(monthButton.dataset.calendarMonth), 1);
        this.render(this.tickets, this.canReschedule);
        return;
      }

      if (event.target.closest('[data-calendar-today]')) {
        const today = new Date();
        this.month = new Date(today.getFullYear(), today.getMonth(), 1);
        this.render(this.tickets, this.canReschedule);
        return;
      }

      const ticket = event.target.closest('[data-calendar-ticket]');
      if (ticket && this.onTicketClick) this.onTicketClick(ticket.dataset.ticketId);
    });

    this.container.addEventListener('dragstart', (event) => {
      const ticket = event.target.closest('[data-calendar-ticket]');
      if (!ticket || !this.canReschedule) return;
      event.dataTransfer.effectAllowed = 'move';
      event.dataTransfer.setData('text/plain', ticket.dataset.ticketId);
      ticket.classList.add('dragging');
    });

    this.container.addEventListener('dragend', (event) => {
      event.target.closest('[data-calendar-ticket]')?.classList.remove('dragging');
      this.container.querySelectorAll('.calendar-day.is-drop-target, .calendar-unscheduled.is-drop-target')
        .forEach((target) => target.classList.remove('is-drop-target'));
    });

    this.container.addEventListener('dragover', (event) => {
      const dropTarget = event.target.closest('[data-calendar-date], [data-calendar-unscheduled]');
      if (!dropTarget || !this.canReschedule) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = 'move';
      dropTarget.classList.add('is-drop-target');
    });

    this.container.addEventListener('dragleave', (event) => {
      const dropTarget = event.target.closest('[data-calendar-date], [data-calendar-unscheduled]');
      if (dropTarget && !dropTarget.contains(event.relatedTarget)) {
        dropTarget.classList.remove('is-drop-target');
      }
    });

    this.container.addEventListener('drop', async (event) => {
      const day = event.target.closest('[data-calendar-date]');
      const unscheduled = event.target.closest('[data-calendar-unscheduled]');
      const dropTarget = day || unscheduled;
      const ticketId = event.dataTransfer.getData('text/plain');
      if (!dropTarget || !ticketId || !this.canReschedule || !this.onDateChange) return;
      event.preventDefault();
      dropTarget.classList.remove('is-drop-target');
      const ticket = this.tickets.find((item) => item.id === ticketId);
      if (!ticket || (day && localDateKey(ticket.dueDate) === day.dataset.calendarDate)
        || (unscheduled && !ticket.dueDate)) return;
      await this.onDateChange(ticketId, day?.dataset.calendarDate || null);
    });
  }

  render(tickets, canReschedule = this.canReschedule) {
    this.tickets = tickets;
    this.canReschedule = canReschedule;
    const title = this.month.toLocaleDateString('es', { month: 'long', year: 'numeric' });
    const monthTickets = tickets.filter((ticket) => ticket.dueDate);
    const ticketByDate = new Map();
    monthTickets.forEach((ticket) => {
      const key = localDateKey(ticket.dueDate);
      if (!ticketByDate.has(key)) ticketByDate.set(key, []);
      ticketByDate.get(key).push(ticket);
    });
    const weekdays = WEEKDAY_LABELS.map((day) => `<div class="calendar-weekday" role="columnheader">${day}</div>`).join('');
    const days = getMonthGridDates(this.month).map((day) => {
      const key = localDateKey(day);
      const isCurrentMonth = day.getMonth() === this.month.getMonth();
      const isToday = key === localDateKey(new Date());
      const dayTickets = ticketByDate.get(key) || [];
      return `
        <section class="calendar-day${isCurrentMonth ? '' : ' outside-month'}${isToday ? ' is-today' : ''}"
          data-calendar-date="${key}" aria-label="${day.toLocaleDateString('es', { dateStyle: 'full' })}">
          <span class="calendar-day-number">${day.getDate()}</span>
          <div class="calendar-day-tickets">
            ${dayTickets.map((ticket) => this.ticketMarkup(ticket)).join('')}
          </div>
        </section>
      `;
    }).join('');
    const unscheduled = tickets.filter((ticket) => !ticket.dueDate);
    const emptyMessage = this.canReschedule
      ? 'Arrastra un ticket aquí para quitar su fecha límite.'
      : 'No hay tickets sin fecha límite.';
    const emptyState = `<p class="calendar-empty">${emptyMessage}</p>`;

    this.container.innerHTML = `
      <div class="calendar-layout">
        <section class="calendar-main" aria-label="Calendario mensual">
          <header class="calendar-toolbar">
            <div>
              <h2 class="calendar-month-title">${title}</h2>
              <p class="calendar-help">${this.canReschedule ? 'Arrastra un ticket a otro día para cambiar su fecha límite.' : 'Consulta los tickets agrupados por fecha límite.'}</p>
            </div>
            <div class="calendar-navigation">
              <button class="btn btn-outline calendar-nav-button" type="button" data-calendar-month="-1" aria-label="Mes anterior">‹</button>
              <button class="btn btn-outline" type="button" data-calendar-today>Hoy</button>
              <button class="btn btn-outline calendar-nav-button" type="button" data-calendar-month="1" aria-label="Mes siguiente">›</button>
            </div>
          </header>
          <div class="calendar-grid" aria-label="${title}">
            ${weekdays}
            ${days}
          </div>
        </section>
        <aside class="calendar-unscheduled${this.canReschedule ? ' can-drop' : ''}" data-calendar-unscheduled aria-label="Tickets sin fecha límite">
          <h2>Sin fecha <span class="col-counter">${unscheduled.length}</span></h2>
          <p class="calendar-help">${this.canReschedule ? 'Arrastra un ticket a un día o suéltalo aquí para quitar su fecha.' : 'Tickets sin fecha límite.'}</p>
          <div class="calendar-unscheduled-list">
            ${unscheduled.map((ticket) => this.ticketMarkup(ticket)).join('') || emptyState}
          </div>
        </aside>
      </div>
    `;
  }

  ticketMarkup(ticket) {
    const canDrag = this.canReschedule;
    return `
      <button class="calendar-ticket${canDrag ? ' can-drag' : ''}" type="button"
        data-calendar-ticket data-ticket-id="${this.escapeHtml(ticket.id)}"
        ${canDrag ? 'draggable="true"' : ''}
        title="${this.escapeHtml(ticket.id)} · ${this.escapeHtml(ticket.title)}">
        <span class="calendar-ticket-id">${this.escapeHtml(ticket.id)}</span>
        <span class="calendar-ticket-title">${this.escapeHtml(ticket.title)}</span>
        <span class="calendar-ticket-status">${this.escapeHtml(ticket.status.replace('_', ' '))}</span>
      </button>
    `;
  }

  escapeHtml(value) {
    return String(value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }
}
