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
        <div class="drop-zone" data-status="${colDef.id}" role="list" aria-dropeffect="none" aria-label="Columna ${colDef.name}"></div>
      `;

      const dropZone = colEl.querySelector('.drop-zone');
      const cardsFragment = document.createDocumentFragment();

      if (colTickets.length === 0) {
        const emptyState = document.createElement('div');
        emptyState.className = 'empty-column';
        emptyState.setAttribute('role', 'presentation');
        emptyState.textContent = 'Sin tickets';
        dropZone.appendChild(emptyState);
      } else {
        colTickets.forEach((ticket) => {
          const card = this.buildCard(ticket, colDef, canChangeStatus(ticket));
          if (canChangeStatus(ticket)) card.appendChild(this.buildStatusMenuButton(ticket));
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

  buildStatusMenuButton(ticket) {
    const button = document.createElement('button');
    button.className = 'card-status-menu';
    button.type = 'button';
    button.dataset.ticketStatusMenu = ticket.id;
    button.setAttribute('aria-label', `Cambiar estado de ${ticket.id}`);
    button.setAttribute('aria-expanded', 'false');
    button.innerHTML = '<span aria-hidden="true">⋮</span>';
    return button;
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

  buildCard(ticket, colDef, canMove) {
    const card = document.createElement('article');
    card.className = `ticket-card ${colDef.borderClass}`;
    card.tabIndex = 0;
    card.setAttribute('role', 'listitem');
    card.setAttribute('aria-grabbed', 'false');
    const complexityScore = Number.isInteger(ticket.complexityScore) ? ticket.complexityScore : 1;
    const checklistProgress = getChecklistProgress(ticket.checklist);
    const checklistLabel = checklistProgress.total
      ? ` Subtareas: ${checklistProgress.completed} de ${checklistProgress.total}, ${checklistProgress.percentage}% completado.`
      : '';
    card.setAttribute('aria-label', `${ticket.id}: ${ticket.title}. Estado: ${colDef.name}.${checklistLabel} Pulsa Enter para ver detalles.`);
    card.dataset.ticketId = ticket.id;
    card.dataset.status = ticket.status;

    const sla = this.ticketService.evaluateSLA(ticket);
    const assignee = this.usersMap.get(ticket.assignedTo) || { fullName: 'Sin asignar' };
    const initial = assignee.fullName.charAt(0).toUpperCase();

    if (sla.state === 'overdue') {
      card.classList.add('sla-overdue');
    } else if (sla.state === 'warning') {
      card.classList.add('sla-warning');
    }

    card.innerHTML = `
      <div class="card-top">
        <span class="card-id">${ticket.id}</span>
        <div class="badges-row">
          <span class="priority-pill priority-${ticket.priority.toLowerCase()}">${ticket.priority}</span>
          <span class="category-pill">${this.escapeHtml(ticket.category || 'Consulta')}</span>
          <span class="complexity-pill" aria-label="Complejidad ${complexityScore} de 10">Complejidad ${complexityScore}/10</span>
          ${sla.state === 'overdue' ? '<span class="sla-pill overdue">⚠️ SLA vencido</span>' : ''}
          ${sla.state === 'warning' ? `<span class="sla-pill warning">⏳ SLA ${formatSlaRemaining(sla.remainingMs)}</span>` : ''}
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
          <span class="avatar-circle">${initial}</span>
          <span class="assignee-text">${this.escapeHtml(assignee.fullName)}</span>
        </div>
        <div class="card-dates">
          <span>Cre: ${new Date(ticket.createdAt).toLocaleDateString()}</span>
          <span>Venc: ${ticket.dueDate ? new Date(ticket.dueDate).toLocaleDateString() : 'Sin fecha'}</span>
        </div>
      </div>
    `;

    if (assignee.avatarUrl) {
      const avatar = card.querySelector('.avatar-circle');
      const image = document.createElement('img');
      image.alt = '';
      image.loading = 'lazy';
      image.addEventListener('error', () => image.remove(), { once: true });
      image.src = assignee.avatarUrl;
      avatar.replaceChildren(image);
    }

    if (canMove) {
      const dragHandle = document.createElement('button');
      dragHandle.className = 'card-drag-handle';
      dragHandle.type = 'button';
      dragHandle.dataset.dndHandle = '';
      dragHandle.setAttribute('aria-label', `Mover ${ticket.id}: ${ticket.title}`);
      dragHandle.setAttribute('aria-keyshortcuts', 'Space Enter ArrowUp ArrowDown ArrowLeft ArrowRight Escape');
      dragHandle.title = 'Mover con ratón, tacto o teclado';
      dragHandle.innerHTML = '<span aria-hidden="true">⠿</span>';
      card.insertBefore(dragHandle, card.firstChild);
    }

    return card;
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
