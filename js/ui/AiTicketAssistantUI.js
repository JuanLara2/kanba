export class AiTicketAssistantUI {
  constructor({ modalEl, aiService, getTicket, getComments, getCategories, getBoardTickets, getVisibleBoardTickets, onOpenTicket, canEditTicket, canCommentTicket, onError, onNotice }) {
    this.modalEl = modalEl;
    this.aiService = aiService;
    this.getTicket = getTicket;
    this.getComments = getComments;
    this.getCategories = getCategories;
    this.getBoardTickets = getBoardTickets;
    this.getVisibleBoardTickets = getVisibleBoardTickets;
    this.onOpenTicket = onOpenTicket;
    this.canEditTicket = canEditTicket;
    this.canCommentTicket = canCommentTicket;
    this.onError = onError;
    this.onNotice = onNotice;
    this.ticketOutput = document.getElementById('aiTicketAssistantOutput');
    this.boardOutput = document.getElementById('aiBoardSummaryOutput');
    this.boardQuestionInput = document.getElementById('aiBoardQuestion');
    this.boardQuestionClearButton = document.getElementById('btnAiBoardQuestionClear');
    this.boardQuestionButton = document.getElementById('btnAiBoardQuestion');
    this.boardSummaryButton = document.getElementById('btnAiBoardSummary');
    this.boardQuestionSuggestions = document.getElementById('aiBoardQuestionSuggestions');
    this.requestId = 0;
    this.boardRequestId = 0;
    this.boardActionButtons = [this.boardSummaryButton, this.boardQuestionButton];
    this.boardActionButtonMarkup = new Map(
      this.boardActionButtons.map((button) => [button.id, button.innerHTML])
    );
    this.boardActionButtonLabels = new Map(
      this.boardActionButtons.map((button) => [button.id, button.getAttribute('aria-label')])
    );
    this.ticketActionButtons = [...this.modalEl.querySelectorAll(
      '#btnAiTicketSummary, #btnAiTicketRecommendations, #btnAiTicketRisk, #btnAiFindDuplicates, #btnAiResponseDraft'
    )];
    this.ticketActionButtonMarkup = new Map(
      this.ticketActionButtons.map((button) => [button.id, button.innerHTML])
    );
    this.validationField = null;
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
    this.boardOutput.addEventListener('click', (event) => this.handleBoardOutputClick(event));

    document.getElementById('btnAiTicketSummary').addEventListener('click', (event) => void this.runTicketAction('summary', event.currentTarget));
    document.getElementById('btnAiTicketRecommendations').addEventListener('click', (event) => void this.runTicketAction('recommendations', event.currentTarget));
    document.getElementById('btnAiTicketRisk').addEventListener('click', (event) => void this.runTicketAction('risk', event.currentTarget));
    document.getElementById('btnAiFindDuplicates').addEventListener('click', (event) => void this.runTicketAction('duplicates', event.currentTarget));
    document.getElementById('btnAiResponseDraft').addEventListener('click', (event) => void this.runTicketAction('response', event.currentTarget));
    document.getElementById('formTitle').addEventListener('input', () => this.clearResolvedAIValidation());
    document.getElementById('formDescription').addEventListener('input', () => this.clearResolvedAIValidation());
    this.boardSummaryButton.addEventListener('click', () => void this.runBoardSummary());
    document.getElementById('aiBoardQuestionForm').addEventListener('submit', (event) => {
      event.preventDefault();
      void this.runBoardQuestion();
    });
    this.boardQuestionClearButton.addEventListener('click', () => {
      this.boardQuestionInput.value = '';
      this.boardQuestionInput.focus();
    });
    this.boardQuestionSuggestions.addEventListener('click', (event) => {
      const prompt = event.target.closest('[data-ai-board-prompt]')?.dataset.aiBoardPrompt;
      if (!prompt) return;
      this.boardQuestionInput.value = prompt;
      void this.runBoardQuestion();
    });
  }

  async runTicketAction(action, button) {
    const ticket = this.getTicket();
    if (['recommendations', 'risk', 'summary'].includes(action) && !this.canEditTicket()) {
      this.onError(new Error('No tienes permiso para analizar este ticket.'));
      return;
    }
    if (action === 'duplicates' && ticket.id && !this.canEditTicket()) {
      this.onError(new Error('No tienes permiso para analizar este ticket.'));
      return;
    }
    if (action === 'response' && !this.canCommentTicket()) {
      this.onError(new Error('No tienes permiso para redactar comentarios en este ticket.'));
      return;
    }

    const requestId = ++this.requestId;
    const loadingLabels = {
      summary: 'Resumiendo…',
      response: 'Redactando…',
      recommendations: 'Analizando…',
      risk: 'Analizando…',
      duplicates: 'Buscando…'
    };
    await this.ejecutarAccionIA(button, async () => {
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
      if (action === 'duplicates') result = await this.aiService.findSimilarTickets(ticket, this.getBoardTickets());
      if (requestId !== this.requestId || this.modalEl.classList.contains('hidden')) return false;
      if (JSON.stringify(this.getTicket()) !== JSON.stringify(ticket)) {
        this.setTicketStatus('El ticket cambió durante la solicitud. Genera de nuevo la sugerencia.');
        return false;
      }
      this.renderTicketResult(action, result);
      return true;
    }, loadingLabels[action] || 'Procesando…', requestId);
  }

  async ejecutarAccionIA(button, callbackAsync, loadingLabel, requestId) {
    if (!this.validateTicketAIInput()) return false;

    const originalMarkup = this.ticketActionButtonMarkup.get(button.id) || button.innerHTML;
    this.ticketActionButtons.forEach((actionButton) => {
      actionButton.disabled = true;
      actionButton.classList.remove('is-loading', 'is-success', 'is-error');
    });
    button.classList.add('is-loading');
    button.setAttribute('aria-busy', 'true');
    button.setAttribute('aria-label', 'Analizando tablero...');
    button.innerHTML = `<span class="ai-action-spinner" aria-hidden="true"></span><span>${loadingLabel}</span>`;
    this.clearTicketOutput(false);
    this.setTicketStatus('Procesando con IA…');

    try {
      const completed = await callbackAsync();
      if (requestId !== this.requestId || completed === false) return false;
      button.classList.remove('is-loading');
      button.classList.add('is-success');
      button.innerHTML = '<span aria-hidden="true">✓</span><span>Listo</span>';
      await this.wait(2000);
      return true;
    } catch (error) {
      if (requestId !== this.requestId) return false;
      button.classList.remove('is-loading');
      button.classList.add('is-error');
      button.innerHTML = '<span aria-hidden="true">✕</span><span>Error al procesar</span>';
      this.setTicketStatus(error.message || 'No se pudo completar la solicitud de IA.');
      this.onError(error);
      await this.wait(2500);
      return false;
    } finally {
      if (requestId === this.requestId) {
        this.ticketActionButtons.forEach((actionButton) => {
          actionButton.innerHTML = this.ticketActionButtonMarkup.get(actionButton.id) || originalMarkup;
          actionButton.classList.remove('is-loading', 'is-success', 'is-error');
          actionButton.removeAttribute('aria-busy');
          actionButton.disabled = false;
        });
      }
    }
  }

  validateTicketAIInput() {
    const title = document.getElementById('formTitle');
    const description = document.getElementById('formDescription');
    if (description.value.trim().length < 10) {
      this.showAIValidation('Escribe una descripción de al menos 10 caracteres para usar la IA.', description);
      return false;
    }
    if (!title.value.trim()) {
      this.showAIValidation('Escribe un título antes de usar la IA.', title);
      return false;
    }
    this.clearAIValidation();
    return true;
  }

  showAIValidation(message, field) {
    this.clearAIValidation();
    this.validationField = field;
    field.setAttribute('aria-invalid', 'true');
    if (field.id === 'formDescription') field.classList.add('ai-validation-error');
    const messageElement = document.getElementById('aiTicketValidationMessage');
    messageElement.textContent = message;
    messageElement.classList.remove('hidden');
    field.focus();
  }

  clearResolvedAIValidation() {
    if (!this.validationField) return;
    const resolved = this.validationField.id === 'formDescription'
      ? this.validationField.value.trim().length >= 10
      : Boolean(this.validationField.value.trim());
    if (resolved) this.clearAIValidation();
  }

  clearAIValidation() {
    if (this.validationField) {
      this.validationField.removeAttribute('aria-invalid');
      this.validationField.classList.remove('ai-validation-error');
    }
    this.validationField = null;
    const messageElement = document.getElementById('aiTicketValidationMessage');
    messageElement.textContent = '';
    messageElement.classList.add('hidden');
  }

  wait(milliseconds) {
    return new Promise((resolve) => setTimeout(resolve, milliseconds));
  }

  restoreTicketActionButtons() {
    this.ticketActionButtons.forEach((button) => {
      button.innerHTML = this.ticketActionButtonMarkup.get(button.id) || button.innerHTML;
      button.classList.remove('is-loading', 'is-success', 'is-error');
      button.removeAttribute('aria-busy');
      button.disabled = false;
    });
  }

  async runBoardSummary() {
    const requestId = ++this.boardRequestId;
    this.startBoardAction(this.boardSummaryButton);
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
      if (requestId === this.boardRequestId) this.restoreBoardActions();
    }
  }

  async runBoardQuestion() {
    const question = this.boardQuestionInput?.value.trim();
    if (!question) {
      this.setBoardStatus('Escribe una pregunta sobre el tablero.');
      return;
    }

    const requestId = ++this.boardRequestId;
    this.startBoardAction(this.boardQuestionButton);
    try {
      const tickets = this.getVisibleBoardTickets();
      if (!tickets.length) {
        this.setBoardStatus('No hay tickets visibles para consultar. Ajusta los filtros del tablero.');
        return;
      }
      if (tickets.length > 100) {
        this.setBoardStatus('La consulta admite hasta 100 tickets visibles. Aplica filtros en el tablero para acotar la búsqueda.');
        return;
      }
      const result = await this.aiService.askBoardQuestion(question, tickets);
      if (requestId !== this.boardRequestId) return;
      this.renderBoardAnswer(question, result);
    } catch (error) {
      if (requestId !== this.boardRequestId) return;
      this.setBoardStatus(error.message || 'No se pudo consultar el tablero.');
      this.onError(error);
    } finally {
      if (requestId === this.boardRequestId) this.restoreBoardActions();
    }
  }

  startBoardAction(button) {
    this.setBoardActionsDisabled(true);
    this.boardQuestionSuggestions.classList.add('hidden');
    button.classList.add('is-loading');
    button.setAttribute('aria-busy', 'true');
    const spinner = '<span class="ai-action-spinner" aria-hidden="true"></span>';
    button.innerHTML = button === this.boardQuestionButton
      ? spinner
      : `${spinner}<span>Analizando tablero...</span>`;
    this.boardOutput.replaceChildren();
    this.setBoardStatus('Analizando tablero...', true);
  }

  setBoardActionsDisabled(disabled) {
    this.boardActionButtons.forEach((button) => { button.disabled = disabled; });
    this.boardQuestionInput.disabled = disabled;
    this.boardQuestionClearButton.disabled = disabled;
  }

  restoreBoardActions() {
    this.boardActionButtons.forEach((button) => {
      button.innerHTML = this.boardActionButtonMarkup.get(button.id);
      button.classList.remove('is-loading');
      button.removeAttribute('aria-busy');
      const label = this.boardActionButtonLabels.get(button.id);
      if (label) button.setAttribute('aria-label', label);
      else button.removeAttribute('aria-label');
    });
    this.setBoardActionsDisabled(false);
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
    } else if (action === 'duplicates') {
      this.appendHeading(fragment, 'Tickets similares para revisar');
      if (result.matches.length) {
        const statusNames = {
          new: 'Nuevo',
          open: 'Abierto',
          in_progress: 'En progreso',
          resolved: 'Resuelto',
          closed: 'Cerrado',
          blocked: 'Bloqueado'
        };
        const list = document.createElement('ul');
        result.matches.forEach((match) => {
          const item = document.createElement('li');
          const level = match.similarity === 'high' ? 'Similitud alta' : 'Similitud posible';
          const status = match.status ? ` · ${statusNames[match.status] || match.status}` : '';
          item.textContent = `${match.id} · ${match.title}${status} (${level}) — ${match.reason}`;
          list.appendChild(item);
        });
        fragment.appendChild(list);
      } else {
        this.appendText(fragment, 'No encontré coincidencias claras entre los tickets revisados.');
      }
      if (result.totalCount > result.checkedCount) {
        this.appendText(fragment, `Se revisaron los ${result.checkedCount} tickets más recientes de ${result.totalCount}.`);
      } else {
        this.appendText(fragment, `Tickets revisados: ${result.checkedCount}.`);
      }
      const note = document.createElement('p');
      note.className = 'ai-assistant-note';
      note.textContent = 'La similitud es orientativa; confirma manualmente antes de descartar o cerrar un ticket.';
      fragment.append(note, this.createAction('Cerrar', 'dismiss', 'btn btn-outline'));
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
    this.appendBoardResultHeader(fragment, 'Resumen del tablero');
    this.appendHighlightedText(fragment, report.summary);
    this.appendList(fragment, 'Bloqueados', report.blocked);
    this.appendList(fragment, 'Vencidos', report.overdue);
    this.appendList(fragment, 'Otros puntos a revisar', report.highlights);
    this.boardOutput.replaceChildren(fragment);
    this.boardOutput.classList.remove('hidden');
  }

  renderBoardAnswer(question, result) {
    const fragment = document.createDocumentFragment();
    const statusNames = {
      new: 'Nuevo',
      open: 'Abierto',
      in_progress: 'En progreso',
      resolved: 'Resuelto',
      closed: 'Cerrado',
      blocked: 'Bloqueado'
    };
    this.appendBoardResultHeader(fragment, 'Respuesta del tablero');
    this.appendHeading(fragment, 'Tu pregunta');
    this.appendText(fragment, question);
    this.appendHeading(fragment, 'Respuesta');
    this.appendHighlightedText(fragment, result.answer);
    if (result.tickets.length) {
      this.appendHeading(fragment, 'Tickets relacionados');
      const relatedTickets = document.createElement('div');
      relatedTickets.className = 'ai-board-related-tickets';
      result.tickets.forEach((ticket) => {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'ai-board-related-ticket';
        button.dataset.aiBoardTicketId = ticket.id;
        button.setAttribute('aria-label', `Abrir ticket ${ticket.id}: ${ticket.title}`);

        const main = document.createElement('span');
        main.className = 'ai-board-related-ticket-main';
        const id = document.createElement('strong');
        id.className = 'ticket-id-highlight';
        id.textContent = ticket.id;
        const title = document.createElement('span');
        title.className = 'ai-board-related-ticket-title';
        title.textContent = ticket.title;
        main.append(id, title);

        const meta = document.createElement('span');
        meta.className = 'ai-board-related-ticket-meta';
        const status = document.createElement('span');
        status.className = 'ai-board-related-ticket-status';
        status.textContent = statusNames[ticket.status] || ticket.status || 'Sin estado';
        const arrow = document.createElement('span');
        arrow.className = 'ai-board-related-ticket-arrow';
        arrow.setAttribute('aria-hidden', 'true');
        arrow.textContent = '›';
        meta.append(status, arrow);

        button.append(main, meta);
        relatedTickets.appendChild(button);
      });
      fragment.appendChild(relatedTickets);
    }
    this.boardOutput.replaceChildren(fragment);
    this.boardOutput.classList.remove('hidden');
  }

  appendBoardResultHeader(parent, title) {
    const header = document.createElement('div');
    header.className = 'ai-board-result-heading';
    const heading = document.createElement('h5');
    heading.textContent = title;
    header.append(heading, this.createBoardCloseButton());
    parent.appendChild(header);
  }

  createBoardCloseButton() {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'ai-board-result-close';
    button.dataset.aiBoardAction = 'close';
    button.setAttribute('aria-label', 'Cerrar resultados');
    button.textContent = '×';
    return button;
  }

  appendHighlightedText(parent, value) {
    const paragraph = document.createElement('p');
    const text = String(value || '');
    const ticketIdPattern = /TCK-\d+/gi;
    let position = 0;
    let match;
    while ((match = ticketIdPattern.exec(text)) !== null) {
      paragraph.appendChild(document.createTextNode(text.slice(position, match.index)));
      const highlightedId = document.createElement('span');
      highlightedId.className = 'ticket-id-highlight';
      highlightedId.textContent = match[0];
      paragraph.appendChild(highlightedId);
      position = ticketIdPattern.lastIndex;
    }
    paragraph.appendChild(document.createTextNode(text.slice(position)));
    if (text) parent.appendChild(paragraph);
  }

  handleBoardOutputClick(event) {
    if (event.target.closest('[data-ai-board-action="close"]')) {
      this.clearBoardSummary();
      return;
    }
    const ticketId = event.target.closest('[data-ai-board-ticket-id]')?.dataset.aiBoardTicketId;
    if (!ticketId || !this.onOpenTicket) return;
    Promise.resolve(this.onOpenTicket(ticketId)).catch((error) => {
      this.onError(error);
    });
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

  setBoardStatus(message, loading = false) {
    const fragment = document.createDocumentFragment();
    const header = document.createElement('div');
    header.className = 'ai-board-result-heading';
    header.appendChild(this.createBoardCloseButton());
    const status = document.createElement('p');
    status.className = loading ? 'ai-board-status' : 'ai-assistant-note';
    status.setAttribute('role', 'status');
    status.setAttribute('aria-live', 'polite');
    if (loading) {
      const spinner = document.createElement('span');
      spinner.className = 'ai-action-spinner';
      spinner.setAttribute('aria-hidden', 'true');
      const text = document.createElement('span');
      text.textContent = message;
      status.append(spinner, text);
    } else {
      status.textContent = message;
    }
    fragment.append(header, status);
    this.boardOutput.replaceChildren(fragment);
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
    if (invalidate) {
      this.requestId += 1;
      this.restoreTicketActionButtons();
    }
    this.pendingRecommendations = null;
    this.ticketOutput.replaceChildren();
    this.ticketOutput.classList.add('hidden');
  }

  reset() {
    this.clearTicketOutput();
    this.clearAIValidation();
    this.clearBoardSummary();
  }

  clearBoardSummary() {
    this.boardRequestId += 1;
    this.restoreBoardActions();
    this.boardOutput.replaceChildren();
    this.boardOutput.classList.add('hidden');
    this.boardQuestionSuggestions.classList.remove('hidden');
  }
}
