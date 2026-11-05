import { STATUS_DEFINITIONS } from '../config/constants.js';
import { getChecklistProgress } from '../services/ticketService.js';
import { formatSlaRemaining } from '../services/slaService.js';

export class BoardView {
  constructor(boardContainer, ticketService, usersMap) {
    this.board = boardContainer;
    this.ticketService = ticketService;
    this.usersMap = usersMap;
    this.statusTabs = document.getElementById('mobileStatusTabs');
    this.activeStatus = 'new';
  }

  render(tickets, canChangeStatus = () => false, statusCountTickets = tickets, mobileSelection = {}) {
    const fragment = document.createDocumentFragment();
    const statusCounts = new Map();
    Object.values(STATUS_DEFINITIONS).forEach(({ id }) => {
      statusCounts.set(id, statusCountTickets.filter((ticket) => ticket.status === id).length);
    });
    this.renderStatusTabs(statusCounts);
    this.board.dataset.activeStatus = this.activeStatus;

    Object.values(STATUS_DEFINITIONS).forEach((colDef) => {
      const colTickets = tickets.filter((ticket) => ticket.status === colDef.id);

      const colEl = document.createElement('section');
      colEl.className = 'kanban-col';
      colEl.dataset.colStatus = colDef.id;

      colEl.innerHTML = `
        <header class="kanban-col-header" style="border-top-color: ${colDef.colorHex}">
          <div class="col-title-group">
            <h2 class="col-title">${colDef.name}</h2>
            <span class="col-counter">${colTickets.length}</span>
          </div>
        </header>
        <div class="drop-zone" data-status="${colDef.id}" aria-label="Columna ${colDef.name}"></div>
      `;

      const dropZone = colEl.querySelector('.drop-zone');
      const cardsFragment = document.createDocumentFragment();

      if (colTickets.length === 0) {
        const emptyState = document.createElement('div');
        emptyState.className = 'empty-column';
        emptyState.textContent = 'Sin tickets';
        dropZone.appendChild(emptyState);
      } else {
        colTickets.forEach((ticket) => {
          const card = this.buildCard(ticket, colDef, canChangeStatus(ticket));
          if (mobileSelection.canSelectTicket?.(ticket)) {
            card.appendChild(this.buildSelectionButton(
              ticket,
              mobileSelection.selectedTicketIds?.has(ticket.id) || false,
              mobileSelection.selectionMode || false
            ));
          }
          cardsFragment.appendChild(card);
        });
        dropZone.appendChild(cardsFragment);
      }

      fragment.appendChild(colEl);
    });

    this.board.replaceChildren(fragment);
  }

  renderStatusTabs(statusCounts) {
    if (!this.statusTabs) return;
    const fragment = document.createDocumentFragment();
    Object.values(STATUS_DEFINITIONS).forEach(({ id, name, colorHex }) => {
      const button = document.createElement('button');
      button.className = 'mobile-status-tab';
      button.type = 'button';
      button.dataset.status = id;
      button.setAttribute('aria-pressed', String(this.activeStatus === id));
      button.style.setProperty('--status-color', colorHex);
      button.innerHTML = `<span>${name}</span><span class="mobile-status-count">${statusCounts.get(id) || 0}</span>`;
      fragment.appendChild(button);
    });
    this.statusTabs.replaceChildren(fragment);
  }

  setActiveStatus(status) {
    if (!Object.prototype.hasOwnProperty.call(STATUS_DEFINITIONS, status)) return;
    this.activeStatus = status;
    this.board.dataset.activeStatus = status;
    this.statusTabs?.querySelectorAll('.mobile-status-tab').forEach((button) => {
      button.setAttribute('aria-pressed', String(button.dataset.status === status));
    });
  }

  buildSelectionButton(ticket, selected, selectionMode) {
    const button = document.createElement('button');
    button.className = 'card-selection-toggle';
    button.type = 'button';
    button.dataset.selectTicket = ticket.id;
    button.setAttribute('aria-pressed', String(selected));
    button.setAttribute('aria-label', `${selected ? 'Quitar' : 'Seleccionar'} ticket ${ticket.id}`);
    button.classList.toggle('is-visible', selectionMode);
    button.innerHTML = `<span aria-hidden="true">${selected ? '✓' : ''}</span>`;
    return button;
  }

  buildCard(ticket, colDef, canChangeStatus) {
    const card = document.createElement('article');
    const priority = String(ticket.priority || 'Media').toLowerCase();
    const priorityClass = ({
      baja: 'priority-low',
      media: 'priority-medium',
      alta: 'priority-high',
      urgente: 'priority-high',
    })[priority] || 'priority-medium';
    card.className = `ticket-card ${colDef.borderClass} ${priorityClass}`;
    card.draggable = true;
    card.tabIndex = 0;
    card.setAttribute('role', 'group');
    const complexityScore = Number.isInteger(ticket.complexityScore) ? ticket.complexityScore : 1;
    const checklistProgress = getChecklistProgress(ticket.checklist);
    const checklistLabel = checklistProgress.total
      ? ` Subtareas: ${checklistProgress.completed} de ${checklistProgress.total}, ${checklistProgress.percentage}% completado.`
      : '';
    card.setAttribute('aria-label', `${ticket.id}: ${ticket.title}. Prioridad: ${ticket.priority || 'Media'}. Estado: ${colDef.name}.${checklistLabel} Pulsa Enter para ver detalles.`);
    card.dataset.ticketId = ticket.id;

    const sla = this.ticketService.evaluateSLA(ticket);
    const assignee = this.usersMap.get(ticket.assignedTo) || { fullName: 'Sin asignar' };
    const initial = assignee.fullName.charAt(0).toUpperCase();
    const assigneeAccent = this.getAssigneeAccent(assignee.fullName);
    const dueDateLabel = ticket.dueDate
      ? new Date(ticket.dueDate).toLocaleDateString('es', { day: 'numeric', month: 'short' }).replace('.', '')
      : 'Sin fecha';

    if (sla.state === 'overdue') {
      card.classList.add('sla-overdue');
    } else if (sla.state === 'warning') {
      card.classList.add('sla-warning');
    }

    card.style.setProperty('--assignee-accent', assigneeAccent);
    card.style.setProperty('--assignee-accent-soft', this.withAlpha(assigneeAccent, 0.18));

    card.innerHTML = `
      <div class="card-top">
        <div class="card-identity">
          <span class="card-id">#${this.escapeHtml(ticket.id)}</span>
          <span class="category-pill" title="${this.escapeHtml(ticket.category || 'Consulta')}">${this.escapeHtml(ticket.category || 'Consulta')}</span>
        </div>
        <button class="card-drag-handle" type="button" draggable="true"
          aria-label="Arrastrar ticket"
          title="Arrastrar ticket ${this.escapeHtml(ticket.id)}">
          <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
            <circle cx="9" cy="5" r="1.5" fill="currentColor"/>
            <circle cx="15" cy="5" r="1.5" fill="currentColor"/>
            <circle cx="9" cy="12" r="1.5" fill="currentColor"/>
            <circle cx="15" cy="12" r="1.5" fill="currentColor"/>
            <circle cx="9" cy="19" r="1.5" fill="currentColor"/>
            <circle cx="15" cy="19" r="1.5" fill="currentColor"/>
          </svg>
        </button>
        <div class="card-sla">
          ${canChangeStatus
            ? `<button class="btn-change-status" type="button" data-ticket-id="${this.escapeHtml(ticket.id)}"
                aria-label="Cambiar estado de ${this.escapeHtml(ticket.id)}. Estado actual: ${this.escapeHtml(colDef.name)}"
              aria-haspopup="dialog" aria-controls="ticketStatusSheet"
              aria-expanded="false" style="--status-color: ${colDef.colorHex}">
                <span>${this.escapeHtml(colDef.name)}</span>
                <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
                  <path d="m7 10 5 5 5-5"/>
                </svg>
              </button>`
            : `<span class="ticket-status-label" style="--status-color: ${colDef.colorHex}">${this.escapeHtml(colDef.name)}</span>`}
          ${sla.state === 'overdue' ? '<span class="sla-pill overdue">SLA vencido</span>' : ''}
          ${sla.state === 'warning' ? `<span class="sla-pill warning">SLA ${formatSlaRemaining(sla.remainingMs)}</span>` : ''}
          ${sla.state === 'normal' ? `<span class="sla-pill normal">SLA ${formatSlaRemaining(sla.remainingMs)}</span>` : ''}
        </div>
      </div>
      <h3 class="card-title">${this.escapeHtml(ticket.title)}</h3>
      <p class="card-desc">${this.escapeHtml(ticket.description)}</p>
      ${checklistProgress.total ? `
        <div class="card-checklist-progress" aria-label="Subtareas: ${checklistProgress.completed} de ${checklistProgress.total}, ${checklistProgress.percentage}% completado">
          <div class="card-checklist-label">
            <span>Subtareas</span>
            <span>${checklistProgress.completed}/${checklistProgress.total} · ${checklistProgress.percentage}%</span>
          </div>
          <div class="checklist-progress-track">
            <span class="checklist-progress-fill" style="width: ${checklistProgress.percentage}%; --progress-hue: ${Math.round(checklistProgress.percentage * 1.2)}"></span>
          </div>
        </div>
      ` : ''}
      <div class="card-footer">
        <div class="card-assignee" title="Asignado a: ${this.escapeHtml(assignee.fullName)}">
          ${assignee.avatarUrl ? `<span class="avatar-circle avatar-with-image"><img src="${this.escapeHtml(assignee.avatarUrl)}" alt="" loading="lazy" /></span>` : `<span class="avatar-circle">${initial}</span>`}
          <span class="assignee-text">${this.escapeHtml(assignee.fullName)}</span>
        </div>
        <div class="card-compact-meta">
          <span class="complexity-pill" aria-label="Complejidad ${complexityScore} de 10"><span aria-hidden="true">⚡</span> ${complexityScore}/10</span>
          <span class="card-due-date" aria-label="Fecha límite: ${this.escapeHtml(dueDateLabel)}">
            <svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="5" width="18" height="16" rx="2"/><path d="M16 3v4M8 3v4M3 10h18"/></svg>
            ${this.escapeHtml(dueDateLabel)}
          </span>
        </div>
      </div>
    `;

    if (assignee.avatarUrl) {
      const avatarImage = card.querySelector('.avatar-with-image img');
      avatarImage.addEventListener('error', () => {
        const avatar = avatarImage.closest('.avatar-circle');
        if (!avatar) return;
        avatar.replaceChildren(document.createTextNode(initial));
        avatar.classList.remove('avatar-with-image');
      }, { once: true });
    }

    return card;
  }

  getAssigneeAccent(fullName) {
    const seed = String(fullName || 'Sin asignar').trim();
    let hash = 0;
    for (let index = 0; index < seed.length; index += 1) {
      hash = (hash * 31 + seed.charCodeAt(index)) >>> 0;
    }
    const hue = hash % 360;
    return `hsl(${hue} 72% 62%)`;
  }

  withAlpha(color, alpha) {
    if (typeof color !== 'string' || !color.startsWith('hsl(')) return color;
    return color.replace(/hsl\(([^)]+)\)/, (_, values) => `hsla(${values}, ${alpha})`);
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
