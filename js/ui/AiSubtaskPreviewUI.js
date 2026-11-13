export class AiSubtaskPreviewUI {
  constructor({ modalEl, aiService, onConfirm, onError }) {
    this.modalEl = modalEl;
    this.aiService = aiService;
    this.onConfirm = onConfirm;
    this.onError = onError;
    this.button = document.getElementById('btnSuggestSubtasks');
    this.panel = document.getElementById('aiSubtaskPreview');
    this.requestId = 0;
    this.bindEvents();
  }

  bindEvents() {
    this.button.addEventListener('click', () => {
      void this.generate();
    });

    this.panel.addEventListener('click', (event) => {
      const action = event.target.closest('[data-ai-subtask-action]')?.dataset.aiSubtaskAction;
      if (action === 'cancel') this.reset();
      if (action === 'confirm') void this.confirm();
    });

    this.panel.addEventListener('input', () => this.updateConfirmButton());
    this.panel.addEventListener('change', () => this.updateConfirmButton());
  }

  async generate() {
    const title = document.getElementById('formTitle').value.trim();
    const description = document.getElementById('formDescription').value.trim();
    if (!title || !description) {
      this.onError(new Error('Completa el título y la descripción antes de sugerir subtareas.'));
      return;
    }

    const requestId = ++this.requestId;
    this.button.disabled = true;
    this.showStatus('Generando sugerencias…');
    try {
      const subtasks = await this.aiService.suggestSubtasks(title, description);
      if (requestId !== this.requestId) return;
      if (
        this.modalEl.classList.contains('hidden')
        || document.getElementById('formTitle').value.trim() !== title
        || document.getElementById('formDescription').value.trim() !== description
      ) {
        this.showStatus('El ticket cambió durante la solicitud. Vuelve a generar las sugerencias.');
        return;
      }
      if (subtasks.length === 0) {
        this.showStatus('No se generaron subtareas. Inténtalo de nuevo con más detalles.');
        return;
      }
      this.render(subtasks);
    } catch (error) {
      if (requestId !== this.requestId) return;
      this.showStatus(error.message || 'No se pudieron generar las subtareas.');
      this.onError(error);
    } finally {
      if (requestId === this.requestId) this.button.disabled = false;
    }
  }

  render(subtasks) {
    const fragment = document.createDocumentFragment();
    const heading = document.createElement('h5');
    heading.className = 'ai-subtask-preview-heading';
    heading.textContent = 'Revisa y edita las sugerencias';
    fragment.appendChild(heading);

    const list = document.createElement('ul');
    list.className = 'ai-subtask-preview-list';
    subtasks.forEach((subtask, index) => {
      const item = document.createElement('li');
      item.className = 'ai-subtask-preview-item';

      const checkboxLabel = document.createElement('label');
      checkboxLabel.className = 'ai-subtask-preview-check';
      const checkbox = document.createElement('input');
      checkbox.type = 'checkbox';
      checkbox.checked = true;
      checkbox.dataset.aiSubtaskSelected = '';
      checkbox.setAttribute('aria-label', `Incluir sugerencia ${index + 1}`);
      checkboxLabel.appendChild(checkbox);

      const input = document.createElement('input');
      input.type = 'text';
      input.maxLength = 200;
      input.value = subtask;
      input.dataset.aiSubtaskText = '';
      input.setAttribute('aria-label', `Texto de sugerencia ${index + 1}`);
      item.append(checkboxLabel, input);
      list.appendChild(item);
    });
    fragment.appendChild(list);

    const status = document.createElement('p');
    status.className = 'ai-subtask-preview-status';
    status.setAttribute('role', 'status');
    status.setAttribute('aria-live', 'polite');
    status.textContent = 'Desmarca las subtareas que no quieras agregar.';
    fragment.appendChild(status);

    const actions = document.createElement('div');
    actions.className = 'ai-subtask-preview-actions';
    const cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.className = 'btn btn-outline';
    cancel.dataset.aiSubtaskAction = 'cancel';
    cancel.textContent = 'Descartar';
    const confirm = document.createElement('button');
    confirm.type = 'button';
    confirm.className = 'btn btn-primary';
    confirm.dataset.aiSubtaskAction = 'confirm';
    confirm.textContent = 'Agregar seleccionadas';
    actions.append(cancel, confirm);
    fragment.appendChild(actions);

    this.panel.replaceChildren(fragment);
    this.panel.classList.remove('hidden');
    this.updateConfirmButton();
  }

  async confirm() {
    const subtasks = [...this.panel.querySelectorAll('[data-ai-subtask-selected]:checked')]
      .map((checkbox) => checkbox.closest('.ai-subtask-preview-item').querySelector('[data-ai-subtask-text]').value.trim())
      .filter(Boolean);
    if (subtasks.length === 0) return;

    const button = this.panel.querySelector('[data-ai-subtask-action="confirm"]');
    button.disabled = true;
    this.setStatus('Guardando subtareas…');
    try {
      const ticket = await this.onConfirm(subtasks);
      if (ticket) {
        window.dispatchEvent(new CustomEvent('ticket:checklist-updated', { detail: { ticket } }));
      }
      this.reset();
    } catch (error) {
      this.setStatus(error.message || 'No se pudieron guardar las subtareas.');
      this.onError(error);
      button.disabled = false;
    }
  }

  updateConfirmButton() {
    const confirm = this.panel.querySelector('[data-ai-subtask-action="confirm"]');
    if (!confirm) return;
    const selected = [...this.panel.querySelectorAll('[data-ai-subtask-selected]:checked')]
      .some((checkbox) => checkbox.closest('.ai-subtask-preview-item')
        .querySelector('[data-ai-subtask-text]').value.trim());
    confirm.disabled = !selected;
  }

  showStatus(message) {
    const fragment = document.createDocumentFragment();
    const status = document.createElement('p');
    status.className = 'ai-subtask-preview-status';
    status.setAttribute('role', 'status');
    status.setAttribute('aria-live', 'polite');
    status.textContent = message;
    fragment.appendChild(status);
    this.panel.replaceChildren(fragment);
    this.panel.classList.remove('hidden');
  }

  setStatus(message) {
    const status = this.panel.querySelector('.ai-subtask-preview-status');
    if (status) status.textContent = message;
  }

  reset() {
    this.requestId += 1;
    this.button.disabled = false;
    this.panel.replaceChildren();
    this.panel.classList.add('hidden');
  }
}
