import { getSlaState } from '../services/slaService.js';
import { Haptics } from '../utils/haptics.js';

const WEEKDAY_LABELS = ['Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb', 'Dom'];
const SUBTASK_TOOLTIP_ID = 'calendarSubtaskTooltip';
const SUBTASKS_QUICK_VIEW_ID = 'calendarSubtasksQuickView';
let quickViewCloseTimer = null;
let quickViewReturnFocus = null;
let quickViewPreviousBodyOverflow = '';

function closestElement(target, selector) {
  const element = target?.nodeType === 1 ? target : target?.parentElement;
  return element?.closest?.(selector) || null;
}

function initializeSubtasksQuickView() {
  if (typeof document === 'undefined') return null;
  let quickView = document.getElementById(SUBTASKS_QUICK_VIEW_ID);
  if (!quickView) {
    quickView = document.createElement('div');
    quickView.id = SUBTASKS_QUICK_VIEW_ID;
    quickView.className = 'calendar-subtasks-quick-view';
    quickView.hidden = true;
    quickView.setAttribute('aria-hidden', 'true');
    quickView.innerHTML = `
      <button class="calendar-subtasks-backdrop" type="button" data-quick-view-close aria-label="Cerrar detalle de subtareas"></button>
      <section class="calendar-subtasks-sheet" role="dialog" aria-modal="true" aria-labelledby="calendar-subtasks-title">
        <div class="calendar-subtasks-sheet-handle" aria-hidden="true"></div>
        <header class="calendar-subtasks-sheet-header">
          <div class="calendar-subtasks-sheet-heading">
            <span class="calendar-subtasks-ticket-id"></span>
            <h2 id="calendar-subtasks-title" class="calendar-subtasks-ticket-title"></h2>
          </div>
          <button class="calendar-subtasks-close" type="button" data-quick-view-close aria-label="Cerrar">✕</button>
        </header>
        <div class="calendar-subtasks-sheet-progress">
          <div class="calendar-subtasks-sheet-progress-meta">
            <span>Progreso de subtareas</span>
            <span class="calendar-subtasks-sheet-percent"></span>
          </div>
          <div class="calendar-subtasks-sheet-progress-track">
            <div class="calendar-subtasks-sheet-progress-fill"></div>
          </div>
        </div>
        <ul class="calendar-subtasks-sheet-list"></ul>
      </section>
    `;
    document.body.append(quickView);
  }

  if (quickView.dataset.initialized !== 'true') {
    quickView.addEventListener('click', (event) => {
      if (closestElement(event.target, '[data-quick-view-close]')) closeSubtasksQuickView();
    });
    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && !quickView.hidden) {
        event.preventDefault();
        closeSubtasksQuickView();
      }
    });
    quickView.dataset.initialized = 'true';
  }

  return quickView;
}

function closeSubtasksQuickView() {
  const quickView = typeof document === 'undefined'
    ? null
    : document.getElementById(SUBTASKS_QUICK_VIEW_ID);
  if (!quickView || quickView.hidden) return;

  window.clearTimeout(quickViewCloseTimer);
  quickView.classList.remove('is-open');
  quickView.setAttribute('aria-hidden', 'true');
  document.body.style.overflow = quickViewPreviousBodyOverflow;
  quickViewCloseTimer = window.setTimeout(() => {
    quickView.hidden = true;
    quickViewReturnFocus?.focus?.();
    quickViewReturnFocus = null;
  }, 250);
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
  constructor({ container, onDateChange, onTicketClick, onCreateForDate, onSearch, canReschedule = false }) {
    this.container = container;
    this.onDateChange = onDateChange;
    this.onTicketClick = onTicketClick;
    this.onCreateForDate = onCreateForDate;
    this.onSearch = onSearch;
    this.canReschedule = canReschedule;
    this.month = new Date(new Date().getFullYear(), new Date().getMonth(), 1);
    this.tickets = [];
    this.pointerDrag = null;
    this.suppressTicketClick = false;
    this.subtaskTooltip = null;
    this.subtaskTooltipTicket = null;
    this.subtaskTooltipDescribedBy = null;
    this.bindEvents();
  }

  bindEvents() {
    this.container.addEventListener('mouseover', (event) => {
      const ticket = closestElement(event.target, '[data-calendar-ticket]');
      if (!ticket || ticket.contains(event.relatedTarget)) return;
      this.showSubtaskTooltip(ticket);
    });

    this.container.addEventListener('mouseout', (event) => {
      const ticket = closestElement(event.target, '[data-calendar-ticket]');
      if (!ticket || ticket.contains(event.relatedTarget)) return;
      if (this.subtaskTooltipTicket === ticket) this.hideSubtaskTooltip();
    });

    this.container.addEventListener('focusin', (event) => {
      const ticket = closestElement(event.target, '[data-calendar-ticket]');
      if (ticket) this.showSubtaskTooltip(ticket);
    });

    this.container.addEventListener('focusout', (event) => {
      const ticket = closestElement(event.target, '[data-calendar-ticket]');
      if (!ticket || ticket.contains(event.relatedTarget)) return;
      if (this.subtaskTooltipTicket === ticket) this.hideSubtaskTooltip();
    });

    if (typeof window !== 'undefined') {
      window.addEventListener('scroll', () => this.positionSubtaskTooltip(), true);
      window.addEventListener('resize', () => this.positionSubtaskTooltip());
    }

    this.container.addEventListener('click', (event) => {
      const progressButton = closestElement(event.target, '.calendar-ticket-progress[role="button"]');
      if (progressButton) {
        event.preventDefault();
        event.stopPropagation();
        const ticketElement = closestElement(progressButton, '[data-calendar-ticket]');
        const ticket = this.tickets.find((item) => item.id === ticketElement?.dataset.ticketId);
        if (ticket) this.openSubtasksQuickView(ticket, progressButton);
        return;
      }

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

      if (closestElement(event.target, '[data-calendar-search]')) {
        this.onSearch?.();
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
      if (ticket) return;

      const emptyDate = closestElement(event.target, '[data-calendar-create-date]');
      if (emptyDate) this.onCreateForDate?.(emptyDate.dataset.calendarCreateDate);
    });

    this.container.addEventListener('keydown', (event) => {
      const progressButton = closestElement(event.target, '.calendar-ticket-progress[role="button"]');
      if (progressButton && ['Enter', ' '].includes(event.key)) {
        event.preventDefault();
        event.stopPropagation();
        const ticketElement = closestElement(progressButton, '[data-calendar-ticket]');
        const ticket = this.tickets.find((item) => item.id === ticketElement?.dataset.ticketId);
        if (ticket) this.openSubtasksQuickView(ticket, progressButton);
        return;
      }

      if (!['Enter', ' '].includes(event.key)) return;
      const emptyDate = closestElement(event.target, '[data-calendar-create-date]');
      if (!emptyDate || event.target !== emptyDate) return;
      event.preventDefault();
      this.onCreateForDate?.(emptyDate.dataset.calendarCreateDate);
    });

    this.container.addEventListener('pointerdown', (event) => {
      const handle = closestElement(event.target, '.calendar-drag-handle');
      if (!handle) return;
      const ticket = closestElement(event.target, '[data-calendar-ticket].can-drag');
      if (!ticket || !this.canReschedule || !this.onDateChange || !event.isPrimary || event.button !== 0) return;

      handle.setPointerCapture(event.pointerId);
      this.pointerDrag = {
        pointerId: event.pointerId,
        handle,
        ticketId: ticket.dataset.ticketId,
        ticket,
        startX: event.clientX,
        startY: event.clientY,
        active: false,
        dropTarget: null,
      };
    });

    this.container.addEventListener('pointermove', (event) => {
      const drag = this.pointerDrag;
      if (!drag || drag.pointerId !== event.pointerId) return;

      if (!drag.active) {
        const distance = Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY);
        if (distance <= 5) return;
        drag.active = true;
        drag.ticket.classList.add('dragging');
        Haptics.dragStart();
      }

      event.preventDefault();
      const element = document.elementFromPoint(event.clientX, event.clientY);
      const dropTarget = closestElement(element, '.calendar-day')
        || closestElement(element, '[data-calendar-unscheduled]');
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
    const previousTarget = this.pointerDrag?.dropTarget;
    if (previousTarget?.matches('.calendar-day')) {
      previousTarget.classList.remove('drop-target-active');
    } else {
      previousTarget?.classList.remove('is-drop-target');
    }
    this.pointerDrag.dropTarget = dropTarget;
    if (dropTarget?.matches('.calendar-day')) {
      dropTarget.classList.add('drop-target-active');
    } else {
      dropTarget?.classList.add('is-drop-target');
    }
  }

  async finishPointerDrag(event) {
    const drag = this.pointerDrag;
    if (!drag || drag.pointerId !== event.pointerId) return;

    if (drag.active) {
      const element = document.elementFromPoint(event.clientX, event.clientY);
      const dropTarget = closestElement(element, '.calendar-day')
        || closestElement(element, '[data-calendar-unscheduled]');
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

    const changed = await this.onDateChange(drag.ticketId, day?.dataset.calendarDate || null);
    if (changed !== false) Haptics.dropSuccess();
  }

  cancelPointerDrag(event) {
    if (this.pointerDrag?.pointerId !== event.pointerId) return;
    this.clearPointerDrag();
  }

  clearPointerDrag() {
    const drag = this.pointerDrag;
    if (!drag) return;
    drag.ticket.classList.remove('dragging');
    this.setPointerDropTarget(null);
    this.pointerDrag = null;
    if (drag.handle.hasPointerCapture?.(drag.pointerId)) {
      drag.handle.releasePointerCapture(drag.pointerId);
    }
  }

  render(tickets, canReschedule = this.canReschedule) {
    this.hideSubtaskTooltip();
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
      const isEmpty = dayTickets.length === 0;
      const accessibleDate = day.toLocaleDateString('es', { dateStyle: 'full' });
      return `
        <section class="calendar-day${isCurrentMonth ? '' : ' outside-month'}${isToday ? ' is-today' : ''}${isEmpty ? ' is-empty' : ''}"
          data-calendar-date="${key}"${isEmpty ? ` data-calendar-create-date="${key}" role="button" tabindex="0" aria-label="Crear ticket para ${accessibleDate}"` : ` aria-label="${accessibleDate}"`}>
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
              <button class="calendar-search-button" type="button" data-calendar-search aria-label="Buscar tickets" title="Buscar tickets">
                <svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="m20 20-4-4"/></svg>
              </button>
              <button class="btn btn-outline calendar-nav-button" type="button" data-calendar-month="-1" aria-label="Mes anterior">‹</button>
              <button class="btn btn-outline" type="button" data-calendar-today>Hoy</button>
              <button class="btn btn-outline calendar-nav-button" type="button" data-calendar-month="1" aria-label="Mes siguiente">›</button>
            </div>
          </header>
          <div class="calendar-grid-scroll">
            <div class="calendar-grid" aria-label="${title}">
              ${weekdays}
              ${days}
            </div>
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
      <div class="calendar-bottom-spacer" aria-hidden="true"></div>
    `;
  }

  ticketMarkup(ticket) {
    const canDrag = this.canReschedule;
    const subtasks = Array.isArray(ticket.subtasks)
      ? ticket.subtasks
      : (Array.isArray(ticket.checklist) ? ticket.checklist : []);
    const total = subtasks.length;
    const completed = subtasks.filter((subtask) => subtask.completed || subtask.done).length;
    const percent = total > 0 ? Math.round((completed / total) * 100) : 0;
    const statusClass = ['new', 'open', 'in_progress', 'resolved', 'closed', 'blocked'].includes(ticket.status)
      ? ` status-${ticket.status}`
      : '';
    const slaState = getSlaState(ticket).state;
    const slaClass = ['normal', 'warning', 'overdue'].includes(slaState)
      ? ` sla-${slaState}`
      : '';
    return `
      <div class="calendar-ticket${canDrag ? ' can-drag' : ''}${statusClass}${slaClass}"
        data-calendar-ticket data-ticket-id="${this.escapeHtml(ticket.id)}">
        ${canDrag ? '<span class="calendar-drag-handle" aria-hidden="true"><svg viewBox="0 0 24 24" focusable="false"><circle cx="9" cy="5" r="1.5" fill="currentColor"/><circle cx="15" cy="5" r="1.5" fill="currentColor"/><circle cx="9" cy="12" r="1.5" fill="currentColor"/><circle cx="15" cy="12" r="1.5" fill="currentColor"/><circle cx="9" cy="19" r="1.5" fill="currentColor"/><circle cx="15" cy="19" r="1.5" fill="currentColor"/></svg></span>' : ''}
        <button class="calendar-ticket-main" type="button"
          aria-label="${this.escapeHtml(ticket.id)} · ${this.escapeHtml(ticket.title)}">
          <span class="calendar-ticket-id">${this.escapeHtml(ticket.id)}</span>
          <span class="calendar-ticket-title">${this.escapeHtml(ticket.title)}</span>
          <span class="calendar-ticket-status">${this.escapeHtml(ticket.status.replace('_', ' '))}</span>
        </button>
        ${total ? `
          <span class="calendar-ticket-progress" role="button" tabindex="0"
            aria-label="Ver subtareas: ${completed} de ${total} completadas">
            <span class="calendar-ticket-progress-meta">
              <span class="calendar-ticket-progress-count">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" aria-hidden="true"><polyline points="9 11 12 14 22 4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/></svg>
                ${completed}/${total}
              </span>
              <span class="calendar-ticket-progress-percent">${percent}%</span>
            </span>
            <span class="calendar-ticket-progress-track" aria-hidden="true">
              <span class="calendar-ticket-progress-fill" style="width: ${percent}%;"></span>
            </span>
          </span>
        ` : ''}
      </div>
    `;
  }

  showSubtaskTooltip(ticketElement) {
    const ticket = this.tickets.find((item) => item.id === ticketElement.dataset.ticketId);
    const subtasks = Array.isArray(ticket?.subtasks)
      ? ticket.subtasks
      : (Array.isArray(ticket?.checklist) ? ticket.checklist : []);
    if (!ticket || subtasks.length === 0 || this.pointerDrag?.active) return;

    if (!this.subtaskTooltip) {
      this.subtaskTooltip = document.createElement('div');
      this.subtaskTooltip.id = SUBTASK_TOOLTIP_ID;
      this.subtaskTooltip.className = 'calendar-subtask-tooltip';
      this.subtaskTooltip.setAttribute('role', 'tooltip');
      this.subtaskTooltip.setAttribute('aria-hidden', 'true');
      document.body.append(this.subtaskTooltip);
    }

    const completed = subtasks.filter((subtask) => subtask.completed || subtask.done).length;
    const total = subtasks.length;
    const percent = Math.round((completed / total) * 100);
    const listItems = subtasks.slice(0, 4).map((subtask) => {
      const isCompleted = Boolean(subtask.completed || subtask.done);
      const title = this.escapeHtml(subtask.title || subtask.text || '');
      return `
        <li class="calendar-subtask-item${isCompleted ? ' is-completed' : ''}">
          <span class="calendar-subtask-indicator" aria-hidden="true"></span>
          <span class="calendar-subtask-label">${title}</span>
        </li>
      `;
    }).join('');

    this.subtaskTooltip.innerHTML = `
      <div class="calendar-subtask-tooltip-header">
        <span>Subtareas</span>
        <span>${completed}/${total} (${percent}%)</span>
      </div>
      <ul class="calendar-subtask-list">
        ${listItems}
        ${total > 4 ? `<li class="calendar-subtask-more">+${total - 4} más...</li>` : ''}
      </ul>
    `;
    this.subtaskTooltipDescribedBy?.removeAttribute('aria-describedby');
    this.subtaskTooltipTicket = ticketElement;
    this.subtaskTooltipDescribedBy = ticketElement.contains(document.activeElement)
      ? document.activeElement
      : ticketElement.querySelector('.calendar-ticket-main');
    this.subtaskTooltipDescribedBy?.setAttribute('aria-describedby', SUBTASK_TOOLTIP_ID);
    this.subtaskTooltip.setAttribute('aria-hidden', 'false');
    this.subtaskTooltip.classList.add('is-visible');
    this.positionSubtaskTooltip();
  }

  openSubtasksQuickView(ticket, trigger = null) {
    const subtasks = Array.isArray(ticket.subtasks)
      ? ticket.subtasks
      : (Array.isArray(ticket.checklist) ? ticket.checklist : []);
    if (subtasks.length === 0) return;

    const quickView = initializeSubtasksQuickView();
    if (!quickView) return;

    window.clearTimeout(quickViewCloseTimer);
    this.hideSubtaskTooltip();
    const completed = subtasks.filter((subtask) => subtask.completed || subtask.done).length;
    const percent = Math.round((completed / subtasks.length) * 100);
    quickView.querySelector('.calendar-subtasks-ticket-id').textContent = ticket.id;
    quickView.querySelector('.calendar-subtasks-ticket-title').textContent = ticket.title;
    quickView.querySelector('.calendar-subtasks-sheet-percent').textContent = `${completed}/${subtasks.length} (${percent}%)`;
    quickView.querySelector('.calendar-subtasks-sheet-progress-fill').style.width = `${percent}%`;
    quickView.querySelector('.calendar-subtasks-sheet-list').innerHTML = subtasks.map((subtask) => {
      const isCompleted = Boolean(subtask.completed || subtask.done);
      return `
        <li class="calendar-subtasks-sheet-item${isCompleted ? ' is-completed' : ''}">
          <span class="calendar-subtasks-sheet-check" aria-hidden="true">${isCompleted ? '✓' : ''}</span>
          <span>${this.escapeHtml(subtask.title || subtask.text || '')}</span>
        </li>
      `;
    }).join('');

    quickViewReturnFocus = trigger;
    quickViewPreviousBodyOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    quickView.hidden = false;
    quickView.setAttribute('aria-hidden', 'false');
    window.requestAnimationFrame(() => {
      if (quickView.hidden) return;
      quickView.classList.add('is-open');
      quickView.querySelector('.calendar-subtasks-close').focus();
    });
  }

  hideSubtaskTooltip() {
    if (!this.subtaskTooltip || !this.subtaskTooltipTicket) return;
    this.subtaskTooltipDescribedBy?.removeAttribute('aria-describedby');
    this.subtaskTooltipTicket = null;
    this.subtaskTooltipDescribedBy = null;
    this.subtaskTooltip.setAttribute('aria-hidden', 'true');
    this.subtaskTooltip.classList.remove('is-visible');
  }

  positionSubtaskTooltip() {
    if (!this.subtaskTooltip?.classList.contains('is-visible') || !this.subtaskTooltipTicket) return;
    if (!this.subtaskTooltipTicket.isConnected) {
      this.hideSubtaskTooltip();
      return;
    }

    const ticketRect = this.subtaskTooltipTicket.getBoundingClientRect();
    const tooltipRect = this.subtaskTooltip.getBoundingClientRect();
    const gap = 8;
    const margin = 8;
    const placeAbove = ticketRect.top >= tooltipRect.height + gap + margin;
    const top = placeAbove
      ? ticketRect.top - tooltipRect.height - gap
      : Math.min(ticketRect.bottom + gap, window.innerHeight - tooltipRect.height - margin);
    const left = Math.max(
      margin,
      Math.min(ticketRect.left + ticketRect.width / 2 - tooltipRect.width / 2, window.innerWidth - tooltipRect.width - margin)
    );

    this.subtaskTooltip.style.top = `${Math.max(margin, top)}px`;
    this.subtaskTooltip.style.left = `${left}px`;
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
