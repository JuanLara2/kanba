import { STATUS_DEFINITIONS } from '../config/constants.js';

export class ModalView {
  constructor({ modalEl, form, loginModal, loginForm, usersModal, usersForm, usersMap, onTicketSubmit, onLoginSubmit, onUserSubmit }) {
    this.modalEl = modalEl;
    this.form = form;
    this.loginModal = loginModal;
    this.loginForm = loginForm;
    this.usersModal = usersModal;
    this.usersForm = usersForm;
    this.usersMap = usersMap;
    this.onTicketSubmit = onTicketSubmit;
    this.onLoginSubmit = onLoginSubmit;
    this.onUserSubmit = onUserSubmit;
    this.checklistDraft = [];
    this.bindEvents();
  }

  bindEvents() {
    this.form.addEventListener('submit', (event) => {
      if (this.onTicketSubmit) {
        this.onTicketSubmit(event);
      }
    });

    this.loginForm.addEventListener('submit', (event) => {
      if (this.onLoginSubmit) {
        this.onLoginSubmit(event);
      }
    });

    this.usersForm.addEventListener('submit', (event) => {
      if (this.onUserSubmit) {
        this.onUserSubmit(event);
      }
    });

    this.usersModal.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') this.closeUsers();
      if (event.key !== 'Tab') return;
      const focusable = [...this.usersModal.querySelectorAll('button:not(:disabled), input:not(:disabled), select:not(:disabled)')];
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    });

    this.modalEl.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') {
        this.closeTicket();
        return;
      }

      if (event.key !== 'Tab') return;
      const focusable = [...this.modalEl.querySelectorAll('button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled)')]
        .filter((element) => !element.closest('.hidden'));
      if (focusable.length === 0) return;

      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    });
  }

  openTicket(ticket = null, permissions = {}) {
    this.previousFocus = document.activeElement;
    const heading = document.getElementById('modalHeading');
    const formTicketId = document.getElementById('formTicketId');
    const deleteBtn = document.getElementById('btnDeleteTicket');
    const saveBtn = this.form.querySelector('[type="submit"]');
    const statusRow = document.getElementById('formStatusField');
    const canEditContent = !ticket || Boolean(permissions.canEdit);
    const canSave = !ticket || canEditContent || Boolean(permissions.canManageAssignment);

    if (ticket) {
      heading.textContent = 'Editar solicitud';
      formTicketId.value = ticket.id;
      deleteBtn.classList.toggle('hidden', !permissions.canDelete);
      document.getElementById('formTitle').value = ticket.title;
      document.getElementById('formDescription').value = ticket.description;
      document.getElementById('formPriority').value = ticket.priority;
      document.getElementById('formAssignee').value = ticket.assignedTo || '';
      document.getElementById('formInitialStatus').value = ticket.status;
      document.getElementById('formDueDate').value = ticket.dueDate ? this.toLocalDateTime(ticket.dueDate) : '';
      this.checklistDraft = (ticket.checklist || []).map((item) => ({ ...item }));
      statusRow.classList.add('hidden');
      this.renderHistory(ticket.statusHistory || []);
    } else {
      heading.textContent = 'Crear nueva solicitud';
      formTicketId.value = '';
      deleteBtn.classList.add('hidden');
      this.form.reset();
      this.checklistDraft = [];
      statusRow.classList.remove('hidden');
      document.getElementById('ticketHistorySection').classList.add('hidden');
    }

    this.canManageChecklist = Boolean(permissions.canManageChecklist);
    document.getElementById('ticketChecklistSection').classList.toggle('hidden', !ticket && !this.canManageChecklist);
    this.renderChecklist();
    document.getElementById('formTitle').disabled = !canEditContent;
    document.getElementById('formDescription').disabled = !canEditContent;
    document.getElementById('formPriority').disabled = !canEditContent;
    document.getElementById('formInitialStatus').disabled = Boolean(ticket) || !permissions.canManageAssignment;
    document.getElementById('formAssignee').disabled = !permissions.canManageAssignment;
    document.getElementById('formDueDate').disabled = !permissions.canManageAssignment;
    saveBtn.classList.toggle('hidden', !canSave);
    this.modalEl.classList.remove('hidden');
    this.modalEl.querySelector('input:not([type="hidden"]):not(:disabled), button:not(:disabled)')?.focus();
  }

  closeTicket() {
    this.modalEl.classList.add('hidden');
    this.form.reset();
    document.getElementById('modalHeading').textContent = 'Crear nueva solicitud';
    document.getElementById('formTicketId').value = '';
    document.getElementById('btnDeleteTicket').classList.add('hidden');
    document.getElementById('ticketHistorySection').classList.add('hidden');
    this.checklistDraft = [];
    this.canManageChecklist = false;
    this.renderChecklist();
    this.form.querySelectorAll('input, textarea, select').forEach((field) => {
      field.disabled = false;
    });
    this.previousFocus?.focus();
  }

  getChecklist() {
    return this.checklistDraft.map((item) => ({ ...item }));
  }

  addChecklistItem() {
    if (!this.canManageChecklist || this.checklistDraft.length >= 100) return;
    const input = document.getElementById('checklistNewItem');
    const text = input.value.trim();
    if (!text) {
      input.focus();
      return;
    }

    this.checklistDraft.push({ text, completed: false });
    input.value = '';
    this.renderChecklist();
    input.focus();
  }

  removeChecklistItem(index) {
    if (!this.canManageChecklist || !Number.isInteger(index)) return;
    this.checklistDraft.splice(index, 1);
    this.renderChecklist();
  }

  updateChecklistText(index, value) {
    if (!this.canManageChecklist || !this.checklistDraft[index]) return;
    this.checklistDraft[index].text = value;
  }

  setChecklistCompletion(index, completed) {
    if (!this.canManageChecklist || !this.checklistDraft[index]) return;
    this.checklistDraft[index].completed = completed;
    const row = this.form.querySelector(`[data-checklist-complete="${index}"]`)?.closest('.checklist-item');
    row?.classList.toggle('is-complete', completed);
    this.renderChecklistProgress();
  }

  renderChecklist() {
    const list = document.getElementById('checklistItems');
    const progressTrack = document.getElementById('checklistProgressTrack');
    if (!list || !progressTrack) return;

    const total = this.checklistDraft.length;
    this.renderChecklistProgress();

    const fragment = document.createDocumentFragment();
    if (total === 0) {
      const empty = document.createElement('p');
      empty.className = 'checklist-empty';
      empty.textContent = 'Todavía no hay subtareas.';
      fragment.appendChild(empty);
    }
    this.checklistDraft.forEach((item, index) => {
      const row = document.createElement('div');
      row.className = `checklist-item${item.completed ? ' is-complete' : ''}`;

      const checkbox = document.createElement('input');
      checkbox.type = 'checkbox';
      checkbox.checked = Boolean(item.completed);
      checkbox.disabled = !this.canManageChecklist;
      checkbox.dataset.checklistComplete = String(index);
      checkbox.setAttribute('aria-label', `Completar subtarea ${item.text}`);

      const text = document.createElement('input');
      text.type = 'text';
      text.value = item.text;
      text.maxLength = 200;
      text.disabled = !this.canManageChecklist;
      text.dataset.checklistText = String(index);
      text.setAttribute('aria-label', `Texto de subtarea ${index + 1}`);

      row.append(checkbox, text);
      if (this.canManageChecklist) {
        const remove = document.createElement('button');
        remove.type = 'button';
        remove.className = 'checklist-remove';
        remove.dataset.removeChecklistItem = String(index);
        remove.setAttribute('aria-label', `Eliminar subtarea ${item.text}`);
        remove.textContent = '×';
        row.appendChild(remove);
      }
      fragment.appendChild(row);
    });
    list.replaceChildren(fragment);
  }

  renderChecklistProgress() {
    const total = this.checklistDraft.length;
    const completed = this.checklistDraft.filter((item) => item.completed).length;
    const percentage = total ? Math.round((completed / total) * 100) : 0;
    document.getElementById('checklistProgressText').textContent = `${completed}/${total} · ${percentage}%`;
    const fill = document.getElementById('checklistProgressFill');
    fill.style.width = `${percentage}%`;
    fill.style.setProperty('--progress-hue', String(Math.round(percentage * 1.2)));
    document.getElementById('checklistProgressTrack').setAttribute('aria-valuenow', String(percentage));
    document.getElementById('checklistAddRow').classList.toggle('hidden', !this.canManageChecklist);
    document.getElementById('checklistNewItem').disabled = !this.canManageChecklist || total >= 100;
    document.getElementById('btnAddChecklistItem').disabled = !this.canManageChecklist || total >= 100;
    document.getElementById('checklistHelp').textContent = this.canManageChecklist
      ? 'Puedes agregar hasta 100 subtareas, de máximo 200 caracteres cada una. Los cambios se guardan con el ticket.'
      : 'Solo los usuarios con permiso de edición pueden cambiar las subtareas.';
  }

  renderHistory(records) {
    const section = document.getElementById('ticketHistorySection');
    const list = document.getElementById('ticketHistoryList');
    list.replaceChildren();
    if (!Array.isArray(records)) records = [];

    if (records.length === 0) {
      const item = document.createElement('li');
      item.textContent = 'Sin cambios de estado registrados.';
      list.appendChild(item);
    } else {
      records.forEach((record) => {
        const item = document.createElement('li');
        const from = STATUS_DEFINITIONS[record.from]?.name || record.from;
        const to = STATUS_DEFINITIONS[record.to]?.name || record.to;
        const user = this.usersMap.get(record.changedBy);
        const changedAt = new Date(record.changedAt);
        const dateLabel = Number.isNaN(changedAt.getTime()) ? 'Fecha desconocida' : changedAt.toLocaleString();
        item.textContent = `${from} → ${to} · ${dateLabel} · ${user?.fullName || 'Usuario desconocido'}`;
        list.appendChild(item);
      });
    }

    section.classList.remove('hidden');
  }

  openUsers(users) {
    if (this.usersModal.classList.contains('hidden')) {
      this.previousFocus = document.activeElement;
    }
    const list = document.getElementById('userList');
    list.replaceChildren();

    users
      .slice()
      .sort((a, b) => a.fullName.localeCompare(b.fullName, 'es'))
      .forEach((user) => {
        const item = document.createElement('li');
        const name = document.createElement('span');
        name.className = 'user-list-name';
        name.textContent = user.fullName;

        const details = document.createElement('span');
        details.className = 'user-list-details';
        details.textContent = `${user.email} · ${user.role}`;

        item.append(name, details);
        list.appendChild(item);
      });

    this.usersForm.reset();
    this.usersModal.classList.remove('hidden');
    document.getElementById('userFullName').focus();
  }

  closeUsers() {
    this.usersModal.classList.add('hidden');
    this.usersForm.reset();
    this.previousFocus?.focus();
  }

  toLocalDateTime(value) {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return '';
    const localDate = new Date(date.getTime() - date.getTimezoneOffset() * 60000);
    return localDate.toISOString().slice(0, 16);
  }

  showLogin() {
    this.loginModal.classList.remove('hidden');
    document.getElementById('appShell').classList.add('hidden');
    document.getElementById('loginEmail').focus();
  }

  hideLogin() {
    this.loginModal.classList.add('hidden');
    document.getElementById('appShell').classList.remove('hidden');
  }
}
