import { Haptics } from '../utils/haptics.js';

const QUICK_VIEW_ID = 'calendarSubtasksQuickView';
let quickViewCloseTimer = null;
let returnFocusElement = null;
let previousBodyOverflow = '';

function closestElement(target, selector) {
  const element = target?.nodeType === 1 ? target : target?.parentElement;
  return element?.closest?.(selector) || null;
}

function closeQuickView() {
  const quickView = typeof document === 'undefined'
    ? null
    : document.getElementById(QUICK_VIEW_ID);
  if (!quickView || quickView.hidden) return;

  window.clearTimeout(quickViewCloseTimer);
  quickView.classList.remove('is-open');
  quickView.setAttribute('aria-hidden', 'true');
  document.body.style.overflow = previousBodyOverflow;
  quickViewCloseTimer = window.setTimeout(() => {
    quickView.hidden = true;
    returnFocusElement?.focus?.();
    returnFocusElement = null;
  }, 250);
}

export class CalendarQuickView {
  constructor({ onChecklistChange, onError, canEditSubtasks = () => true } = {}) {
    this.onChecklistChange = onChecklistChange;
    this.onError = onError;
    this.canEditSubtasks = canEditSubtasks;
    this.ticket = null;
  }

  initialize() {
    if (typeof document === 'undefined') return null;
    let quickView = document.getElementById(QUICK_VIEW_ID);
    if (!quickView) {
      quickView = document.createElement('div');
      quickView.id = QUICK_VIEW_ID;
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
        if (closestElement(event.target, '[data-quick-view-close]')) closeQuickView();
      });
      quickView.addEventListener('change', (event) => {
        const checkbox = closestElement(event.target, '[data-subtask-index]');
        if (checkbox) void this.handleChecklistChange(checkbox);
      });
      document.addEventListener('keydown', (event) => {
        if (event.key === 'Escape' && !quickView.hidden) {
          event.preventDefault();
          closeQuickView();
        }
      });
      quickView.dataset.initialized = 'true';
    }

    this.element = quickView;
    return quickView;
  }

  getChecklist(ticket = this.ticket) {
    if (Array.isArray(ticket?.subtasks)) return ticket.subtasks;
    return Array.isArray(ticket?.checklist) ? ticket.checklist : [];
  }

  open(ticket, trigger = null) {
    const quickView = this.initialize();
    const checklist = this.getChecklist(ticket);
    if (!quickView || checklist.length === 0) return;

    window.clearTimeout(quickViewCloseTimer);
    this.ticket = ticket;
    returnFocusElement = trigger;
    previousBodyOverflow = document.body.style.overflow;
    quickView.querySelector('.calendar-subtasks-ticket-id').textContent = ticket.id;
    quickView.querySelector('.calendar-subtasks-ticket-title').textContent = ticket.title;
    this.renderChecklist();
    document.body.style.overflow = 'hidden';
    quickView.hidden = false;
    quickView.setAttribute('aria-hidden', 'false');
    window.requestAnimationFrame(() => {
      if (quickView.hidden) return;
      quickView.classList.add('is-open');
      quickView.querySelector('.calendar-subtasks-close').focus();
    });
  }

  renderChecklist() {
    if (!this.element || !this.ticket) return;
    const checklist = this.getChecklist();
    const completed = checklist.filter((item) => item.completed || item.done).length;
    const percent = checklist.length ? Math.round((completed / checklist.length) * 100) : 0;
    const canEdit = this.canEditSubtasks(this.ticket);
    this.element.querySelector('.calendar-subtasks-sheet-percent').textContent =
      `${completed}/${checklist.length} (${percent}%)`;
    this.element.querySelector('.calendar-subtasks-sheet-progress-fill').style.width = `${percent}%`;
    this.element.querySelector('.calendar-subtasks-sheet-list').innerHTML = checklist.map((item, index) => {
      const isCompleted = Boolean(item.completed || item.done);
      const label = String(item.title || item.text || '');
      return `
        <li class="calendar-subtasks-sheet-item${isCompleted ? ' is-completed' : ''}">
          <input class="calendar-subtasks-sheet-checkbox" type="checkbox"
            data-subtask-index="${index}" aria-label="${this.escapeHtml(label)}"
            ${isCompleted ? 'checked ' : ''}${canEdit ? '' : 'disabled'}>
          <span>${this.escapeHtml(label)}</span>
        </li>
      `;
    }).join('');
  }

  async handleChecklistChange(checkbox) {
    const index = Number(checkbox.dataset.subtaskIndex);
    const checklist = this.getChecklist();
    const item = checklist[index];
    if (!item || !Number.isInteger(index)) return;

    const previousCompleted = Boolean(item.completed || item.done);
    const completed = checkbox.checked;
    if (completed === previousCompleted) return;

    Haptics.selectionTick();
    try {
      const result = await this.onChecklistChange?.(this.ticket, index, completed);
      if (result?.status === 'rejected') {
        checkbox.checked = previousCompleted;
        this.updateItemAppearance(checkbox, previousCompleted);
      } else {
        this.renderChecklist();
      }
    } catch (error) {
      this.renderChecklist();
      this.onError?.(error);
    }
  }

  updateItemAppearance(checkbox, completed) {
    const row = checkbox.closest('.calendar-subtasks-sheet-item');
    row?.classList.toggle('is-completed', completed);
  }

  refresh(ticket) {
    if (this.ticket?.id !== ticket?.id) return;
    this.ticket = ticket;
    this.renderChecklist();
  }

  close() {
    closeQuickView();
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
