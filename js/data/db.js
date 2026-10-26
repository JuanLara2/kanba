const PROFILE_FIELDS = 'id,full_name,email,role,workspace_id,created_by_admin_id';
const TICKET_FIELDS = 'id,title,description,status,priority,assigned_to,created_by,workspace_id,created_at,updated_at,due_date,checklist';
const HISTORY_FIELDS = 'id,ticket_id,from_status,to_status,changed_at,changed_by';

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
    assignedTo: row.assigned_to,
    createdBy: row.created_by,
    workspaceId: row.workspace_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    dueDate: row.due_date,
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
    assigned_to: ticket.assignedTo,
    due_date: ticket.dueDate,
    checklist: ticket.checklist || []
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
}
