export class AiTicketAssistantUI {
  constructor({ modalEl, aiService, getTicket, getComments, getCategories, getBoardTickets, canEditTicket, canCommentTicket, onError, onNotice }) {
    this.modalEl = modalEl;
    this.aiService = aiService;
    this.getTicket = getTicket;
    this.getComments = getComments;
    this.getCategories = getCategories;
    this.getBoardTickets = getBoardTickets;
    this.canEditTicket = canEditTicket;
    this.canCommentTicket = canCommentTicket;
    this.onError = onError;
    this.onNotice = onNotice;
    this.ticketOutput = document.getElementById('aiTicketAssistantOutput');
    this.boardOutput = document.getElementById('aiBoardSummaryOutput');
    this.requestId = 0;
    this.boardRequestId = 0;
    this.bindEvents();
  }

  bindEvents() {
    this.ticketOutput.addEventListener('click', (event) => {
      const action = event.target.closest('[data-ai-ticket-action]')?.dataset.aiTicketAction;
      if (action === 'dismiss') this.clearTicketOutput();
      if (action === 'copy-summary') void this.copySummary();
      if (action === 'use-response') this.useResponseDraft();
      if (action === 'apply-recommendations') this.applyRecommendations();
    });

    document.getElementById('btnAiTicketSummary').addEventListener('click', () => void this.runTicketAction('summary'));
    document.getElementById('btnAiTicketRecommendations').addEventListener('click', () => void this.runTicketAction('recommendations'));
    document.getElementById('btnAiTicketRisk').addEventListener('click', () => void this.runTicketAction('risk'));
    document.getElementById('btnAiResponseDraft').addEventListener('click', () => void this.runTicketAction('response'));
    document.getElementById('btnAiBoardSummary').addEventListener('click', () => void this.runBoardSummary());
  }

  async runTicketAction(action) {
    const ticket = this.getTicket();
    if (!ticket.title || !ticket.description) {
      this.onError(new Error('Completa el título y la descripción antes de usar la IA.'));
      return;
    }
    if (['recommendations', 'risk', 'summary'].includes(action) && !this.canEditTicket()) {
      this.onError(new Error('No tienes permiso para analizar este ticket.'));
      return;
    }
    if (action === 'response' && !this.canCommentTicket()) {
      this.onError(new Error('No tienes permiso para redactar comentarios en este ticket.'));
      return;
    }

    const requestId = ++this.requestId;
    const buttons = [...this.modalEl.querySelectorAll('#btnAiTicketSummary, #btnAiTicketRecommendations, #btnAiTicketRisk, #btnAiResponseDraft')];
    buttons.forEach((button) => { button.disabled = true; });
    this.clearTicketOutput(false);
    this.setTicketStatus('Generando sugerencia…');
    try {
      let result;
      if (action === 'summary') result = { summary: await this.aiService.summarizeTicket(ticket) };
      if (action === 'response') {
        const comments = await this.getComments();
        result = { draft: await this.aiService.draftResponse(ticket, comments) };
      }
      if (action === 'recommendations') {
        result = await this.aiService.recommendTicketFields(ticket, this.getCategories());
      }
      if (action === 'risk') result = await this.aiService.assessTicketRisk(ticket);
      if (requestId !== this.requestId || this.modalEl.classList.contains('hidden')) return;
      if (JSON.stringify(this.getTicket()) !== JSON.stringify(ticket)) {
        this.setTicketStatus('El ticket cambió durante la solicitud. Genera de nuevo la sugerencia.');
        return;
      }
      this.renderTicketResult(action, result);
    } catch (error) {
      if (requestId !== this.requestId) return;
      this.setTicketStatus(error.message || 'No se pudo completar la solicitud de IA.');
      this.onError(error);
    } finally {
      if (requestId === this.requestId) buttons.forEach((button) => { button.disabled = false; });
    }
  }

  async runBoardSummary() {
    const button = document.getElementById('btnAiBoardSummary');
    const requestId = ++this.boardRequestId;
    button.disabled = true;
    this.boardOutput.replaceChildren();
    this.setBoardStatus('Analizando tickets activos…');
    try {
      const tickets = this.getBoardTickets();
      if (!tickets.length) {
        this.setBoardStatus('No hay tickets activos para resumir.');
        return;
      }
      if (tickets.length > 100) {
        this.setBoardStatus('El resumen admite hasta 100 tickets activos. Aplica filtros para reducir la cantidad.');
        return;
      }
      const report = await this.aiService.summarizeBoard(tickets);
      if (requestId !== this.boardRequestId) return;
      this.renderBoardReport(report);
    } catch (error) {
      if (requestId !== this.boardRequestId) return;
      this.setBoardStatus(error.message || 'No se pudo generar el resumen del tablero.');
      this.onError(error);
    } finally {
      if (requestId === this.boardRequestId) button.disabled = false;
    }
  }

  renderTicketResult(action, result) {
    const fragment = document.createDocumentFragment();
    if (action === 'summary') {
      this.appendHeading(fragment, 'Resumen sugerido');
      const text = document.createElement('textarea');
      text.className = 'ai-assistant-editable';
      text.maxLength = 700;
      text.value = result.summary;
      text.dataset.aiSummaryText = '';
      text.setAttribute('aria-label', 'Resumen sugerido editable');
      fragment.appendChild(text);
      fragment.append(
        this.createAction('Copiar resumen', 'copy-summary'),
        this.createAction('Cerrar', 'dismiss', 'btn btn-outline')
      );
    } else if (action === 'response') {
      this.appendHeading(fragment, 'Borrador de respuesta');
      const text = document.createElement('textarea');
      text.className = 'ai-assistant-editable';
      text.maxLength = 4000;
      text.value = result.draft;
      text.dataset.aiResponseText = '';
      text.setAttribute('aria-label', 'Borrador de respuesta editable');
      fragment.appendChild(text);
      const note = document.createElement('p');
      note.className = 'ai-assistant-note';
      note.textContent = 'Revisa el texto. Se copiará al comentario para que lo edites; no se publicará automáticamente.';
      fragment.append(note, this.createAction('Usar borrador', 'use-response'), this.createAction('Descartar', 'dismiss', 'btn btn-outline'));
    } else if (action === 'recommendations') {
      this.appendHeading(fragment, 'Recomendaciones para revisar');
      this.appendText(fragment, `Categoría: ${result.category}`);
      this.appendText(fragment, `Prioridad: ${result.priority}`);
      this.appendText(fragment, result.rationale);
      fragment.append(
        this.createAction('Aplicar al formulario', 'apply-recommendations'),
        this.createAction('Descartar', 'dismiss', 'btn btn-outline')
      );
      this.pendingRecommendations = result;
    } else {
      this.appendHeading(fragment, 'Riesgo y posibles bloqueos');
      const levelNames = { low: 'Bajo', medium: 'Medio', high: 'Alto' };
      const level = document.createElement('strong');
      level.className = `ai-risk-level ai-risk-level--${result.level}`;
      level.textContent = `Riesgo ${levelNames[result.level]}`;
      fragment.appendChild(level);
      this.appendList(fragment, 'Señales detectadas', result.reasons);
      this.appendList(fragment, 'Acciones para revisar', result.actions);
      fragment.appendChild(this.createAction('Cerrar', 'dismiss', 'btn btn-outline'));
    }
    this.ticketOutput.replaceChildren(fragment);
    this.ticketOutput.classList.remove('hidden');
  }

  renderBoardReport(report) {
    const fragment = document.createDocumentFragment();
    this.appendHeading(fragment, 'Resumen del tablero');
    this.appendText(fragment, report.summary);
    this.appendList(fragment, 'Bloqueados', report.blocked);
    this.appendList(fragment, 'Vencidos', report.overdue);
    this.appendList(fragment, 'Otros puntos a revisar', report.highlights);
    this.boardOutput.replaceChildren(fragment);
    this.boardOutput.classList.remove('hidden');
  }

  appendHeading(parent, text) {
    const heading = document.createElement('h5');
    heading.textContent = text;
    parent.appendChild(heading);
  }

  appendText(parent, text) {
    if (!text) return;
    const paragraph = document.createElement('p');
    paragraph.textContent = text;
    parent.appendChild(paragraph);
  }

  appendList(parent, title, values) {
    if (!values.length) return;
    this.appendHeading(parent, title);
    const list = document.createElement('ul');
    values.forEach((value) => {
      const item = document.createElement('li');
      item.textContent = value;
      list.appendChild(item);
    });
    parent.appendChild(list);
  }

  createAction(label, action, className = 'btn btn-primary') {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = className;
    button.dataset.aiTicketAction = action;
    button.textContent = label;
    return button;
  }

  setTicketStatus(message) {
    const fragment = document.createDocumentFragment();
    const status = document.createElement('p');
    status.className = 'ai-assistant-note';
    status.setAttribute('role', 'status');
    status.setAttribute('aria-live', 'polite');
    status.textContent = message;
    fragment.appendChild(status);
    this.ticketOutput.replaceChildren(fragment);
    this.ticketOutput.classList.remove('hidden');
  }

  setBoardStatus(message) {
    const status = document.createElement('p');
    status.className = 'ai-assistant-note';
    status.setAttribute('role', 'status');
    status.setAttribute('aria-live', 'polite');
    status.textContent = message;
    this.boardOutput.replaceChildren(status);
    this.boardOutput.classList.remove('hidden');
  }

  async copySummary() {
    const summary = this.ticketOutput.querySelector('[data-ai-summary-text]')?.value.trim();
    if (!summary) return;
    try {
      await navigator.clipboard.writeText(summary);
      this.onNotice('Resumen copiado al portapapeles.');
    } catch (error) {
      this.onError(new Error(error.message || 'No se pudo copiar el resumen.'));
    }
  }

  useResponseDraft() {
    const draft = this.ticketOutput.querySelector('[data-ai-response-text]')?.value.trim();
    const input = document.getElementById('ticketCommentInput');
    if (!draft || input.disabled) return;
    input.value = draft;
    input.focus();
    this.clearTicketOutput();
  }

  applyRecommendations() {
    if (!this.pendingRecommendations || !this.canEditTicket()) return;
    document.getElementById('formCategory').value = this.pendingRecommendations.category;
    document.getElementById('formPriority').value = this.pendingRecommendations.priority;
    this.pendingRecommendations = null;
    this.clearTicketOutput();
  }

  clearTicketOutput(invalidate = true) {
    if (invalidate) this.requestId += 1;
    this.pendingRecommendations = null;
    this.ticketOutput.replaceChildren();
    this.ticketOutput.classList.add('hidden');
  }

  reset() {
    this.clearTicketOutput();
    this.modalEl.querySelectorAll('#btnAiTicketSummary, #btnAiTicketRecommendations, #btnAiTicketRisk, #btnAiResponseDraft')
      .forEach((button) => { button.disabled = false; });
    this.clearBoardSummary();
  }

  clearBoardSummary() {
    this.boardRequestId += 1;
    document.getElementById('btnAiBoardSummary').disabled = false;
    this.boardOutput.replaceChildren();
    this.boardOutput.classList.add('hidden');
  }
}
