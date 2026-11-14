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

  async askBoardQuestion(question, tickets) {
    const normalizedQuestion = typeof question === 'string' ? question.trim() : '';
    if (!normalizedQuestion || normalizedQuestion.length > 300) {
      throw new Error('Escribe una pregunta de hasta 300 caracteres.');
    }
    if (!Array.isArray(tickets) || tickets.length > 100) {
      throw new Error('La consulta admite hasta 100 tickets visibles. Aplica filtros para reducir la cantidad.');
    }
    const boardTickets = tickets.filter((ticket) => ticket && !ticket.isArchived).map((ticket) => ({
      id: String(ticket.id || '').trim().slice(0, 40),
      title: String(ticket.title || '').trim().slice(0, 200),
      description: String(ticket.description || '').trim().slice(0, 1000),
      status: String(ticket.status || '').slice(0, 40),
      priority: String(ticket.priority || '').slice(0, 40),
      category: String(ticket.category || '').slice(0, 100),
      dueDate: String(ticket.dueDate || '').slice(0, 40)
    })).filter((ticket) => ticket.id && ticket.title);
    if (!boardTickets.length) throw new Error('No hay tickets visibles para consultar.');

    const data = await this.invoke('board_question', {
      question: normalizedQuestion,
      today: this.getBogotaDate(),
      tickets: boardTickets
    });
    if (typeof data.answer !== 'string' || !Array.isArray(data.ticketIds)) {
      throw new Error('La respuesta de IA no contiene una consulta válida.');
    }
    const allowed = new Map(boardTickets.map((ticket) => [ticket.id, ticket]));
    const seen = new Set();
    const relatedTickets = data.ticketIds.map((id) => {
      if (typeof id !== 'string' || !allowed.has(id) || seen.has(id)) {
        throw new Error('La respuesta de IA contiene una referencia de ticket no válida.');
      }
      seen.add(id);
      const ticket = allowed.get(id);
      return { id: ticket.id, title: ticket.title, status: ticket.status };
    }).slice(0, 10);
    return {
      answer: this.requireText(data.answer, 'La respuesta').slice(0, 1500),
      tickets: relatedTickets
    };
  }

  async findSimilarTickets(ticket, existingTickets) {
    const candidateIds = new Set();
    const candidates = (Array.isArray(existingTickets) ? existingTickets : [])
      .filter((candidate) => (
        candidate
        && typeof candidate.id === 'string'
        && candidate.id.trim()
        && candidate.id !== ticket.id
        && !candidate.isArchived
        && typeof candidate.title === 'string'
        && candidate.title.trim()
      ))
      .filter((candidate) => {
        if (candidateIds.has(candidate.id)) return false;
        candidateIds.add(candidate.id);
        return true;
      })
      .map((candidate, index) => ({
        candidate,
        index,
        createdAt: Date.parse(candidate.createdAt || '') || 0
      }))
      .sort((left, right) => right.createdAt - left.createdAt || left.index - right.index);
    const selected = candidates.slice(0, 100).map(({ candidate }) => ({
      id: String(candidate.id).slice(0, 40),
      title: candidate.title.trim().slice(0, 200),
      description: String(candidate.description || '').trim().slice(0, 1000),
      status: String(candidate.status || '').slice(0, 40)
    }));
    if (!selected.length) throw new Error('No hay otros tickets disponibles para comparar.');

    const data = await this.invoke('duplicate_detection', {
      ticketId: String(ticket.id || '').slice(0, 40),
      ...this.ticketFields(ticket),
      candidates: selected
    });
    if (!Array.isArray(data.matches) || data.checkedCount !== selected.length) {
      throw new Error('La respuesta de IA no contiene una búsqueda de tickets válida.');
    }

    const allowed = new Map(selected.map((candidate) => [candidate.id, candidate]));
    const seen = new Set();
    const matches = data.matches.map((match) => {
      if (
        !match
        || typeof match !== 'object'
        || typeof match.id !== 'string'
        || !allowed.has(match.id)
        || !['high', 'medium'].includes(match.similarity)
        || typeof match.reason !== 'string'
        || !match.reason.trim()
        || seen.has(match.id)
      ) {
        throw new Error('La respuesta de IA contiene una coincidencia no válida.');
      }
      seen.add(match.id);
      const candidate = allowed.get(match.id);
      return {
        id: candidate.id,
        title: candidate.title,
        status: candidate.status,
        similarity: match.similarity,
        reason: match.reason.trim().slice(0, 300)
      };
    }).slice(0, 5);
    return {
      matches,
      checkedCount: selected.length,
      totalCount: candidates.length
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
