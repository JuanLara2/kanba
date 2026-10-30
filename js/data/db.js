const PROFILE_FIELDS = 'id,full_name,email,role,workspace_id,created_by_admin_id';
const TICKET_FIELDS = 'id,title,description,status,priority,category,assigned_to,created_by,workspace_id,created_at,updated_at,due_date,sla_due_at,sla_warning_at,checklist';
const HISTORY_FIELDS = 'id,ticket_id,from_status,to_status,changed_at,changed_by';
const COMMENT_FIELDS = 'id,ticket_id,author_id,body,created_at';
const NOTIFICATION_FIELDS = 'id,user_id,ticket_id,kind,message,created_at,read_at';

function mapProfile(row) {
  return {
    id: row.id,
    fullName: row.full_name,
    email: row.email,
    role: row.role,
    workspaceId: row.workspace_id,
    createdByAdminId: row.created_by_admin_id
  };
}

function mapTicket(row, history = []) {
  return {
    id: row.id,
    title: row.title,
    description: row.description,
    status: row.status,
    priority: row.priority,
    category: row.category,
    assignedTo: row.assigned_to,
    createdBy: row.created_by,
    workspaceId: row.workspace_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    dueDate: row.due_date,
    slaDueAt: row.sla_due_at,
    slaWarningAt: row.sla_warning_at,
    checklist: row.checklist || [],
    statusHistory: history
      .filter((record) => record.ticket_id === row.id)
      .map((record) => ({
        from: record.from_status,
        to: record.to_status,
        changedAt: record.changed_at,
        changedBy: record.changed_by
      }))
  };
}

function toTicketRow(ticket) {
  return {
    title: ticket.title,
    description: ticket.description,
    status: ticket.status,
    priority: ticket.priority,
    category: ticket.category,
    assigned_to: ticket.assignedTo,
    due_date: ticket.dueDate,
    checklist: ticket.checklist || []
  };
}

function mapComment(row) {
  return {
    id: row.id,
    ticketId: row.ticket_id,
    authorId: row.author_id,
    body: row.body,
    createdAt: row.created_at
  };
}

function mapNotification(row) {
  return {
    id: row.id,
    userId: row.user_id,
    ticketId: row.ticket_id,
    kind: row.kind,
    message: row.message,
    createdAt: row.created_at,
    readAt: row.read_at
  };
}

export class SupabaseAdapter {
  constructor(client, getAccessToken) {
    this.client = client;
    this.getToken = getAccessToken;
  }

  async accessToken() {
    const token = await this.getToken();
    if (!token) throw new Error('Inicia sesión para consultar los datos.');
    return token;
  }

  async getAll(storeName) {
    const accessToken = await this.accessToken();
    if (storeName === 'users') {
      const rows = await this.client.requestRest(`profiles?select=${PROFILE_FIELDS}&order=full_name.asc`, { accessToken });
      return rows.map(mapProfile);
    }

    if (storeName === 'tickets') {
      const rows = await this.client.requestRest(`tickets?select=${TICKET_FIELDS}&order=created_at.desc`, { accessToken });
      if (rows.length === 0) return [];
      const ids = rows.map((ticket) => `"${ticket.id}"`).join(',');
      const history = await this.client.requestRest(
        `ticket_status_history?select=${HISTORY_FIELDS}&ticket_id=in.(${ids})&order=changed_at.asc`,
        { accessToken }
      );
      return rows.map((ticket) => mapTicket(ticket, history));
    }

    throw new Error(`Almacén de datos no reconocido: ${storeName}`);
  }

  async getById(storeName, id, providedAccessToken) {
    const accessToken = providedAccessToken || await this.accessToken();
    const encodedId = encodeURIComponent(id);
    if (storeName === 'users') {
      const rows = await this.client.requestRest(`profiles?select=${PROFILE_FIELDS}&id=eq.${encodedId}`, { accessToken });
      return rows.length ? mapProfile(rows[0]) : null;
    }

    if (storeName === 'tickets') {
      const rows = await this.client.requestRest(`tickets?select=${TICKET_FIELDS}&id=eq.${encodedId}`, { accessToken });
      if (rows.length === 0) return null;
      const history = await this.client.requestRest(
        `ticket_status_history?select=${HISTORY_FIELDS}&ticket_id=eq.${encodedId}&order=changed_at.asc`,
        { accessToken }
      );
      return mapTicket(rows[0], history);
    }

    throw new Error(`Almacén de datos no reconocido: ${storeName}`);
  }

  async createTicket(ticket) {
    const accessToken = await this.accessToken();
    const rows = await this.client.requestRest('tickets', {
      method: 'POST',
      accessToken,
      prefer: 'return=representation',
      body: toTicketRow(ticket)
    });
    if (!rows?.[0]) throw new Error('Supabase no devolvió el ticket creado.');
    return mapTicket(rows[0]);
  }

  async put(storeName, value) {
    if (storeName !== 'tickets') {
      throw new Error('Los perfiles solo se crean mediante la función de administración segura.');
    }

    const accessToken = await this.accessToken();
    const rows = await this.client.requestRest(`tickets?id=eq.${encodeURIComponent(value.id)}`, {
      method: 'PATCH',
      accessToken,
      prefer: 'return=representation',
      body: toTicketRow(value)
    });
    if (!rows?.[0]) throw new Error('No se pudo actualizar el ticket o ya no existe.');
    return mapTicket(rows[0]);
  }

  async delete(storeName, id) {
    if (storeName !== 'tickets') {
      throw new Error('La eliminación de usuarios no está disponible desde el cliente.');
    }
    const accessToken = await this.accessToken();
    await this.client.requestRest(`tickets?id=eq.${encodeURIComponent(id)}`, {
      method: 'DELETE',
      accessToken
    });
    return true;
  }

  async createUser(user) {
    const accessToken = await this.accessToken();
    return this.client.request('functions/v1', 'admin-create-user', {
      method: 'POST',
      accessToken,
      body: user
    });
  }

  async getComments(ticketId) {
    const accessToken = await this.accessToken();
    const rows = await this.client.requestRest(
      `ticket_comments?select=${COMMENT_FIELDS}&ticket_id=eq.${encodeURIComponent(ticketId)}&order=created_at.asc`,
      { accessToken }
    );
    return rows.map(mapComment);
  }

  async createComment(ticketId, body) {
    const accessToken = await this.accessToken();
    const rows = await this.client.requestRest('ticket_comments', {
      method: 'POST',
      accessToken,
      prefer: 'return=representation',
      body: { ticket_id: ticketId, body }
    });
    if (!rows?.[0]) throw new Error('Supabase no devolvió el comentario creado.');
    return mapComment(rows[0]);
  }

  async getNotifications(userId) {
    const accessToken = await this.accessToken();
    const rows = await this.client.requestRest(
      `notifications?select=${NOTIFICATION_FIELDS}&user_id=eq.${encodeURIComponent(userId)}&order=created_at.desc&limit=50`,
      { accessToken }
    );
    return rows.map(mapNotification);
  }

  async markNotificationRead(notificationId) {
    const accessToken = await this.accessToken();
    const rows = await this.client.requestRest(`notifications?id=eq.${encodeURIComponent(notificationId)}`, {
      method: 'PATCH',
      accessToken,
      prefer: 'return=representation',
      body: { read_at: new Date().toISOString() }
    });
    if (!rows?.[0]) throw new Error('No se pudo actualizar la notificación.');
    return mapNotification(rows[0]);
  }

  async getResponseTemplates() {
    const accessToken = await this.accessToken();
    const rows = await this.client.requestRest(
      'response_templates?select=id,title,body,created_at,updated_at&order=title.asc',
      { accessToken }
    );
    return rows.map((row) => ({
      id: row.id,
      title: row.title,
      body: row.body,
      createdAt: row.created_at,
      updatedAt: row.updated_at
    }));
  }

  async saveResponseTemplate(template) {
    const accessToken = await this.accessToken();
    const path = template.id
      ? `response_templates?id=eq.${encodeURIComponent(template.id)}`
      : 'response_templates';
    const rows = await this.client.requestRest(path, {
      method: template.id ? 'PATCH' : 'POST',
      accessToken,
      prefer: 'return=representation',
      body: { title: template.title, body: template.body }
    });
    if (!rows?.[0]) throw new Error('No se pudo guardar la plantilla.');
    return {
      id: rows[0].id,
      title: rows[0].title,
      body: rows[0].body,
      createdAt: rows[0].created_at,
      updatedAt: rows[0].updated_at
    };
  }

  async deleteResponseTemplate(templateId) {
    const accessToken = await this.accessToken();
    await this.client.requestRest(`response_templates?id=eq.${encodeURIComponent(templateId)}`, {
      method: 'DELETE',
      accessToken
    });
  }

  async submitSatisfaction(ticketId, rating, comment) {
    const accessToken = await this.accessToken();
    const rows = await this.client.requestRest('ticket_satisfaction', {
      method: 'POST',
      accessToken,
      prefer: 'return=representation',
      body: { ticket_id: ticketId, rating, comment: comment || null }
    });
    if (!rows?.[0]) throw new Error('No se pudo guardar la encuesta.');
    return {
      ticketId: rows[0].ticket_id,
      rating: rows[0].rating,
      comment: rows[0].comment,
      submittedBy: rows[0].submitted_by,
      createdAt: rows[0].created_at
    };
  }

  async getSatisfaction(ticketId) {
    const accessToken = await this.accessToken();
    const rows = await this.client.requestRest(
      `ticket_satisfaction?select=ticket_id,rating,comment,submitted_by,created_at&ticket_id=eq.${encodeURIComponent(ticketId)}`,
      { accessToken }
    );
    if (!rows.length) return null;
    return {
      ticketId: rows[0].ticket_id,
      rating: rows[0].rating,
      comment: rows[0].comment,
      submittedBy: rows[0].submitted_by,
      createdAt: rows[0].created_at
    };
  }

  async getAllSatisfaction() {
    const accessToken = await this.accessToken();
    const rows = await this.client.requestRest(
      'ticket_satisfaction?select=ticket_id,rating,comment,submitted_by,created_at&order=created_at.desc',
      { accessToken }
    );
    return rows.map((row) => ({
      ticketId: row.ticket_id,
      rating: row.rating,
      comment: row.comment,
      submittedBy: row.submitted_by,
      createdAt: row.created_at
    }));
  }
}
