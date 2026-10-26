import { STATUS_DEFINITIONS } from '../config/constants.js';
import { getChecklistProgress } from '../services/ticketService.js';

export class BoardView {
  constructor(boardContainer, ticketService, usersMap) {
    this.board = boardContainer;
    this.ticketService = ticketService;
    this.usersMap = usersMap;
  }

  render(tickets) {
    const fragment = document.createDocumentFragment();

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
          cardsFragment.appendChild(this.buildCard(ticket, colDef));
        });
        dropZone.appendChild(cardsFragment);
      }

      fragment.appendChild(colEl);
    });

    this.board.replaceChildren(fragment);
  }

  buildCard(ticket, colDef) {
    const card = document.createElement('article');
    card.className = `ticket-card ${colDef.borderClass}`;
    card.draggable = true;
    card.tabIndex = 0;
    card.setAttribute('role', 'button');
    const checklistProgress = getChecklistProgress(ticket.checklist);
    const checklistLabel = checklistProgress.total
      ? ` Subtareas: ${checklistProgress.completed} de ${checklistProgress.total}, ${checklistProgress.percentage}% completado.`
      : '';
    card.setAttribute('aria-label', `${ticket.id}: ${ticket.title}. Estado: ${colDef.name}.${checklistLabel} Pulsa Enter para ver detalles.`);
    card.dataset.ticketId = ticket.id;

    const sla = this.ticketService.evaluateSLA(ticket.dueDate);
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
          ${sla.state === 'overdue' ? '<span class="sla-pill overdue">⚠️ Vencido</span>' : ''}
          ${sla.state === 'warning' ? '<span class="sla-pill warning">⏳ Próximo</span>' : ''}
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
