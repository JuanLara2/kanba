import { SupabaseClient } from './data/supabaseClient.js';
import { SupabaseAdapter } from './data/db.js';
import { AuthService } from './services/authService.js';
import { TicketService } from './services/ticketService.js';
import { FilterSortService } from './services/filterService.js';
import { BoardView } from './ui/boardView.js';
import { ModalView } from './ui/modalView.js';
import { DragDropController } from './ui/dragDrop.js';
import { CalendarView, dueDateForCalendarDay } from './ui/calendarView.js';
import { initializeThemeController } from './ui/themeController.js';
import { SLA_REFRESH_INTERVAL_MS } from './config/constants.js';
import { calculateTicketMetrics, metricsToCsv } from './services/metricsService.js';
import { RealtimeService } from './services/realtimeService.js';

const client = new SupabaseClient();
let auth;
const db = new SupabaseAdapter(client, () => auth.getAccessToken());
auth = new AuthService(client, db);
const ticketService = new TicketService(db, auth);
const boardEl = document.getElementById('kanbanBoard');
const modalEl = document.getElementById('ticketModal');
const form = document.getElementById('ticketForm');
const loginModal = document.getElementById('loginModal');
const loginForm = document.getElementById('loginForm');
const usersModal = document.getElementById('usersModal');
const usersForm = document.getElementById('userForm');
const filters = {
  search: document.getElementById('filterSearch'),
  assignedTo: document.getElementById('filterAssignee'),
  status: document.getElementById('filterStatus'),
  priority: document.getElementById('filterPriority'),
  category: document.getElementById('filterCategory'),
  dueFilter: document.getElementById('filterSla'),
  sortField: document.getElementById('sortField'),
  sortDirection: document.getElementById('sortDirection')
};

let allTickets = [];
let usersMap = new Map();
let activeUser = null;
let notifications = [];
let satisfactionEntries = [];
let notificationErrorShown = false;
let responseTemplates = [];
let realtimeRefreshTimeout;
let boardView;
let calendarView;
let modalView;
let dragDropController;
const realtimeService = new RealtimeService(client, {
  onChange: handleRealtimeChange,
  onStatus: renderRealtimeStatus
});

async function bootstrap() {
  initializeThemeController();
  boardView = new BoardView(boardEl, ticketService, usersMap);
  modalView = new ModalView({
    modalEl,
    form,
    loginModal,
    loginForm,
    usersModal,
    usersForm,
    usersMap,
    onTicketSubmit: handleTicketSubmit,
    onLoginSubmit: handleLoginSubmit,
    onUserSubmit: handleUserSubmit
  });

  dragDropController = new DragDropController({
    boardEl,
    onStatusChange: async (ticketId, nextStatus) => {
      try {
        await ticketService.changeTicketStatus(ticketId, nextStatus);
        await loadTickets();
        renderBoard();
        showToast('Estado actualizado');
      } catch (error) {
        showToast(error.message || 'No tienes permisos para mover este ticket');
      }

      function applySelectedTemplate() {
        const template = responseTemplates.find((item) => item.id === document.getElementById('responseTemplateSelect').value);
        if (!template) {
          showToast('Selecciona una plantilla primero.');
          return;
        }
        const input = document.getElementById('ticketCommentInput');
        input.value = input.value ? `${input.value}\n\n${template.body}` : template.body;
        input.focus();
      }

      async function saveResponseTemplate() {
        const select = document.getElementById('responseTemplateSelect');
        const selectedId = select.value || undefined;
        try {
          await ticketService.saveResponseTemplate({
            id: selectedId,
            title: document.getElementById('templateTitle').value,
            body: document.getElementById('templateBody').value
          });
          await loadResponseTemplates();
          modalView.setResponseTemplates(responseTemplates, true);
          showToast('Plantilla guardada para el equipo.');
        } catch (error) {
          showToast(error.message || 'No se pudo guardar la plantilla.');
        }
      }

      async function deleteResponseTemplate() {
        const templateId = document.getElementById('responseTemplateSelect').value;
        if (!templateId) return;
        try {
          await ticketService.deleteResponseTemplate(templateId);
          await loadResponseTemplates();
          modalView.clearResponseTemplateEditor();
          modalView.setResponseTemplates(responseTemplates, true);
          showToast('Plantilla eliminada.');
        } catch (error) {
          showToast(error.message || 'No se pudo eliminar la plantilla.');
        }
      }
    },
    onEditRequest: openTicketForEditing
  });

  calendarView = new CalendarView({
    container: document.getElementById('ticketCalendar'),
    onDateChange: handleCalendarDateChange,
    onTicketClick: openTicketForEditing
  });

  bindStaticEvents();
  await syncAuthState();
  renderBoard();
  window.setInterval(() => {
    if (activeUser) updateSlaOverview();
    if (activeUser && modalEl.classList.contains('hidden') && !boardEl.contains(document.activeElement)) {
      renderBoard();
    }

    function initializeMetricsDates() {
      const now = new Date();
      const start = new Date(now.getFullYear(), now.getMonth(), 1);
      const formatDate = (date) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
      document.getElementById('metricsStart').value ||= formatDate(start);
      document.getElementById('metricsEnd').value ||= formatDate(now);
      renderMetrics();
    }
    if (activeUser) refreshNotificationList();
  }, SLA_REFRESH_INTERVAL_MS);
}

async function loadUsers(user = activeUser) {
  const users = await db.getAll('users');
  usersMap.clear();
  users.forEach((user) => usersMap.set(user.id, user));
  populateAssigneeSelect(users, user);
}

function populateAssigneeSelect(users, currentUser = activeUser) {
  const workspaceUsers = currentUser
    ? users.filter((user) => user.workspaceId === currentUser.workspaceId)
    : [];
  const select = document.getElementById('formAssignee');
  select.innerHTML = '<option value="">Sin asignar</option>';

  workspaceUsers.filter((user) => user.role === 'Admin' || user.role === 'Agent').forEach((user) => {
    const option = document.createElement('option');
    option.value = user.id;
    option.textContent = `${user.fullName} (${user.role})`;
    select.appendChild(option);
  });

  const filterSelect = filters.assignedTo;
  filterSelect.innerHTML = '<option value="ALL">Todos los miembros</option>';
  workspaceUsers.forEach((user) => {
    const option = document.createElement('option');
    option.value = user.id;
    option.textContent = user.fullName;
    filterSelect.appendChild(option);
  });
}

async function loadTickets() {
  allTickets = await ticketService.getAllTickets();
}

function bindStaticEvents() {
  document.getElementById('boardTab').addEventListener('click', () => setActiveView('board'));
  document.getElementById('calendarTab').addEventListener('click', () => setActiveView('calendar'));
  document.getElementById('metricsTab').addEventListener('click', () => setActiveView('metrics'));
  document.querySelector('.view-tabs').addEventListener('keydown', (event) => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    const tabs = [...document.querySelectorAll('.view-tabs [role="tab"]')];
    const currentIndex = tabs.indexOf(event.target.closest('[role="tab"]'));
    if (currentIndex === -1) return;
    event.preventDefault();
    const nextIndex = event.key === 'Home'
      ? 0
      : event.key === 'End'
        ? tabs.length - 1
        : (currentIndex + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length;
    const nextView = tabs[nextIndex].id === 'calendarTab' ? 'calendar' : 'board';
    const resolvedView = tabs[nextIndex].id === 'metricsTab' ? 'metrics' : nextView;
    setActiveView(resolvedView);
    tabs[nextIndex].focus();
  });
  document.getElementById('btnNewTicket').addEventListener('click', async () => {
    const user = await auth.getCurrentUser();
    modalView.openTicket(null, {
      canManageAssignment: auth.canAssignOrSetDue(user),
      canManageChecklist: auth.canAssignOrSetDue(user)
    });
  });
  document.getElementById('btnManageUsers').addEventListener('click', async () => {
    const user = await auth.getCurrentUser();
    if (!auth.canManageUsers(user)) {
      showToast('Solo un administrador puede administrar usuarios.');
      return;
    }
    modalView.openUsers([...usersMap.values()]);
  });
  document.getElementById('usersModalCloseBtn').addEventListener('click', () => modalView.closeUsers());
  document.getElementById('usersModalCancelBtn').addEventListener('click', () => modalView.closeUsers());
  document.getElementById('btnNotifications').addEventListener('click', () => {
    const panel = document.getElementById('notificationsPanel');
    const isOpen = panel.classList.toggle('hidden') === false;
    document.getElementById('btnNotifications').setAttribute('aria-expanded', String(isOpen));
    if (isOpen) refreshNotificationList();
  });
  document.getElementById('metricsStart').addEventListener('change', renderMetrics);
  document.getElementById('metricsEnd').addEventListener('change', renderMetrics);
  document.getElementById('btnExportMetrics').addEventListener('click', exportMetrics);
  document.getElementById('btnReopenTicket').addEventListener('click', handleTicketReopen);
  document.getElementById('satisfactionCloseBtn').addEventListener('click', closeSatisfactionModal);
  document.getElementById('satisfactionCancelBtn').addEventListener('click', closeSatisfactionModal);
  document.getElementById('satisfactionForm').addEventListener('submit', handleSatisfactionSubmit);
  document.getElementById('responseTemplateSelect').addEventListener('change', (event) => {
    modalView.selectResponseTemplate(event.target.value);
  });
  document.getElementById('btnApplyTemplate').addEventListener('click', applySelectedTemplate);
  document.getElementById('btnSaveTemplate').addEventListener('click', saveResponseTemplate);
  document.getElementById('btnDeleteTemplate').addEventListener('click', deleteResponseTemplate);
  document.getElementById('notificationList').addEventListener('click', handleNotificationClick);
  document.getElementById('btnPostComment').addEventListener('click', handleCommentSubmit);
  document.getElementById('btnCancelModal').addEventListener('click', () => modalView.closeTicket());
  document.getElementById('checklistAddRow').addEventListener('click', (event) => {
    if (event.target.closest('#btnAddChecklistItem')) modalView.addChecklistItem();
  });
  document.getElementById('checklistItems').addEventListener('click', (event) => {
    const removeButton = event.target.closest('[data-remove-checklist-item]');
    if (removeButton) modalView.removeChecklistItem(Number(removeButton.dataset.removeChecklistItem));
  });
  document.getElementById('checklistItems').addEventListener('input', (event) => {
    const input = event.target.closest('[data-checklist-text]');
    if (input) modalView.updateChecklistText(Number(input.dataset.checklistText), input.value);
  });
  document.getElementById('checklistItems').addEventListener('change', (event) => {
    const checkbox = event.target.closest('[data-checklist-complete]');
    if (checkbox) modalView.setChecklistCompletion(Number(checkbox.dataset.checklistComplete), checkbox.checked);
  });
  document.getElementById('checklistNewItem').addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      modalView.addChecklistItem();
    }
  });
  document.getElementById('btnDeleteTicket').addEventListener('click', async () => {
    const ticketId = document.getElementById('formTicketId').value;
    if (!ticketId) return;

    try {
      if (!window.confirm(`¿Eliminar el ticket ${ticketId}? Esta acción no se puede deshacer.`)) return;
      await ticketService.deleteTicket(ticketId);
      await loadTickets();
      modalView.closeTicket();
      renderBoard();
      showToast('Ticket eliminado correctamente');
    } catch (error) {
      showToast(error.message || 'No se pudo eliminar el ticket');
    }
  });
  document.getElementById('btnLogout').addEventListener('click', async () => {
    let logoutError;
    try {
      await auth.logout();
    } catch (error) {
      logoutError = error;
    }
    await syncAuthState();
    if (logoutError) showToast(logoutError.message || 'No se pudo cerrar la sesión en Supabase.');
  });

  Object.values(filters).forEach((input) => {
    input.addEventListener('input', renderBoard);
    input.addEventListener('change', renderBoard);
  });

  boardEl.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    const card = event.target.closest('.ticket-card');
    if (!card) return;
    event.preventDefault();
    dragDropController.onEditRequest(card.dataset.ticketId);
  });
}

async function openTicketForEditing(ticketId) {
  const ticket = allTickets.find((item) => item.id === ticketId);
  if (!ticket) return;
  const user = await auth.getCurrentUser();
  modalView.openTicket(ticket, {
    canEdit: auth.canEditTicket(user, ticket),
    canManageChecklist: auth.canEditTicket(user, ticket),
    canManageAssignment: auth.canAssignOrSetDue(user),
    canDelete: auth.canDelete(user),
    canComment: auth.canCommentOnTicket(user, ticket)
  });
  const canComment = auth.canCommentOnTicket(user, ticket);
  const canManageTemplates = auth.canManageUsers(user);
  document.getElementById('templateControls').classList.toggle('hidden', !canComment);
  modalView.setResponseTemplates(responseTemplates, canManageTemplates);
  document.getElementById('btnReopenTicket').classList.toggle('hidden', ticket.status !== 'resolved' || !auth.canChangeStatus(user, ticket));
  if (auth.canCommentOnTicket(user, ticket)) await loadTicketComments(ticketId);
  if (ticket.status === 'closed' && ticket.createdBy === user?.id && user?.role === 'Reporter') {
    const satisfaction = await ticketService.getSatisfaction(ticketId);
    if (!satisfaction) openSatisfactionModal(ticketId);
  }
}

async function loadTicketComments(ticketId) {
  modalView.setCommentsLoading();
  try {
    const comments = await ticketService.getComments(ticketId);
    if (modalView.currentTicketId === ticketId) modalView.renderComments(comments);
  } catch (error) {
    modalView.showCommentsError(error.message || 'No se pudieron cargar los comentarios.');
    showToast(error.message || 'No se pudieron cargar los comentarios.');
  }
}

async function handleCalendarDateChange(ticketId, dateKey) {
  const ticket = allTickets.find((item) => item.id === ticketId);
  if (!ticket) return;

  try {
    const dueDate = dateKey
      ? dueDateForCalendarDay(new Date(`${dateKey}T12:00:00`), ticket.dueDate)
      : null;
    await ticketService.rescheduleTicket(ticketId, dueDate);
    await loadTickets();
    renderBoard();
    showToast(dateKey ? 'Fecha límite actualizada' : 'Fecha límite quitada');
  } catch (error) {
    showToast(error.message || 'No se pudo cambiar la fecha límite');
    renderBoard();
  }
}

function setActiveView(view) {
  const showCalendar = view === 'calendar';
  const showMetrics = view === 'metrics';
  document.getElementById('boardPanel').classList.toggle('hidden', showCalendar || showMetrics);
  document.getElementById('calendarPanel').classList.toggle('hidden', !showCalendar);
  document.getElementById('metricsPanel').classList.toggle('hidden', !showMetrics);
  document.getElementById('boardTab').classList.toggle('is-active', !showCalendar && !showMetrics);
  document.getElementById('calendarTab').classList.toggle('is-active', showCalendar);
  document.getElementById('metricsTab').classList.toggle('is-active', showMetrics);
  document.getElementById('boardTab').setAttribute('aria-selected', String(!showCalendar && !showMetrics));
  document.getElementById('calendarTab').setAttribute('aria-selected', String(showCalendar));
  document.getElementById('metricsTab').setAttribute('aria-selected', String(showMetrics));
  document.getElementById('boardTab').tabIndex = showCalendar || showMetrics ? -1 : 0;
  document.getElementById('calendarTab').tabIndex = showCalendar ? 0 : -1;
  document.getElementById('metricsTab').tabIndex = showMetrics ? 0 : -1;
}

async function handleTicketSubmit(event) {
  event.preventDefault();
  const ticketId = document.getElementById('formTicketId').value;
  const title = document.getElementById('formTitle').value;
  const description = document.getElementById('formDescription').value;
  const priority = document.getElementById('formPriority').value;
  const assignedTo = document.getElementById('formAssignee').value || null;
  const initialStatus = document.getElementById('formInitialStatus').value;
  const dueDate = document.getElementById('formDueDate').value;

  if (!title || !description) {
    showToast('Completa los campos requeridos');
    return;
  }

  try {
    if (ticketId) {
      await ticketService.updateTicket({
        id: ticketId,
        title,
        description,
        priority,
        category: document.getElementById('formCategory').value,
        assignedTo,
        dueDate,
        checklist: modalView.getChecklist()
      });
      showToast('Ticket actualizado correctamente');
    } else {
      await ticketService.createTicket({
        title,
        description,
        priority,
        category: document.getElementById('formCategory').value,
        initialStatus,
        assignedTo,
        dueDate,
        checklist: modalView.getChecklist()
      });
      showToast('Ticket creado correctamente');
    }

    await loadTickets();
    modalView.closeTicket();
    renderBoard();
  } catch (error) {
    showToast(error.message || 'No se pudo guardar el ticket');
  }
}

async function handleCommentSubmit() {
  const ticketId = modalView.currentTicketId;
  const input = document.getElementById('ticketCommentInput');
  const button = document.getElementById('btnPostComment');
  if (!ticketId) return;

  button.disabled = true;
  try {
    await ticketService.addComment(ticketId, input.value);
    input.value = '';
    await loadTicketComments(ticketId);
    await refreshNotificationList();
    initializeMetricsDates();
    showToast('Comentario publicado correctamente.');
  } catch (error) {
    showToast(error.message || 'No se pudo publicar el comentario.');
  } finally {
    button.disabled = false;
  }
}

async function refreshNotificationList() {
  if (!activeUser) return;
  try {
    notifications = await ticketService.getNotifications(activeUser.id);
    notificationErrorShown = false;
    renderNotifications();
  } catch (error) {
    if (!notificationErrorShown) showToast(error.message || 'No se pudieron cargar las notificaciones.');
    notificationErrorShown = true;
  }
}

function renderNotifications() {
  const badge = document.getElementById('notificationBadge');
  const list = document.getElementById('notificationList');
  const unreadCount = notifications.filter((notification) => !notification.readAt).length;
  badge.textContent = unreadCount > 99 ? '99+' : String(unreadCount);
  badge.setAttribute('aria-label', `${unreadCount} notificaciones sin leer`);
  badge.classList.toggle('hidden', unreadCount === 0);
  document.getElementById('notificationSummary').textContent = unreadCount
    ? `${unreadCount} sin leer`
    : 'Todo al día';

  const fragment = document.createDocumentFragment();
  if (!notifications.length) {
    const empty = document.createElement('li');
    empty.className = 'notification-empty';
    empty.textContent = 'No tienes notificaciones.';
    fragment.appendChild(empty);
  } else {
    notifications.forEach((notification) => {
      const item = document.createElement('li');
      const button = document.createElement('button');
      button.type = 'button';
      button.className = `notification-item${notification.readAt ? '' : ' is-unread'}`;
      button.dataset.notificationId = String(notification.id);
      button.dataset.ticketId = notification.ticketId;
      const message = document.createElement('span');
      message.className = 'notification-message';
      message.textContent = notification.message;
      const date = document.createElement('time');
      const createdAt = new Date(notification.createdAt);
      date.textContent = Number.isNaN(createdAt.getTime()) ? '' : createdAt.toLocaleString();
      button.append(message, date);
      item.appendChild(button);
      fragment.appendChild(item);
    });
  }
  list.replaceChildren(fragment);
}

async function handleLoginSubmit(event) {
  event.preventDefault();
  const email = document.getElementById('loginEmail').value;
  const password = document.getElementById('loginPassword').value;

  try {
    const user = await auth.login(email, password);
    if (user) {
      await syncAuthState();
      renderBoard();
      showToast(`Bienvenido ${user.fullName}`);
    }
  } catch (error) {
    showToast(error.message || 'No se pudo iniciar sesión');
  }
}

async function handleUserSubmit(event) {
  event.preventDefault();
  const password = document.getElementById('userPassword').value;
  const passwordConfirm = document.getElementById('userPasswordConfirm').value;
  if (password !== passwordConfirm) {
    showToast('Las contraseñas no coinciden.');
    return;
  }

  try {
    await auth.registerUser({
      fullName: document.getElementById('userFullName').value,
      email: document.getElementById('userEmail').value,
      role: document.getElementById('userRole').value,
      password
    });
    await loadUsers();
    modalView.openUsers([...usersMap.values()]);
    showToast('Usuario creado correctamente.');
  } catch (error) {
    showToast(error.message || 'No se pudo crear el usuario.');
  }
}

function renderBoard() {
  if (!boardView) return;

  if (!activeUser) {
    boardEl.innerHTML = '';
    if (calendarView) calendarView.render([], false);
    return;
  }

  const criteria = {
    search: filters.search.value,
    assignedTo: filters.assignedTo.value,
    status: filters.status.value,
    priority: filters.priority.value,
    category: filters.category.value,
    dueFilter: filters.dueFilter.value,
    sortField: filters.sortField.value,
    sortDirection: filters.sortDirection.value
  };

  const visibleTickets = FilterSortService.apply(allTickets, criteria, usersMap);
  boardView.render(visibleTickets);
  updateSlaOverview();
  if (calendarView) {
    calendarView.render(visibleTickets, auth.canAssignOrSetDue(activeUser));
  }
  renderMetrics();
}

function renderMetrics() {
  const start = document.getElementById('metricsStart');
  const end = document.getElementById('metricsEnd');
  if (!start || !end || !start.value || !end.value) return;
  let metrics;
  try {
    metrics = calculateTicketMetrics(allTickets, usersMap, start.value, end.value, satisfactionEntries);
  } catch (error) {
    document.getElementById('agentMetricsBody').replaceChildren();
    const message = error.message || 'El rango de fechas del informe no es válido.';
    document.getElementById('metricsError').textContent = message;
    document.getElementById('metricsError').classList.remove('hidden');
    return null;
  }
  document.getElementById('metricsError').classList.add('hidden');
  document.getElementById('metricCreated').textContent = String(metrics.createdCount);
  document.getElementById('metricResolved').textContent = String(metrics.resolvedCount);
  document.getElementById('metricOpen').textContent = String(metrics.openCount);
  document.getElementById('metricSla').textContent = `${metrics.slaCompliance}%`;
  document.getElementById('metricResolution').textContent = `${metrics.averageResolutionHours} h`;
  document.getElementById('metricSatisfaction').textContent = metrics.averageSatisfaction === null
    ? 'Sin datos'
    : `${metrics.averageSatisfaction} / 5`;
  const body = document.getElementById('agentMetricsBody');
  const rows = metrics.byAgent.map((agent) => {
    const row = document.createElement('tr');
    const name = document.createElement('td');
    const active = document.createElement('td');
    const resolved = document.createElement('td');
    name.textContent = agent.name;
    active.textContent = String(agent.active);
    resolved.textContent = String(agent.resolved);
    row.append(name, active, resolved);
    return row;
  });
  body.replaceChildren(...rows);
  return metrics;
}

function exportMetrics() {
  try {
    const metrics = renderMetrics();
    if (!metrics) return;
    const csv = metricsToCsv(metrics);
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = `vortex-metricas-${document.getElementById('metricsStart').value}-${document.getElementById('metricsEnd').value}.csv`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  } catch (error) {
    showToast(error.message || 'No se pudo exportar el informe.');
  }
}

function updateSlaOverview() {
  const activeTickets = allTickets.filter((ticket) => !['resolved', 'closed'].includes(ticket.status));
  const warningCount = activeTickets.filter((ticket) => ticketService.evaluateSLA(ticket).state === 'warning').length;
  const overdueCount = activeTickets.filter((ticket) => ticketService.evaluateSLA(ticket).state === 'overdue').length;
  document.getElementById('slaActiveCount').textContent = String(activeTickets.length);
  document.getElementById('slaWarningCount').textContent = String(warningCount);
  document.getElementById('slaOverdueCount').textContent = String(overdueCount);
}

function showToast(message, duration = 2200) {
  const toast = document.getElementById('toastNotification');
  toast.textContent = message;
  toast.classList.remove('hidden');
  clearTimeout(showToast.timeoutId);
  showToast.timeoutId = setTimeout(() => toast.classList.add('hidden'), duration);
}

async function syncAuthState() {
  const currentUser = await auth.getCurrentUser();
  const btnNewTicket = document.getElementById('btnNewTicket');
  const btnManageUsers = document.getElementById('btnManageUsers');

  if (currentUser) {
    await Promise.all([loadUsers(currentUser), loadTickets(), loadResponseTemplates(), loadSatisfactionEntries()]);
    activeUser = currentUser;
    await realtimeService.subscribe({
      userId: currentUser.id,
      workspaceId: currentUser.workspaceId,
      getAccessToken: () => auth.getAccessToken()
    });
    await refreshNotificationList();
    modalView.hideLogin();
    btnNewTicket.disabled = false;
    btnNewTicket.style.opacity = '1';
    btnManageUsers.classList.toggle('hidden', !auth.canManageUsers(currentUser));
    document.getElementById('sessionUserName').textContent = currentUser.fullName;
    document.getElementById('sessionUserRole').textContent = currentUser.role;
  } else {
    realtimeService.stop();
    activeUser = null;
    modalView.showLogin();
    btnNewTicket.disabled = true;
    btnNewTicket.style.opacity = '0.5';
    btnManageUsers.classList.add('hidden');
    document.getElementById('sessionUserName').textContent = 'Invitado';
    document.getElementById('sessionUserRole').textContent = 'Sin sesión';
    usersMap.clear();
    allTickets = [];
    notifications = [];
    responseTemplates = [];
    satisfactionEntries = [];
    renderNotifications();
    document.getElementById('notificationBadge').classList.add('hidden');
    document.getElementById('notificationsPanel').classList.add('hidden');
    document.getElementById('btnNotifications').setAttribute('aria-expanded', 'false');
    boardEl.innerHTML = '';
    if (calendarView) calendarView.render([], false);
    populateAssigneeSelect([]);
  }
}

async function loadResponseTemplates() {
  responseTemplates = await ticketService.getResponseTemplates();
}

async function loadSatisfactionEntries() {
  satisfactionEntries = await db.getAllSatisfaction();
}

function handleRealtimeChange() {
  clearTimeout(realtimeRefreshTimeout);
  realtimeRefreshTimeout = setTimeout(async () => {
    if (!activeUser) return;
    try {
      await Promise.all([
        loadTickets(),
        refreshNotificationList(),
        loadResponseTemplates(),
        loadSatisfactionEntries()
      ]);
      renderBoard();
      if (modalView.currentTicketId && !modalEl.classList.contains('hidden')) {
        await loadTicketComments(modalView.currentTicketId);
      }
    } catch (error) {
      showToast(error.message || 'No se pudieron sincronizar los cambios.');
    }
  }, 180);
}

function renderRealtimeStatus(status, error) {
  const statusEl = document.getElementById('realtimeStatus');
  if (!statusEl) return;
  const labels = {
    connecting: 'Conectando…',
    connected: 'En vivo',
    disconnected: 'Reconectando…',
    unavailable: 'Sin conexión en vivo',
    error: 'Error de sincronización'
  };
  statusEl.textContent = labels[status] || 'Sin conexión en vivo';
  statusEl.className = `realtime-status is-${status}`;
  statusEl.title = error?.message || '';
}

async function handleTicketReopen() {
  const ticketId = modalView.currentTicketId;
  if (!ticketId) return;
  try {
    await ticketService.reopenTicket(ticketId);
    await loadTickets();
    modalView.closeTicket();
    renderBoard();
    showToast('Ticket reabierto y movido a Abierto.');
  } catch (error) {
    showToast(error.message || 'No se pudo reabrir el ticket.');
  }
}

function openSatisfactionModal(ticketId) {
  document.getElementById('satisfactionTicketId').value = ticketId;
  document.getElementById('satisfactionForm').reset();
  document.getElementById('satisfactionModal').classList.remove('hidden');
}

function closeSatisfactionModal() {
  document.getElementById('satisfactionModal').classList.add('hidden');
}

async function handleSatisfactionSubmit(event) {
  event.preventDefault();
  const ticketId = document.getElementById('satisfactionTicketId').value;
  const rating = document.querySelector('input[name="satisfactionRating"]:checked')?.value;
  try {
    await ticketService.submitSatisfaction(
      ticketId,
      Number(rating),
      document.getElementById('satisfactionComment').value
    );
    closeSatisfactionModal();
    await Promise.all([refreshNotificationList(), loadSatisfactionEntries()]);
    renderMetrics();
    showToast('Gracias por compartir tu opinión.');
  } catch (error) {
    showToast(error.message || 'No se pudo guardar tu opinión.');
  }
}

async function handleNotificationClick(event) {
  const button = event.target.closest('[data-notification-id]');
  if (!button) return;
  const notification = notifications.find((item) => item.id === Number(button.dataset.notificationId));

  try {
    await ticketService.markNotificationRead(button.dataset.notificationId);
    notifications = notifications.map((item) => item.id === Number(button.dataset.notificationId)
      ? { ...item, readAt: new Date().toISOString() }
      : item);
    renderNotifications();
    document.getElementById('notificationsPanel').classList.add('hidden');
    document.getElementById('btnNotifications').setAttribute('aria-expanded', 'false');
    if (notification?.kind === 'satisfaction_request') {
      openSatisfactionModal(notification.ticketId);
      return;
    }
    await openTicketForEditing(button.dataset.ticketId);
  } catch (error) {
    showToast(error.message || 'No se pudo abrir la notificación.');
  }
}

bootstrap().catch((error) => {
  console.error(error);
  const message = /tickets\.(sla_due_at|sla_warning_at|category)|column .*sla_(due|warning)_at does not exist|category.*tickets|response_templates|ticket_satisfaction/i.test(error.message || '')
    ? 'Falta aplicar una migración pendiente en Supabase. Desde kanban-ticket-management, ejecuta: npx.cmd supabase db push --linked'
    : error.message || 'Error al iniciar la aplicación';
  showToast(message, 10_000);
});

export { db, auth, ticketService };
