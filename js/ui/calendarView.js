import { getChecklistProgress } from '../services/ticketService.js';

const WEEKDAY_LABELS = ['Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb', 'Dom'];

function closestElement(target, selector) {
  const element = target?.nodeType === 1 ? target : target?.parentElement;
  return element?.closest?.(selector) || null;
}

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
    this.pointerDrag = null;
    this.suppressTicketClick = false;
    this.bindEvents();
  }

  bindEvents() {
    this.container.addEventListener('click', (event) => {
      const monthButton = closestElement(event.target, '[data-calendar-month]');
      if (monthButton) {
        this.month = new Date(this.month.getFullYear(), this.month.getMonth() + Number(monthButton.dataset.calendarMonth), 1);
        this.render(this.tickets, this.canReschedule);
        return;
      }

      if (closestElement(event.target, '[data-calendar-today]')) {
        const today = new Date();
        this.month = new Date(today.getFullYear(), today.getMonth(), 1);
        this.render(this.tickets, this.canReschedule);
        return;
      }

      if (closestElement(event.target, '.calendar-drag-handle')) return;
      const ticket = closestElement(event.target, '[data-calendar-ticket]');
      if (ticket && this.suppressTicketClick) {
        event.preventDefault();
        this.suppressTicketClick = false;
        return;
      }
      if (ticket && this.onTicketClick) this.onTicketClick(ticket.dataset.ticketId);
    });

    this.container.addEventListener('pointerdown', (event) => {
      if (!closestElement(event.target, '.calendar-drag-handle')) return;
      const ticket = closestElement(event.target, '[data-calendar-ticket].can-drag');
      if (!ticket || !this.canReschedule || !this.onDateChange || !event.isPrimary || event.button !== 0) return;

      this.pointerDrag = {
        pointerId: event.pointerId,
        ticketId: ticket.dataset.ticketId,
        ticket,
        startX: event.clientX,
        startY: event.clientY,
        active: false,
        dropTarget: null,
      };
      ticket.setPointerCapture(event.pointerId);
    });

    this.container.addEventListener('pointermove', (event) => {
      const drag = this.pointerDrag;
      if (!drag || drag.pointerId !== event.pointerId) return;

      if (!drag.active) {
        const distance = Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY);
        if (distance < 8) return;
        drag.active = true;
        drag.ticket.classList.add('dragging');
      }

      event.preventDefault();
      const element = document.elementFromPoint(event.clientX, event.clientY);
      const dropTarget = closestElement(element, '[data-calendar-date], [data-calendar-unscheduled]');
      this.setPointerDropTarget(dropTarget && this.container.contains(dropTarget) ? dropTarget : null);
    });

    this.container.addEventListener('pointerup', (event) => {
      this.finishPointerDrag(event);
    });

    this.container.addEventListener('pointercancel', (event) => {
      this.cancelPointerDrag(event);
    });

    this.container.addEventListener('lostpointercapture', (event) => {
      this.cancelPointerDrag(event);
    });
  }

  setPointerDropTarget(dropTarget) {
    if (this.pointerDrag?.dropTarget === dropTarget) return;
    this.pointerDrag?.dropTarget?.classList.remove('is-drop-target');
    this.pointerDrag.dropTarget = dropTarget;
    dropTarget?.classList.add('is-drop-target');
  }

  async finishPointerDrag(event) {
    const drag = this.pointerDrag;
    if (!drag || drag.pointerId !== event.pointerId) return;

    if (drag.active) {
      const element = document.elementFromPoint(event.clientX, event.clientY);
      const dropTarget = closestElement(element, '[data-calendar-date], [data-calendar-unscheduled]');
      this.setPointerDropTarget(dropTarget && this.container.contains(dropTarget) ? dropTarget : null);
    }
    const dropTarget = drag.active ? drag.dropTarget : null;
    this.clearPointerDrag();
    if (!drag.active) return;

    this.suppressTicketClick = true;
    window.setTimeout(() => {
      this.suppressTicketClick = false;
    }, 0);

    const day = dropTarget?.matches('[data-calendar-date]') ? dropTarget : null;
    const unscheduled = dropTarget?.matches('[data-calendar-unscheduled]') ? dropTarget : null;
    const ticket = this.tickets.find((item) => item.id === drag.ticketId);
    if (!dropTarget || !ticket || !this.canReschedule || !this.onDateChange
      || (day && localDateKey(ticket.dueDate) === day.dataset.calendarDate)
      || (unscheduled && !ticket.dueDate)) return;

    await this.onDateChange(drag.ticketId, day?.dataset.calendarDate || null);
  }

  cancelPointerDrag(event) {
    if (this.pointerDrag?.pointerId !== event.pointerId) return;
    this.clearPointerDrag();
  }

  clearPointerDrag() {
    this.pointerDrag?.ticket.classList.remove('dragging');
    this.setPointerDropTarget(null);
    this.pointerDrag = null;
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
    const progress = getChecklistProgress(ticket.checklist);
    return `
      <button class="calendar-ticket${canDrag ? ' can-drag' : ''}" type="button"
        data-calendar-ticket data-ticket-id="${this.escapeHtml(ticket.id)}"
        title="${this.escapeHtml(ticket.id)} · ${this.escapeHtml(ticket.title)}">
        ${canDrag ? '<span class="calendar-drag-handle" aria-hidden="true"><svg viewBox="0 0 24 24" focusable="false"><circle cx="9" cy="5" r="1.5" fill="currentColor"/><circle cx="15" cy="5" r="1.5" fill="currentColor"/><circle cx="9" cy="12" r="1.5" fill="currentColor"/><circle cx="15" cy="12" r="1.5" fill="currentColor"/><circle cx="9" cy="19" r="1.5" fill="currentColor"/><circle cx="15" cy="19" r="1.5" fill="currentColor"/></svg></span>' : ''}
        <span class="calendar-ticket-id">${this.escapeHtml(ticket.id)}</span>
        <span class="calendar-ticket-title">${this.escapeHtml(ticket.title)}</span>
        <span class="calendar-ticket-status">${this.escapeHtml(ticket.status.replace('_', ' '))}</span>
        ${progress.total ? `<span class="calendar-ticket-progress">${progress.completed}/${progress.total} subtareas · ${progress.percentage}%</span>` : ''}
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
