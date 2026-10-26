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
      statusRow.classList.add('hidden');
      this.renderHistory(ticket.statusHistory || []);
    } else {
      heading.textContent = 'Crear nueva solicitud';
      formTicketId.value = '';
      deleteBtn.classList.add('hidden');
      this.form.reset();
      statusRow.classList.remove('hidden');
      document.getElementById('ticketHistorySection').classList.add('hidden');
    }

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
    this.form.querySelectorAll('input, textarea, select').forEach((field) => {
      field.disabled = false;
    });
    this.previousFocus?.focus();
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
  }

  hideLogin() {
    this.loginModal.classList.add('hidden');
  }
}
