import { STATUS_DEFINITIONS, PRIORITY_ORDER, TICKET_CATEGORIES } from '../config/constants.js';
import { getSlaState } from './slaService.js';

export function normalizeChecklist(items) {
  if (!Array.isArray(items) || items.length > 100) {
    throw new Error('La lista puede contener hasta 100 subtareas.');
  }

  return items.map((item) => {
    const text = String(item?.text ?? '').trim();
    if (!text || text.length > 200) {
      throw new Error('Cada subtarea debe tener entre 1 y 200 caracteres.');
    }
    if (typeof item?.completed !== 'boolean') {
      throw new Error('El estado de cada subtarea no es válido.');
    }
    return { text, completed: item.completed };
  });
}

export function getChecklistProgress(items = []) {
  const total = Array.isArray(items) ? items.length : 0;
  const completed = Array.isArray(items) ? items.filter((item) => item.completed).length : 0;
  return {
    completed,
    total,
    percentage: total ? Math.round((completed / total) * 100) : 0
  };
}

export class TicketService {
  constructor(dbAdapter, authService) {
    this.db = dbAdapter;
    this.auth = authService;
  }

  async getAllTickets() {
    return this.db.getAll('tickets');
  }

  async createTicket({ title, description, priority = 'Media', category = 'Consulta', initialStatus = 'new', assignedTo = null, dueDate = null, checklist = [] }) {
    const user = await this.auth.getCurrentUser();
    if (!user) throw new Error('Sesión requerida para crear tickets.');
    if (user.role === 'Reporter' && initialStatus !== 'new') {
      throw new Error('Los reporteros solo pueden crear tickets en estado Nuevo.');
    }
    const canManageChecklist = this.auth.canAssignOrSetDue(user);
    if ((assignedTo || dueDate || (Array.isArray(checklist) && checklist.length > 0)) && !canManageChecklist) {
      throw new Error('Tu rol no puede asignar responsables, modificar plazos ni crear subtareas.');
    }

    const validated = await this.validateTicketFields({
      title,
      description,
      priority,
      category,
      initialStatus,
      assignedTo,
      dueDate,
      checklist,
      workspaceId: user.workspaceId
    });
    const now = new Date().toISOString();
    const newTicket = {
      title: validated.title,
      description: validated.description,
      status: validated.initialStatus,
      priority: validated.priority,
      category: validated.category,
      assignedTo: validated.assignedTo,
      createdBy: user.id,
      workspaceId: user.workspaceId,
      createdAt: now,
      updatedAt: now,
      dueDate: validated.dueDate,
      checklist: validated.checklist,
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

  async updateTicket({ id, title, description, priority, category, assignedTo, dueDate, checklist }) {
    const user = await this.auth.getCurrentUser();
    const ticket = await this.db.getById('tickets', id);
    if (!ticket) throw new Error('El ticket no existe.');

    const canEditContent = this.auth.canEditTicket(user, ticket);
    const canManageChecklist = this.auth.canEditTicket(user, ticket);
    const canManageAssignment = this.auth.canAssignOrSetDue(user);
    if (!canEditContent && !canManageAssignment) {
      throw new Error('Permisos insuficientes para editar este ticket.');
    }

    const validated = await this.validateTicketFields({
      title: canEditContent ? title : ticket.title,
      description: canEditContent ? description : ticket.description,
      priority: canEditContent ? priority : ticket.priority,
      category: canEditContent && category !== undefined ? category : ticket.category,
      assignedTo: canManageAssignment && assignedTo !== undefined ? assignedTo : ticket.assignedTo,
      dueDate: canManageAssignment && dueDate !== undefined ? dueDate : ticket.dueDate,
      checklist: canManageChecklist && checklist !== undefined ? checklist : (ticket.checklist || []),
      initialStatus: ticket.status,
      workspaceId: user.workspaceId
    });
    const now = new Date().toISOString();
    ticket.title = validated.title;
    ticket.description = validated.description;
    ticket.priority = validated.priority;
    ticket.category = validated.category;
    ticket.assignedTo = validated.assignedTo;
    ticket.dueDate = validated.dueDate;
    ticket.checklist = validated.checklist;
    ticket.updatedAt = now;

    return this.db.put('tickets', ticket);
  }

  async rescheduleTicket(ticketId, dueDate) {
    const user = await this.auth.getCurrentUser();
    if (!this.auth.canAssignOrSetDue(user)) {
      throw new Error('Solo Admin y Agent pueden cambiar la fecha límite desde el calendario.');
    }

    const ticket = await this.db.getById('tickets', ticketId);
    if (!ticket) throw new Error('El ticket no existe.');
    if (ticket.workspaceId && ticket.workspaceId !== user.workspaceId) {
      throw new Error('No puedes cambiar fechas de tickets de otro espacio de trabajo.');
    }

    const validated = await this.validateTicketFields({
      title: ticket.title,
      description: ticket.description,
      priority: ticket.priority,
      initialStatus: ticket.status,
      assignedTo: ticket.assignedTo,
      dueDate,
      workspaceId: user.workspaceId
    });
    ticket.dueDate = validated.dueDate;
    ticket.updatedAt = new Date().toISOString();
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

  async reopenTicket(ticketId) {
    const user = await this.auth.getCurrentUser();
    const ticket = await this.db.getById('tickets', ticketId);
    if (!ticket) throw new Error('El ticket no existe.');
    if (ticket.status !== 'resolved') throw new Error('Solo se pueden reabrir tickets resueltos.');
    if (!this.auth.canChangeStatus(user, ticket)) {
      throw new Error('Solo Admin o el agente asignado pueden reabrir este ticket.');
    }
    return this.changeTicketStatus(ticketId, 'open');
  }

  async getComments(ticketId) {
    if (typeof this.db.getComments !== 'function') {
      throw new Error('La consulta de comentarios no está disponible.');
    }
    const user = await this.auth.getCurrentUser();
    const ticket = await this.db.getById('tickets', ticketId);
    if (!this.auth.canCommentOnTicket(user, ticket)) {
      throw new Error('No tienes permiso para consultar los comentarios de este ticket.');
    }
    return this.db.getComments(ticketId);
  }

  async addComment(ticketId, body) {
    const user = await this.auth.getCurrentUser();
    const ticket = await this.db.getById('tickets', ticketId);
    if (!this.auth.canCommentOnTicket(user, ticket)) {
      throw new Error('No tienes permiso para comentar este ticket.');
    }

    const normalizedBody = String(body ?? '').trim();
    if (!normalizedBody || normalizedBody.length > 4000) {
      throw new Error('El comentario debe tener entre 1 y 4000 caracteres.');
    }
    if (typeof this.db.createComment !== 'function') {
      throw new Error('La creación de comentarios no está disponible.');
    }
    return this.db.createComment(ticketId, normalizedBody);
  }

  async getNotifications(userId) {
    if (typeof this.db.getNotifications !== 'function') {
      throw new Error('La consulta de notificaciones no está disponible.');
    }
    return this.db.getNotifications(userId);
  }

  async markNotificationRead(notificationId) {
    if (typeof this.db.markNotificationRead !== 'function') {
      throw new Error('La actualización de notificaciones no está disponible.');
    }
    return this.db.markNotificationRead(notificationId);
  }

  async getResponseTemplates() {
    if (typeof this.db.getResponseTemplates !== 'function') {
      throw new Error('La consulta de plantillas no está disponible.');
    }
    return this.db.getResponseTemplates();
  }

  async saveResponseTemplate({ id, title, body }) {
    const user = await this.auth.getCurrentUser();
    if (!this.auth.canManageUsers(user)) throw new Error('Solo Admin puede administrar plantillas.');
    const normalizedTitle = String(title ?? '').trim();
    const normalizedBody = String(body ?? '').trim();
    if (normalizedTitle.length < 2 || normalizedTitle.length > 100) {
      throw new Error('El nombre de la plantilla debe tener entre 2 y 100 caracteres.');
    }
    if (!normalizedBody || normalizedBody.length > 4000) {
      throw new Error('El texto de la plantilla debe tener entre 1 y 4000 caracteres.');
    }
    if (typeof this.db.saveResponseTemplate !== 'function') {
      throw new Error('El guardado de plantillas no está disponible.');
    }
    return this.db.saveResponseTemplate({ id, title: normalizedTitle, body: normalizedBody });
  }

  async deleteResponseTemplate(templateId) {
    const user = await this.auth.getCurrentUser();
    if (!this.auth.canManageUsers(user)) throw new Error('Solo Admin puede administrar plantillas.');
    if (typeof this.db.deleteResponseTemplate !== 'function') {
      throw new Error('La eliminación de plantillas no está disponible.');
    }
    return this.db.deleteResponseTemplate(templateId);
  }

  async getSatisfaction(ticketId) {
    if (typeof this.db.getSatisfaction !== 'function') {
      throw new Error('La consulta de satisfacción no está disponible.');
    }
    return this.db.getSatisfaction(ticketId);
  }

  async submitSatisfaction(ticketId, rating, comment = '') {
    const user = await this.auth.getCurrentUser();
    const ticket = await this.db.getById('tickets', ticketId);
    if (!ticket || ticket.status !== 'closed' || ticket.createdBy !== user?.id) {
      throw new Error('Solo quien creó un ticket cerrado puede responder la encuesta.');
    }
    if (!Number.isInteger(Number(rating)) || Number(rating) < 1 || Number(rating) > 5) {
      throw new Error('La calificación debe estar entre 1 y 5 estrellas.');
    }
    const normalizedComment = String(comment ?? '').trim();
    if (normalizedComment.length > 1000) throw new Error('El comentario puede tener hasta 1000 caracteres.');
    if (typeof this.db.submitSatisfaction !== 'function') {
      throw new Error('El envío de la encuesta no está disponible.');
    }
    return this.db.submitSatisfaction(ticketId, Number(rating), normalizedComment);
  }

  async validateTicketFields({ title, description, priority, category = 'Consulta', initialStatus, assignedTo, dueDate, checklist = [], workspaceId }) {
    const normalizedTitle = String(title ?? '').trim();
    const normalizedDescription = String(description ?? '').trim();
    if (normalizedTitle.length < 4) throw new Error('El título debe tener al menos 4 caracteres.');
    if (!normalizedDescription) throw new Error('La descripción es obligatoria.');
    if (!PRIORITY_ORDER.includes(priority)) throw new Error('La prioridad no es válida.');
    if (!TICKET_CATEGORIES.includes(category)) throw new Error('La categoría no es válida.');
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
      if (assignee.workspaceId !== workspaceId) {
        throw new Error('El responsable debe pertenecer a tu espacio de trabajo.');
      }
    }

    return {
      title: normalizedTitle,
      description: normalizedDescription,
      priority,
      category,
      initialStatus,
      assignedTo: assignedTo || null,
      dueDate: normalizedDueDate,
      checklist: normalizeChecklist(checklist)
    };
  }

  evaluateSLA(ticket, now = Date.now()) {
    return getSlaState(ticket, now);
  }
}
