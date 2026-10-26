import { SLA_THRESHOLDS_HOURS, STATUS_DEFINITIONS, PRIORITY_ORDER } from '../config/constants.js';

export class TicketService {
  constructor(dbAdapter, authService) {
    this.db = dbAdapter;
    this.auth = authService;
  }

  async getAllTickets() {
    return this.db.getAll('tickets');
  }

  async createTicket({ title, description, priority = 'Media', initialStatus = 'new', assignedTo = null, dueDate = null }) {
    const user = await this.auth.getCurrentUser();
    if (!user) throw new Error('Sesión requerida para crear tickets.');
    if (user.role === 'Reporter' && initialStatus !== 'new') {
      throw new Error('Los reporteros solo pueden crear tickets en estado Nuevo.');
    }
    if ((assignedTo || dueDate) && !this.auth.canAssignOrSetDue(user)) {
      throw new Error('Tu rol no puede asignar responsables ni modificar plazos.');
    }

    const validated = await this.validateTicketFields({ title, description, priority, initialStatus, assignedTo, dueDate });
    const now = new Date().toISOString();
    const newTicket = {
      title: validated.title,
      description: validated.description,
      status: validated.initialStatus,
      priority: validated.priority,
      assignedTo: validated.assignedTo,
      createdBy: user.id,
      createdAt: now,
      updatedAt: now,
      dueDate: validated.dueDate,
      statusHistory: []
    };

    if (typeof this.db.createTicket === 'function') {
      return this.db.createTicket(newTicket);
    }

    const tickets = await this.db.getAll('tickets');
    const nextNum = tickets.reduce((acc, ticket) => {
      const number = Number.parseInt(ticket.id.replace('TCK-', ''), 10);
      return Number.isNaN(number) || number <= acc ? acc : number;
    }, 1000) + 1;
    newTicket.id = `TCK-${nextNum}`;
    await this.db.put('tickets', newTicket);
    return newTicket;
  }

  async updateTicket({ id, title, description, priority, assignedTo, dueDate }) {
    const user = await this.auth.getCurrentUser();
    const ticket = await this.db.getById('tickets', id);
    if (!ticket) throw new Error('El ticket no existe.');

    const canEditContent = this.auth.canEditTicket(user, ticket);
    const canManageAssignment = this.auth.canAssignOrSetDue(user);
    if (!canEditContent && !canManageAssignment) {
      throw new Error('Permisos insuficientes para editar este ticket.');
    }

    const validated = await this.validateTicketFields({
      title: canEditContent ? title : ticket.title,
      description: canEditContent ? description : ticket.description,
      priority: canEditContent ? priority : ticket.priority,
      assignedTo: canManageAssignment && assignedTo !== undefined ? assignedTo : ticket.assignedTo,
      dueDate: canManageAssignment && dueDate !== undefined ? dueDate : ticket.dueDate,
      initialStatus: ticket.status
    });
    const now = new Date().toISOString();
    ticket.title = validated.title;
    ticket.description = validated.description;
    ticket.priority = validated.priority;
    ticket.assignedTo = validated.assignedTo;
    ticket.dueDate = validated.dueDate;
    ticket.updatedAt = now;

    return this.db.put('tickets', ticket);
  }

  async deleteTicket(ticketId) {
    const user = await this.auth.getCurrentUser();
    const ticket = await this.db.getById('tickets', ticketId);
    if (!ticket) throw new Error('El ticket no existe.');
    if (!this.auth.canDelete(user)) {
      throw new Error('Solo un administrador puede eliminar tickets.');
    }

    await this.db.delete('tickets', ticketId);
    return true;
  }

  async changeTicketStatus(ticketId, nextStatus) {
    const user = await this.auth.getCurrentUser();
    const ticket = await this.db.getById('tickets', ticketId);
    if (!ticket) throw new Error('El ticket no existe.');

    if (!this.auth.canChangeStatus(user, ticket)) {
      throw new Error(`Permisos insuficientes: El rol ${user ? user.role : 'Invitado'} no puede transicionar este ticket.`);
    }
    if (!Object.prototype.hasOwnProperty.call(STATUS_DEFINITIONS, nextStatus)) {
      throw new Error('El estado de destino no es válido.');
    }

    if (ticket.status === nextStatus) return ticket;

    const now = new Date().toISOString();
    if (typeof this.db.createTicket !== 'function') {
      if (!Array.isArray(ticket.statusHistory)) ticket.statusHistory = [];
      ticket.statusHistory.push({
        from: ticket.status,
        to: nextStatus,
        changedAt: now,
        changedBy: user.id
      });
    }

    ticket.status = nextStatus;
    ticket.updatedAt = now;

    return this.db.put('tickets', ticket);
  }

  async validateTicketFields({ title, description, priority, initialStatus, assignedTo, dueDate }) {
    const normalizedTitle = String(title ?? '').trim();
    const normalizedDescription = String(description ?? '').trim();
    if (normalizedTitle.length < 4) throw new Error('El título debe tener al menos 4 caracteres.');
    if (!normalizedDescription) throw new Error('La descripción es obligatoria.');
    if (!PRIORITY_ORDER.includes(priority)) throw new Error('La prioridad no es válida.');
    if (!Object.prototype.hasOwnProperty.call(STATUS_DEFINITIONS, initialStatus)) throw new Error('El estado no es válido.');

    let normalizedDueDate = null;
    if (dueDate) {
      const dueTimestamp = new Date(dueDate).getTime();
      if (!Number.isFinite(dueTimestamp)) throw new Error('La fecha límite no es válida.');
      normalizedDueDate = new Date(dueTimestamp).toISOString();
    }

    if (assignedTo) {
      const assignee = await this.db.getById('users', assignedTo);
      if (!assignee || !['Admin', 'Agent'].includes(assignee.role)) {
        throw new Error('El responsable seleccionado no es válido.');
      }
    }

    return {
      title: normalizedTitle,
      description: normalizedDescription,
      priority,
      initialStatus,
      assignedTo: assignedTo || null,
      dueDate: normalizedDueDate
    };
  }

  evaluateSLA(dueDateIso) {
    if (!dueDateIso) return { state: 'none', label: '' };

    const now = Date.now();
    const due = new Date(dueDateIso).getTime();
    if (!Number.isFinite(due)) return { state: 'invalid', label: 'Fecha no válida' };
    const diffHours = (due - now) / (1000 * 60 * 60);

    if (diffHours < SLA_THRESHOLDS_HOURS.OVERDUE) {
      return { state: 'overdue', label: 'Vencido', hours: diffHours };
    }

    if (diffHours <= SLA_THRESHOLDS_HOURS.WARNING) {
      return { state: 'warning', label: 'Por Vencer', hours: diffHours };
    }

    return { state: 'normal', label: 'En Plazo', hours: diffHours };
  }
}
