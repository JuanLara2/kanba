export class AIService {
  constructor(supabase) {
    this.supabase = supabase;
  }

  async suggestSubtasks(title, description) {
    const data = await this.invoke('subtasks', { title, description });
    if (!Array.isArray(data.subtasks)) {
      throw new Error('La respuesta de IA no contiene una lista de subtareas válida.');
    }
    return data.subtasks
      .filter((item) => typeof item === 'string')
      .map((item) => item.trim().slice(0, 200))
      .filter(Boolean)
      .slice(0, 10);
  }

  async summarizeTicket(ticket) {
    const data = await this.invoke('ticket_summary', this.ticketFields(ticket));
    return this.requireText(data.summary, 'El resumen');
  }

  async draftResponse(ticket, comments = []) {
    const data = await this.invoke('response_draft', {
      ...this.ticketFields(ticket),
      comments: (Array.isArray(comments) ? comments : []).slice(-10).map((comment) => String(comment).slice(0, 1000))
    });
    return this.requireText(data.draft, 'El borrador de respuesta');
  }

  async recommendTicketFields(ticket, categories) {
    if (!Array.isArray(categories) || categories.length === 0) {
      throw new Error('No hay categorías disponibles para recomendar.');
    }
    const data = await this.invoke('ticket_recommendations', {
      ...this.ticketFields(ticket),
      categories: categories.slice(0, 50)
    });
    if (
      typeof data.category !== 'string'
      || !categories.includes(data.category)
      || !['Baja', 'Media', 'Alta', 'Urgente'].includes(data.priority)
      || typeof data.rationale !== 'string'
    ) {
      throw new Error('La respuesta de IA no contiene recomendaciones válidas.');
    }
    return {
      category: data.category,
      priority: data.priority,
      rationale: data.rationale.trim().slice(0, 500)
    };
  }

  async assessTicketRisk(ticket) {
    const data = await this.invoke('ticket_risk', {
      ...this.ticketFields(ticket),
      status: ticket.status || 'new',
      priority: ticket.priority || 'Media',
      dueDate: ticket.dueDate || '',
      checklist: (ticket.checklist || []).slice(0, 100)
    });
    if (!['low', 'medium', 'high'].includes(data.level)) {
      throw new Error('La respuesta de IA no contiene una evaluación de riesgo válida.');
    }
    return {
      level: data.level,
      reasons: this.cleanStringArray(data.reasons, 6, 300),
      actions: this.cleanStringArray(data.actions, 6, 300)
    };
  }

  async summarizeBoard(tickets) {
    if (tickets.length > 100) {
      throw new Error('El resumen admite hasta 100 tickets activos. Aplica filtros para reducir la cantidad.');
    }
    const data = await this.invoke('board_summary', {
      tickets: tickets.map((ticket) => {
        const checklist = Array.isArray(ticket.checklist) ? ticket.checklist : [];
        return {
          id: ticket.id,
          title: ticket.title,
          status: ticket.status,
          priority: ticket.priority,
          dueDate: ticket.dueDate,
          checklistTotal: checklist.length,
          checklistCompleted: checklist.filter((item) => item.completed || item.done).length
        };
      }),
      today: this.getBogotaDate()
    });
    return {
      summary: this.requireText(data.summary, 'El resumen del tablero'),
      blocked: this.cleanStringArray(data.blocked, 20, 300),
      overdue: this.cleanStringArray(data.overdue, 20, 300),
      highlights: this.cleanStringArray(data.highlights, 10, 300)
    };
  }

  ticketFields(ticket) {
    return {
      title: String(ticket.title || '').trim().slice(0, 200),
      description: String(ticket.description || '').trim().slice(0, 4000)
    };
  }

  async invoke(action, fields) {
    const { data, error } = await this.supabase.functions.invoke('generate-subtasks', {
      body: { action, ...fields }
    });
    if (error) throw error;
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
      throw new Error('La respuesta de IA no tiene un formato válido.');
    }
    if (typeof data.error === 'string') throw new Error(data.error);
    return data;
  }

  requireText(value, label) {
    if (typeof value !== 'string' || !value.trim()) {
      throw new Error(`La respuesta de IA no contiene ${label.toLowerCase()} válido.`);
    }
    return value.trim();
  }

  cleanStringArray(value, itemLimit, charLimit) {
    if (!Array.isArray(value)) return [];
    return value
      .filter((item) => typeof item === 'string')
      .map((item) => item.trim().slice(0, charLimit))
      .filter(Boolean)
      .slice(0, itemLimit);
  }

  getBogotaDate() {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'America/Bogota',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit'
    }).formatToParts(new Date());
    const values = Object.fromEntries(parts.map(({ type, value }) => [type, value]));
    return `${values.year}-${values.month}-${values.day}`;
  }
}
