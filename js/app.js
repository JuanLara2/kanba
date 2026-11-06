import { SupabaseClient } from './data/supabaseClient.js';
import { SupabaseAdapter } from './data/db.js?v=complexity-scoring-v1';
import { AuthService } from './services/authService.js?v=user-role-management-v1';
import { TicketService } from './services/ticketService.js?v=complexity-scoring-v1';
import { FilterSortService } from './services/filterService.js';
import { BoardView } from './ui/boardView.js?v=ui-polish-v1';
import { ModalView } from './ui/modalView.js?v=complexity-scoring-v1';
import { DragDropController } from './ui/dragDrop.js?v=pointer-grip-v1';
import { CalendarView, dueDateForCalendarDay } from './ui/calendarView.js?v=ui-polish-v1';
import { initializeThemeController } from './ui/themeController.js';
import { PRIORITY_ORDER, SLA_REFRESH_INTERVAL_MS, STATUS_DEFINITIONS } from './config/constants.js';
import { calculateTicketMetrics, metricsToCsv } from './services/metricsService.js?v=metrics-charts-v1';
import { clearMetricsCharts, renderMetricsCharts } from './ui/metricsCharts.js?v=metrics-charts-v1';
import { RealtimeService } from './services/realtimeService.js?v=realtime-protocol-v2';
import { createSplashScreen } from './ui/splashScreen.js';
import { OutboxService } from './services/outboxService.js';
import { MutationDispatcher } from './services/mutationDispatcher.js';
import { Haptics } from './utils/haptics.js?v=haptics-v1';
import './ui/metricsDiagnostics.js?v=metrics-audit-v1';

const splashScreen = createSplashScreen();
const client = new SupabaseClient();
let auth;
const db = new SupabaseAdapter(client, () => auth.getAccessToken());
auth = new AuthService(client, db);
const ticketService = new TicketService(db, auth);
const outbox = new OutboxService();
const mutations = new MutationDispatcher({
  outbox,
  onError: (error) => {
    showToast(error.message || 'No se pudo guardar el cambio.');
    void refreshPendingSyncStatus();
  },
  onQueued: () => {
    showToast('Sin conexión: el cambio quedó guardado para sincronizarse.');
    void refreshPendingSyncStatus();
  },
  onSynced: handleMutationSynced
});
mutations.register('ticket.status.set', {
  execute: (action) => ticketService.changeTicketStatus(action.entityId, action.payload.status),
  applyPending: (ticket, payload) => ({ ...ticket, status: payload.status }),
  onRejected: recoverRejectedMutation
});
mutations.register('ticket.checklist.complete', {
  execute: (action) => ticketService.setChecklistCompletion(
    action.entityId,
    action.payload.index,
    action.payload.text,
    action.payload.completed
  ),
  applyPending: (ticket, payload) => {
    const checklist = (ticket.checklist || []).map((item) => ({ ...item }));
    if (checklist[payload.index]?.text === payload.text) {
      checklist[payload.index].completed = payload.completed;
    }
    return { ...ticket, checklist };
  },
  onRejected: recoverRejectedMutation
});
const boardEl = document.getElementById('kanbanBoard');
const modalEl = document.getElementById('ticketModal');
const form = document.getElementById('ticketForm');
const loginModal = document.getElementById('loginModal');
const loginForm = document.getElementById('loginForm');
const passwordRecoveryForm = document.getElementById('passwordRecoveryForm');
const changePasswordModal = document.getElementById('changePasswordModal');
const changePasswordForm = document.getElementById('changePasswordForm');
const categoriesModal = document.getElementById('categoriesModal');
const categoryForm = document.getElementById('categoryForm');
const usersModal = document.getElementById('usersModal');
const usersForm = document.getElementById('userForm');
const profileModal = document.getElementById('profileModal');
const profileAvatarInput = document.getElementById('profileAvatarInput');
const profileFileName = document.getElementById('profileFileName');
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
let ticketCategories = [];
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
let passwordRecoveryAccessToken = null;
let passwordRecoveryLinkExpired = false;
let mobileStatusTicketId = null;
let mobileActionTicketId = null;
let mobileOverlayStack = [];
let suppressMobileOverlayHistory = false;
let mobileTouchStart = null;
let mobileBoardTouchStart = null;
let mobileCardTouchStart = null;
let mobileSelectionMode = false;
let selectedMobileTicketIds = new Set();
let boardClickSuppressTimeout;
let suppressBoardClick = false;
let lastScrollY = 0;
let recentMobileSearches = [];
let mobileRefreshInProgress = false;
let appShortcutHandled = false;
let lastRealtimeStatus = 'unavailable';
let connectionRecoveryPromise = null;
let categoriesModalPreviousFocus = null;
const realtimeService = new RealtimeService(client, {
  onChange: handleRealtimeChange,
  onStatus: renderRealtimeStatus
});

async function bootstrap() {
  if (document.activeElement instanceof HTMLElement) {
    document.activeElement.blur();
  }
  initializePasswordRecovery();
  splashScreen.setProgress(20, 'Preparando espacio de trabajo...');
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
    onUserSubmit: handleUserSubmit,
    onOverlayOpen: trackMobileOverlayOpen,
    onOverlayClose: trackMobileOverlayClose
  });

  dragDropController = new DragDropController({
    boardEl,
    onStatusChange: dispatchStatusMutation,
    onEditRequest: openTicketForEditing
  });

  calendarView = new CalendarView({
    container: document.getElementById('ticketCalendar'),
    onDateChange: handleCalendarDateChange,
    onTicketClick: openTicketForEditing,
    onCreateForDate: openNewTicketForDate,
    onSearch: focusCalendarSearch,
    onChecklistChange: handleCalendarChecklistToggle,
    onChecklistError: (error) => showToast(error.message || 'No se pudo actualizar la subtarea.'),
    canEditSubtasks: (ticket) => auth.canEditTicket(activeUser, ticket)
  });

  bindStaticEvents();
  const hashView = window.location.hash.slice(1);
  const activeTabId = document.querySelector('.view-tab.is-active')?.id;
  const initialView = hashView === 'metrics'
    ? 'metrics'
    : activeTabId === 'calendarTab'
      ? 'calendar'
      : activeTabId === 'metricsTab'
        ? 'metrics'
        : 'board';
  setActiveView(initialView);
  window.addEventListener('online', handleConnectionRestored);
  window.addEventListener('offline', refreshPendingSyncStatus);
  splashScreen.setProgress(55, 'Sincronizando tareas...');
  await syncAuthState();
  renderMobileFilterChips();
  handleAppShortcut();
  if (passwordRecoveryAccessToken) {
    loginForm.classList.add('hidden');
    passwordRecoveryForm.classList.remove('hidden');
    document.getElementById('recoveryPassword').focus();
  } else if (passwordRecoveryLinkExpired) {
    showToast('El enlace venció o ya fue usado. Solicita uno nuevo desde el inicio de sesión.', 7000);
  }
  splashScreen.setProgress(90, 'Preparando tablero...');
  renderBoard();
  splashScreen.hide();
  window.setInterval(() => {
    if (activeUser) updateSlaOverview();
    if (activeUser && modalEl.classList.contains('hidden') && !boardEl.contains(document.activeElement)) {
      renderBoard();
    }
    if (activeUser) refreshNotificationList();
  }, SLA_REFRESH_INTERVAL_MS);
}

function updateMobileHeaderHeight() {
  const header = document.querySelector('.app-header');
  if (header && isMobileViewport()) {
    document.getElementById('appShell').style.setProperty('--mobile-header-height', `${header.offsetHeight}px`);
  }
}

function initializeMetricsDates() {
  const now = new Date();
  const start = new Date(now.getFullYear(), now.getMonth(), 1);
  const formatDate = (date) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
  document.getElementById('metricsStart').value ||= formatDate(start);
  document.getElementById('metricsEnd').value ||= formatDate(now);
  renderMetrics();
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

async function loadUsers(user = activeUser) {
  const users = await db.getAll('users');
  usersMap.clear();
  users.forEach((user) => usersMap.set(user.id, user));
  populateAssigneeSelect(users, user);
}

async function loadCategories() {
  const user = activeUser;
  if (!user) return;
  const categories = await ticketService.getCategories();
  if (activeUser?.id !== user.id || activeUser?.workspaceId !== user.workspaceId) return;
  ticketCategories = categories;
  renderCategoryOptions();
  if (!categoriesModal.classList.contains('hidden')) renderCategoryManagement();
}

function renderCategoryOptions() {
  const filterCategory = filters.category.value;
  const filterOptions = [new Option('Todas', 'ALL')];
  ticketCategories.forEach((name) => filterOptions.push(new Option(name, name)));
  filters.category.replaceChildren(...filterOptions);
  filters.category.value = ticketCategories.includes(filterCategory) ? filterCategory : 'ALL';

  const formCategory = document.getElementById('formCategory');
  const selectedCategory = formCategory.value;
  if (ticketCategories.length === 0) {
    formCategory.replaceChildren(new Option('No hay categorías configuradas', '', true, true));
    formCategory.disabled = true;
    return;
  }

  formCategory.disabled = false;
  const defaultCategory = ticketCategories.includes('Consulta') ? 'Consulta' : ticketCategories[0];
  formCategory.replaceChildren(...ticketCategories.map((name) => (
    new Option(name, name, name === defaultCategory, name === defaultCategory)
  )));
  formCategory.value = ticketCategories.includes(selectedCategory) ? selectedCategory : defaultCategory;
}

function renderCategoryManagement() {
  const list = document.getElementById('categoryList');
  if (!list) return;
  const categoryCounts = new Map();
  allTickets.forEach((ticket) => {
    categoryCounts.set(ticket.category, (categoryCounts.get(ticket.category) || 0) + 1);
  });

  list.replaceChildren(...ticketCategories.map((name) => {
    const item = document.createElement('li');
    const details = document.createElement('div');
    const label = document.createElement('span');
    const usage = document.createElement('span');
    const deleteButton = document.createElement('button');
    const count = categoryCounts.get(name) || 0;

    label.className = 'category-list-name';
    label.textContent = name;
    usage.className = 'category-list-usage';
    usage.textContent = `${count} ${count === 1 ? 'ticket' : 'tickets'}`;
    details.append(label, usage);
    deleteButton.className = 'btn btn-danger';
    deleteButton.type = 'button';
    deleteButton.dataset.deleteCategory = name;
    deleteButton.textContent = 'Eliminar';
    deleteButton.setAttribute('aria-label', `Eliminar categoría ${name}`);
    deleteButton.disabled = count > 0 || ticketCategories.length <= 1;
    deleteButton.title = count > 0
      ? 'Reasigna los tickets antes de eliminar esta categoría'
      : ticketCategories.length <= 1
        ? 'Debe permanecer al menos una categoría'
        : `Eliminar ${name}`;
    item.append(details, deleteButton);
    return item;
  }));
}

async function openCategoriesModal() {
  if (!auth.canManageCategories(activeUser)) {
    showToast('Solo un administrador puede administrar categorías.');
    return;
  }
  try {
    await loadCategories();
    if (!auth.canManageCategories(activeUser)) return;
    categoriesModalPreviousFocus = document.activeElement;
    categoriesModal.classList.remove('hidden');
    renderCategoryManagement();
    trackMobileOverlayOpen('categories');
    document.getElementById('categoryName').focus();
  } catch (error) {
    showToast(error.message || 'No se pudieron cargar las categorías.');
  }
}

function closeCategoriesModal() {
  const wasOpen = !categoriesModal.classList.contains('hidden');
  categoriesModal.classList.add('hidden');
  if (wasOpen) trackMobileOverlayClose('categories');
  categoryForm.reset();
  if (wasOpen) categoriesModalPreviousFocus?.focus();
}

async function handleCategorySubmit(event) {
  event.preventDefault();
  const submitButton = categoryForm.querySelector('[type="submit"]');
  submitButton.disabled = true;
  try {
    await ticketService.addCategory(document.getElementById('categoryName').value);
    categoryForm.reset();
    await loadCategories();
    showToast('Categoría agregada para todo el equipo.');
  } catch (error) {
    showToast(error.message || 'No se pudo agregar la categoría.');
  } finally {
    submitButton.disabled = false;
  }
}

async function handleCategoryListClick(event) {
  const button = event.target.closest('[data-delete-category]');
  if (!button || button.disabled) return;
  const name = button.dataset.deleteCategory;
  if (!window.confirm(`¿Eliminar la categoría "${name}"? Esta acción no se puede deshacer.`)) return;
  button.disabled = true;
  try {
    await ticketService.deleteCategory(name);
    await loadCategories();
    showToast('Categoría eliminada.');
  } catch (error) {
    showToast(error.message || 'No se pudo eliminar la categoría.');
    button.disabled = false;
  }
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
  const tickets = await ticketService.getAllTickets();
  try {
    allTickets = await mutations.applyPending(tickets);
  } catch (error) {
    allTickets = tickets;
    showToast(error.message || 'No se pudo consultar la cola de acciones offline.');
  }
}

function initializePasswordRecovery() {
  const recoveryParams = new URLSearchParams(window.location.hash.slice(1));
  const recoveryType = recoveryParams.get('type');
  const accessToken = recoveryParams.get('access_token');
  const hasRecoveryError = recoveryParams.has('error') || recoveryParams.has('error_code');

  if (recoveryType === 'recovery' && accessToken) {
    passwordRecoveryAccessToken = accessToken;
    auth.clearSession();
  } else if (hasRecoveryError) {
    passwordRecoveryLinkExpired = true;
    auth.clearSession();
  } else {
    return;
  }

  window.history.replaceState(null, document.title, `${window.location.pathname}${window.location.search}`);
}

async function handleForgotPassword() {
  const emailInput = document.getElementById('loginEmail');
  const email = emailInput.value.trim();
  if (!email || !emailInput.checkValidity()) {
    showToast('Ingresa un correo válido para enviarte el enlace.');
    emailInput.focus();
    return;
  }

  const redirectTo = new URL(window.location.pathname, window.location.origin).href;
  try {
    await auth.requestPasswordReset(email, redirectTo);
    showToast('Si existe una cuenta con ese correo, recibirás un enlace para restablecer la contraseña.', 7000);
  } catch (error) {
    showToast(error.message || 'No se pudo enviar el enlace de recuperación.', 7000);
  }
}

async function handlePasswordRecoverySubmit(event) {
  event.preventDefault();
  const password = document.getElementById('recoveryPassword').value;
  const confirmation = document.getElementById('recoveryPasswordConfirm').value;
  if (password !== confirmation) {
    showToast('Las contraseñas no coinciden.');
    return;
  }

  try {
    await auth.updatePassword(password, passwordRecoveryAccessToken);
    passwordRecoveryAccessToken = null;
    passwordRecoveryForm.reset();
    passwordRecoveryForm.classList.add('hidden');
    loginForm.reset();
    loginForm.classList.remove('hidden');
    document.getElementById('loginEmail').focus();
    showToast('Contraseña actualizada. Ya puedes iniciar sesión.', 6000);
  } catch (error) {
    showToast(error.message || 'No se pudo actualizar la contraseña.', 7000);
  }
}

function closeChangePasswordModal() {
  const wasOpen = !changePasswordModal.classList.contains('hidden');
  changePasswordModal.classList.add('hidden');
  if (wasOpen) trackMobileOverlayClose('password');
  changePasswordForm.reset();
}

async function handleChangePasswordSubmit(event) {
  event.preventDefault();
  const password = document.getElementById('newAccountPassword').value;
  const confirmation = document.getElementById('confirmAccountPassword').value;
  if (password !== confirmation) {
    showToast('Las contraseñas no coinciden.');
    return;
  }

  try {
    await auth.updatePassword(password);
    closeChangePasswordModal();
    showToast('Contraseña actualizada correctamente.');
  } catch (error) {
    showToast(error.message || 'No se pudo actualizar la contraseña.', 7000);
  }
}

function renderAvatarFallback(element, user, fallback = 'U') {
  const target = element;
  if (!target) return;
  target.replaceChildren();
  const initials = user?.fullName ? user.fullName.trim().split(/\s+/).slice(0, 2).map((part) => part[0]).join('').toUpperCase() : fallback;
  if (user?.avatarUrl) {
    const image = document.createElement('img');
    image.alt = '';
    image.loading = 'lazy';
    image.addEventListener('error', () => {
      if (image.parentElement !== target) return;
      target.replaceChildren();
      target.textContent = initials || fallback;
    }, { once: true });
    image.src = user.avatarUrl;
    target.appendChild(image);
    return;
  }
  target.textContent = initials || fallback;
}

function renderProfileSummary(user = activeUser) {
  const preview = document.getElementById('profileAvatarPreview');
  const name = document.getElementById('profileUserName');
  const email = document.getElementById('profileUserEmail');
  const role = document.getElementById('profileUserRole');

  renderAvatarFallback(preview, user, 'U');
  renderHeaderUser(user);
  if (name) name.textContent = user?.fullName || 'Sin nombre';
  if (email) email.textContent = user?.email || 'Sin correo';
  if (role) role.textContent = user?.role || 'Sin rol';
}

function renderHeaderUser(user) {
  const firstName = user?.fullName?.trim().split(/\s+/)[0] || '';
  const firstNameElement = document.getElementById('headerFirstName');
  const roleElement = document.getElementById('headerRoleBadge');
  const avatarElement = document.getElementById('headerUserAvatar');
  if (firstNameElement) firstNameElement.textContent = firstName;
  if (roleElement) roleElement.textContent = user?.role?.toUpperCase() || '';
  renderAvatarFallback(avatarElement, user, 'U');
}

function initPasswordToggle() {
  const toggleButton = document.getElementById('btnTogglePassword');
  const passwordInput = document.getElementById('passwordInput');
  const eyeOpen = document.getElementById('iconEyeOpen');
  const eyeClosed = document.getElementById('iconEyeClosed');
  if (!toggleButton || !passwordInput || !eyeOpen || !eyeClosed) return;

  toggleButton.addEventListener('click', () => {
    const showPassword = passwordInput.type === 'password';
    passwordInput.type = showPassword ? 'text' : 'password';
    eyeOpen.classList.toggle('hidden', showPassword);
    eyeClosed.classList.toggle('hidden', !showPassword);
    toggleButton.setAttribute('aria-label', showPassword ? 'Ocultar contraseña' : 'Mostrar contraseña');
    toggleButton.setAttribute('aria-pressed', String(showPassword));
    passwordInput.focus();
  });
}

function setProfileMenuOpen(isOpen, restoreFocus = false) {
  const trigger = document.getElementById('btnUserProfile');
  const panel = document.getElementById('profileMenuPanel');
  if (!trigger || !panel) return;
  panel.classList.toggle('hidden', !isOpen);
  trigger.setAttribute('aria-expanded', String(isOpen));
  if (!isOpen && restoreFocus) trigger.focus();
}

function toggleProfileMenu() {
  const trigger = document.getElementById('btnUserProfile');
  if (!trigger) return;
  const isOpen = trigger.getAttribute('aria-expanded') === 'true';
  setProfileMenuOpen(!isOpen);
}

function openProfileModal() {
  if (!activeUser) return;
  renderProfileSummary(activeUser);
  profileModal.classList.remove('hidden');
  trackMobileOverlayOpen('profile');
  profileAvatarInput.value = '';
  profileFileName.textContent = 'Ningún archivo seleccionado';
  const avatarStatus = document.getElementById('profileAvatarStatus');
  avatarStatus.textContent = '';
  avatarStatus.classList.remove('is-error');
  document.getElementById('profileCloseBtn').focus();
}

function closeProfileModal(trackOverlay = true) {
  const wasOpen = !profileModal.classList.contains('hidden');
  profileModal.classList.add('hidden');
  if (wasOpen && trackOverlay) trackMobileOverlayClose('profile');
  if (profileAvatarInput) {
    profileAvatarInput.value = '';
    if (profileFileName) profileFileName.textContent = 'Ningún archivo seleccionado';
  }
}

async function handleProfileAvatarUpload() {
  const user = activeUser || await auth.getCurrentUser();
  if (!user) {
    showToast('Debes iniciar sesión antes de subir tu avatar.');
    return;
  }

  const file = profileAvatarInput.files?.[0];
  if (!file) {
    showToast('Selecciona una imagen para tu avatar.');
    return;
  }
  if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type)) {
    showToast('Solo se aceptan imágenes JPG, PNG o WEBP.');
    return;
  }
  if (file.size > 2 * 1024 * 1024) {
    showToast('La imagen debe pesar menos de 2 MB.');
    return;
  }

  const token = await auth.getAccessToken();
  if (!token) {
    showToast('Tu sesión no está activa. Inicia sesión otra vez.');
    return;
  }

  const avatarStatus = document.getElementById('profileAvatarStatus');
  avatarStatus.classList.remove('is-error');
  avatarStatus.textContent = 'Guardando la foto de perfil…';
  const extension = file.name.includes('.') ? file.name.split('.').pop() || 'png' : 'png';
  const blobName = `${Date.now()}-${Math.random().toString(36).slice(2, 9)}.${extension}`;
  const objectPath = `${user.id}/${blobName}`;
  const encodedPath = objectPath.split('/').map((segment) => encodeURIComponent(segment)).join('/');
  const storageUrl = `${client.url}/storage/v1/object/profile-avatars/${encodedPath}`;

  try {
    const uploadResponse = await fetch(storageUrl, {
      method: 'POST',
      headers: {
        apikey: client.anonKey,
        Authorization: `Bearer ${token}`,
        'Content-Type': file.type || 'application/octet-stream',
      },
      body: file
    });

    if (!uploadResponse.ok) {
      const errorText = await uploadResponse.text();
      if (uploadResponse.status === 403 && errorText.includes('row-level security')) {
        throw new Error('Supabase rechazó la carga del avatar por permisos RLS. Aplica la migración 20261103000000_profile_avatar_support.sql en el proyecto configurado y vuelve a iniciar sesión.');
      }
      throw new Error(errorText || 'No se pudo subir la imagen del avatar.');
    }

    const updatedUser = await client.requestRest(`profiles?id=eq.${encodeURIComponent(user.id)}`, {
      method: 'PATCH',
      accessToken: token,
      body: { avatar_path: objectPath }
    });

    const refreshedUser = await auth.loadProfile(user.id, token);
    activeUser = refreshedUser || { ...user, avatarPath: objectPath, avatarUrl: `${client.url}/storage/v1/object/public/profile-avatars/${encodedPath}` };
    auth.currentUser = activeUser;
    usersMap.set(activeUser.id, activeUser);
    renderProfileSummary(activeUser);
    renderBoard();
    avatarStatus.textContent = 'Foto de perfil actualizada correctamente.';
    showToast('Avatar actualizado correctamente.');
    profileAvatarInput.value = '';
    profileFileName.textContent = 'Ningún archivo seleccionado';
    if (Array.isArray(updatedUser) && updatedUser.length === 0) {
      showToast('El perfil se actualizó, pero no se devolvió confirmación del servidor.', 5000);
    }
  } catch (error) {
    avatarStatus.classList.add('is-error');
    avatarStatus.textContent = error.message || 'No se pudo guardar tu avatar.';
    showToast(error.message || 'No se pudo guardar tu avatar.', 7000);
  }
}

async function handleProfileAvatarRemoval() {
  const user = activeUser || await auth.getCurrentUser();
  if (!user) {
    showToast('Debes iniciar sesión antes de eliminar tu avatar.');
    return;
  }
  if (!user.avatarPath) {
    showToast('Todavía no tienes un avatar para eliminar.');
    return;
  }

  const token = await auth.getAccessToken();
  if (!token) {
    showToast('Tu sesión no está activa. Inicia sesión otra vez.');
    return;
  }

  const encodedPath = user.avatarPath.split('/').map((segment) => encodeURIComponent(segment)).join('/');
  const storageUrl = `${client.url}/storage/v1/object/profile-avatars/${encodedPath}`;

  try {
    const deleteResponse = await fetch(storageUrl, {
      method: 'DELETE',
      headers: {
        apikey: client.anonKey,
        Authorization: `Bearer ${token}`
      }
    });

    if (!deleteResponse.ok) {
      const errorText = await deleteResponse.text();
      throw new Error(errorText || 'No se pudo borrar la imagen del avatar.');
    }

    await client.requestRest(`profiles?id=eq.${encodeURIComponent(user.id)}`, {
      method: 'PATCH',
      accessToken: token,
      body: { avatar_path: null }
    });

    const refreshedUser = await auth.loadProfile(user.id, token);
    activeUser = refreshedUser || { ...user, avatarPath: null, avatarUrl: null };
    auth.currentUser = activeUser;
    usersMap.set(activeUser.id, activeUser);
    renderProfileSummary(activeUser);
    renderBoard();
    showToast('Avatar eliminado.');
    profileFileName.textContent = 'Ningún archivo seleccionado';
  } catch (error) {
    showToast(error.message || 'No se pudo eliminar el avatar.', 7000);
  }
}

function bindStaticEvents() {
  initPasswordToggle();
  const userRoleSelect = document.getElementById('userRole');
  userRoleSelect?.addEventListener('change', updateUserRoleDescription);
  const createWorkspaceCheckbox = document.getElementById('userCreateWorkspace');
  createWorkspaceCheckbox?.addEventListener('change', syncNewWorkspaceForm);
  usersForm?.addEventListener('reset', () => {
    setTimeout(syncNewWorkspaceForm, 0);
  });
  syncNewWorkspaceForm();
  updateUserRoleDescription();
  document.getElementById('btnManageCategories')?.addEventListener('click', () => {
    setProfileMenuOpen(false);
    openCategoriesModal();
  });
  document.getElementById('categoriesModalCloseBtn')?.addEventListener('click', closeCategoriesModal);
  document.getElementById('categoriesModalCancelBtn')?.addEventListener('click', closeCategoriesModal);
  categoriesModal?.addEventListener('click', (event) => {
    if (event.target === categoriesModal) closeCategoriesModal();
  });
  categoriesModal?.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      closeCategoriesModal();
      return;
    }
    if (event.key !== 'Tab') return;
    const focusable = [...categoriesModal.querySelectorAll('button:not(:disabled), input:not(:disabled)')];
    if (focusable.length === 0) return;
    if (event.shiftKey && document.activeElement === focusable[0]) {
      event.preventDefault();
      focusable.at(-1).focus();
    } else if (!event.shiftKey && document.activeElement === focusable.at(-1)) {
      event.preventDefault();
      focusable[0].focus();
    }
  });
  categoryForm?.addEventListener('submit', handleCategorySubmit);
  document.getElementById('categoryList')?.addEventListener('click', handleCategoryListClick);
  document.getElementById('btnRetrySync')?.addEventListener('click', () => {
    void handleConnectionRestored();
  });
  document.getElementById('btnForgotPassword')?.addEventListener('click', handleForgotPassword);
  passwordRecoveryForm?.addEventListener('submit', handlePasswordRecoverySubmit);
  document.getElementById('btnUserProfile')?.addEventListener('click', toggleProfileMenu);
  document.getElementById('btnProfileMenuOpenProfile')?.addEventListener('click', () => {
    setProfileMenuOpen(false);
    openProfileModal();
  });
  document.getElementById('profileMenu')?.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      setProfileMenuOpen(false, true);
      return;
    }
    if (event.key !== 'Tab') return;
    const focusable = [...document.querySelectorAll('#profileMenuPanel button:not(:disabled), #profileMenuPanel select:not(:disabled)')]
      .filter((element) => !element.closest('.hidden'));
    if (event.shiftKey && focusable[0] === document.activeElement) {
      setProfileMenuOpen(false);
      return;
    }
    if (focusable.at(-1) === document.activeElement) setProfileMenuOpen(false);
  });
  document.addEventListener('pointerdown', (event) => {
    const profileMenu = document.getElementById('profileMenu');
    const profileTrigger = document.getElementById('btnUserProfile');
    const isOpen = profileTrigger?.getAttribute('aria-expanded') === 'true';
    if (!isOpen || !profileMenu || profileMenu.contains(event.target)) return;
    setProfileMenuOpen(false);
  });
  document.getElementById('profileCloseBtn')?.addEventListener('click', closeProfileModal);
  document.getElementById('profileCancelBtn')?.addEventListener('click', closeProfileModal);
  document.getElementById('profileUploadBtn')?.addEventListener('click', handleProfileAvatarUpload);
  document.getElementById('profileRemoveAvatarBtn')?.addEventListener('click', handleProfileAvatarRemoval);
  profileAvatarInput?.addEventListener('change', () => {
    const file = profileAvatarInput.files?.[0];
    if (profileFileName) profileFileName.textContent = file ? file.name : 'Ningún archivo seleccionado';
    const avatarStatus = document.getElementById('profileAvatarStatus');
    if (!avatarStatus) return;
    if (!file) {
      avatarStatus.textContent = '';
      avatarStatus.classList.remove('is-error');
      return;
    }
    avatarStatus.classList.remove('is-error');
    avatarStatus.textContent = 'Vista previa lista. Pulsa «Guardar avatar» para confirmar el cambio.';
    const reader = new FileReader();
    reader.onload = () => {
      const preview = document.getElementById('profileAvatarPreview');
      if (!preview) return;
      preview.replaceChildren();
      const image = document.createElement('img');
      image.src = String(reader.result || '');
      image.alt = '';
      preview.appendChild(image);
    };
    reader.readAsDataURL(file);
  });
  document.getElementById('btnChangePassword')?.addEventListener('click', () => {
    setProfileMenuOpen(false);
    changePasswordModal.classList.remove('hidden');
    trackMobileOverlayOpen('password');
    document.getElementById('newAccountPassword').focus();
  });
  document.getElementById('profileChangePasswordBtn')?.addEventListener('click', () => {
    closeProfileModal();
    changePasswordModal.classList.remove('hidden');
    trackMobileOverlayOpen('password');
    document.getElementById('newAccountPassword').focus();
  });
  document.getElementById('changePasswordCloseBtn')?.addEventListener('click', closeChangePasswordModal);
  document.getElementById('changePasswordCancelBtn')?.addEventListener('click', closeChangePasswordModal);
  changePasswordForm?.addEventListener('submit', handleChangePasswordSubmit);
  document.getElementById('boardTab').addEventListener('click', () => navigateBottomTab('board'));
  document.getElementById('calendarTab').addEventListener('click', () => navigateBottomTab('calendar'));
  document.getElementById('metricsTab').addEventListener('click', () => navigateBottomTab('metrics'));
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
    if (tabs[nextIndex] !== tabs[currentIndex]) Haptics.tabSwitch();
    setActiveView(resolvedView);
    tabs[nextIndex].focus();
  });
  document.getElementById('btnNewTicket')?.addEventListener('click', openNewTicketModal);
  document.getElementById('profileManageUsersBtn')?.addEventListener('click', async () => {
    const user = activeUser || await auth.getCurrentUser();
    if (!auth.canManageUsers(user)) {
      showToast('Solo un administrador puede administrar usuarios.');
      return;
    }
    const overlayReplaced = replaceMobileOverlay('profile', 'users');
    closeProfileModal(!overlayReplaced);
    modalView.openUsers([...usersMap.values()], user.id);
  });
  document.getElementById('usersModal').addEventListener('change', (event) => {
    const select = event.target.closest('[data-user-role-id]');
    if (!select) return;
    const saveButton = select.closest('li')?.querySelector('[data-update-user-role]');
    if (saveButton) saveButton.disabled = select.value === usersMap.get(select.dataset.userRoleId)?.role;
  });
  document.getElementById('usersModal').addEventListener('click', handleUserRoleUpdate);
  document.getElementById('usersModalCloseBtn').addEventListener('click', () => modalView.closeUsers());
  document.getElementById('usersModalCancelBtn').addEventListener('click', () => modalView.closeUsers());
  document.getElementById('btnNotifications')?.addEventListener('click', () => {
    const panel = document.getElementById('notificationsPanel');
    if (!panel) return;
    const isOpen = panel.classList.toggle('hidden') === false;
    document.getElementById('btnNotifications')?.setAttribute('aria-expanded', String(isOpen));
    if (isOpen) trackMobileOverlayOpen('notifications');
    else trackMobileOverlayClose('notifications');
    if (isOpen) refreshNotificationList();
  });
  document.getElementById('metricsStart').addEventListener('change', renderMetrics);
  document.getElementById('metricsEnd').addEventListener('change', renderMetrics);
  document.getElementById('metricsGrouping').addEventListener('change', renderMetrics);
  document.getElementById('btnExportMetrics').addEventListener('click', exportMetrics);
  document.getElementById('btnReopenTicket').addEventListener('click', handleTicketReopen);
  document.getElementById('satisfactionCloseBtn').addEventListener('click', closeSatisfactionModal);
  document.getElementById('satisfactionCancelBtn').addEventListener('click', closeSatisfactionModal);
  document.getElementById('satisfactionForm').addEventListener('submit', handleSatisfactionSubmit);
  document.getElementById('btnStartBatchSelection').addEventListener('click', () => {
    if (mobileSelectionMode) exitMobileSelection();
    else startMobileSelection();
  });
  document.getElementById('btnExitBatchSelection').addEventListener('click', exitMobileSelection);
  document.getElementById('btnMobileBatchMove').addEventListener('click', () => {
    applyMobileBatchStatus(document.getElementById('mobileBatchStatus').value);
  });
  document.getElementById('btnMobileBatchClose').addEventListener('click', () => applyMobileBatchStatus('closed'));
  document.getElementById('btnMobileBatchAssign').addEventListener('click', applyMobileBatchAssignee);
  document.getElementById('mobileBatchStatus').addEventListener('change', renderMobileBatchToolbar);
  document.getElementById('mobileBatchAssignee').addEventListener('change', renderMobileBatchToolbar);
  document.getElementById('mobileBatchToolbar').addEventListener('keydown', handleMobileBatchKeydown);
  document.getElementById('mobileTicketActionsBackdrop').addEventListener('click', closeMobileTicketActions);
  document.getElementById('btnCloseMobileTicketActions').addEventListener('click', closeMobileTicketActions);
  document.getElementById('mobileTicketActionsSheet').addEventListener('keydown', handleBottomSheetKeydown);
  document.getElementById('btnSaveMobileTicketActions').addEventListener('click', saveMobileTicketActions);
  document.getElementById('btnDeleteMobileTicket').addEventListener('click', deleteMobileTicket);
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
    if (checkbox) {
      handleChecklistToggle(Number(checkbox.dataset.checklistComplete), checkbox.checked);
    }
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
      Haptics.destructive();
      await loadTickets();
      modalView.closeTicket();
      renderBoard();
      showToast('Ticket eliminado correctamente');
    } catch (error) {
      showToast(error.message || 'No se pudo eliminar el ticket');
    }
  });
  document.getElementById('btnLogout')?.addEventListener('click', async () => {
    closeProfileModal();
    setProfileMenuOpen(false);

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
    input.addEventListener('change', () => {
      if (input === filters.status && input.value !== 'ALL') boardView.setActiveStatus(input.value);
      renderBoard();
    });
  });

  boardEl.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    if (event.target.closest('button, a, input, select, textarea')) return;
    const card = event.target.closest('.ticket-card');
    if (!card) return;
    event.preventDefault();
    if (mobileSelectionMode) {
      toggleMobileTicketSelection(card.dataset.ticketId);
      return;
    }
    dragDropController.onEditRequest(card.dataset.ticketId);
  });
  boardEl.addEventListener('click', (event) => {
    const target = event.target instanceof Element ? event.target : null;
    const selectionButton = target?.closest('[data-select-ticket]');
    if (selectionButton) {
      event.preventDefault();
      event.stopImmediatePropagation();
      toggleMobileTicketSelection(selectionButton.dataset.selectTicket);
      return;
    }
    if (mobileSelectionMode) {
      const card = target?.closest('.ticket-card');
      if (card && !target.closest('button, a, input, select, textarea')) {
        event.preventDefault();
        event.stopImmediatePropagation();
        toggleMobileTicketSelection(card.dataset.ticketId);
        return;
      }
    }
    if (!suppressBoardClick) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    suppressBoardClick = false;
    window.clearTimeout(boardClickSuppressTimeout);
  }, true);

  document.getElementById('mobileStatusTabs').addEventListener('click', (event) => {
    const tab = event.target.closest('.mobile-status-tab');
    if (!tab) return;
    filters.status.value = 'ALL';
    boardView.setActiveStatus(tab.dataset.status);
    renderBoard();
  });
  document.getElementById('btnOpenMobileFilters').addEventListener('click', openMobileFilters);
  document.getElementById('btnCloseMobileFilters').addEventListener('click', closeMobileFilters);
  document.getElementById('mobileFiltersBackdrop').addEventListener('click', closeMobileFilters);
  document.getElementById('btnApplyMobileFilters').addEventListener('click', closeMobileFilters);
  document.getElementById('btnClearMobileFilters').addEventListener('click', clearFilters);
  filters.search.addEventListener('click', openMobileSearch);
  document.getElementById('btnCloseMobileSearch').addEventListener('click', closeMobileSearch);
  document.getElementById('mobileSearchForm').addEventListener('submit', handleMobileSearchSubmit);
  document.getElementById('mobileSearchInput').addEventListener('input', (event) => {
    filters.search.value = event.target.value;
    renderBoard();
    renderMobileSearchResults();
  });
  document.getElementById('mobileSearchLayer').addEventListener('click', handleMobileQuickFilter);
  document.getElementById('mobileSearchResults').addEventListener('click', handleMobileSearchResult);
  document.getElementById('mobileRecentSearches').addEventListener('click', handleRecentSearchClick);
  document.getElementById('mobileSearchLayer').addEventListener('keydown', handleBottomSheetKeydown);
  document.getElementById('mobileActiveFilters').addEventListener('click', removeMobileFilterChip);
  document.getElementById('ticketStatusBackdrop').addEventListener('click', closeMobileStatusSheet);
  document.getElementById('btnCloseTicketStatus').addEventListener('click', closeMobileStatusSheet);
  document.getElementById('ticketStatusOptions').addEventListener('click', handleMobileStatusSelection);
  boardEl.addEventListener('click', (event) => {
    const target = event.target instanceof Element ? event.target : event.target?.parentElement;
    const button = target?.closest('.btn-change-status');
    if (!button) return;
    event.stopPropagation();
    openMobileStatusSheet(button.dataset.ticketId, button);
  });
  [document.getElementById('mobileFiltersSheet'), document.getElementById('ticketStatusSheet')].forEach((sheet) => {
    sheet.addEventListener('keydown', handleBottomSheetKeydown);
  });
  boardEl.addEventListener('touchstart', handleMobileBoardTouchStart, { passive: true });
  boardEl.addEventListener('touchend', handleMobileBoardTouchEnd, { passive: false });
  boardEl.addEventListener('touchstart', handleMobileCardTouchStart, { passive: true });
  boardEl.addEventListener('touchmove', handleMobileCardTouchMove, { passive: true });
  boardEl.addEventListener('touchend', handleMobileCardTouchEnd, { passive: false });
  boardEl.addEventListener('touchcancel', clearMobileCardTouch);
  window.addEventListener('touchstart', handleMobilePullStart, { passive: true });
  window.addEventListener('touchend', handleMobilePullEnd, { passive: false });
  window.addEventListener('scroll', handleMobileScroll, { passive: true });
  window.addEventListener('resize', updateMobileHeaderHeight, { passive: true });
  window.addEventListener('popstate', handleMobilePopState);
  window.addEventListener('keydown', handleGlobalEscape, true);
  window.addEventListener('pageshow', handleAppShortcut);
  lastScrollY = window.scrollY;
}

function navigateBottomTab(view) {
  const activeTab = document.querySelector('.view-tab.is-active');
  if (activeTab?.id === `${view}Tab`) {
    window.scrollTo({ top: 0, behavior: 'smooth' });
    return;
  }
  Haptics.tabSwitch();
  setActiveView(view);
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

async function openNewTicketModal() {
  const user = await auth.getCurrentUser();
  modalView.openTicket(null, {
    canManageAssignment: auth.canAssignOrSetDue(user),
    canManageChecklist: auth.canAssignOrSetDue(user),
    canManageComplexity: auth.canAssignOrSetDue(user)
  });
}

async function openNewTicketForDate(dateKey) {
  await openNewTicketModal();
  const date = dueDateForCalendarDay(new Date(`${dateKey}T12:00:00`));
  document.getElementById('formDueDate').value = modalView.toLocalDateTime(date);
}

function focusCalendarSearch() {
  if (isMobileViewport()) {
    openMobileSearch();
    return;
  }
  filters.search.focus();
}

function handleAppShortcut() {
  if (appShortcutHandled || !activeUser) return;
  const action = new URLSearchParams(window.location.search).get('action');
  if (!['create-ticket', 'urgent-tickets'].includes(action)) return;
  appShortcutHandled = true;
  window.history.replaceState(window.history.state, '', `${window.location.pathname}${window.location.hash}`);
  if (action === 'create-ticket') {
    openNewTicketModal();
    return;
  }
  filters.priority.value = 'Urgente';
  filters.status.value = 'ALL';
  setActiveView('board');
  renderBoard();
  selectFirstVisibleStatus();
  showToast('Mostrando tickets de prioridad urgente.');
}

function selectFirstVisibleStatus() {
  const criteria = {
    search: filters.search.value,
    assignedTo: filters.assignedTo.value,
    status: 'ALL',
    priority: filters.priority.value,
    category: filters.category.value,
    dueFilter: filters.dueFilter.value,
    sortField: filters.sortField.value,
    sortDirection: filters.sortDirection.value
  };
  const visibleTickets = FilterSortService.apply(allTickets, criteria, usersMap);
  const nextStatus = Object.keys(STATUS_DEFINITIONS).find((status) => visibleTickets.some((ticket) => ticket.status === status));
  if (nextStatus) boardView.setActiveStatus(nextStatus);
}

function isMobileViewport() {
  return window.matchMedia('(max-width: 768px)').matches;
}

function trackMobileOverlayOpen(id) {
  if (!isMobileViewport() || mobileOverlayStack.at(-1) === id) return;
  window.history.pushState({ ...(window.history.state || {}), mobileOverlay: id }, '');
  mobileOverlayStack.push(id);
}

function replaceMobileOverlay(from, to) {
  if (!isMobileViewport() || mobileOverlayStack.at(-1) !== from) return false;
  mobileOverlayStack[mobileOverlayStack.length - 1] = to;
  window.history.replaceState({ ...(window.history.state || {}), mobileOverlay: to }, '');
  return true;
}

function trackMobileOverlayClose(id) {
  if (!isMobileViewport()) return;
  if (suppressMobileOverlayHistory) {
    if (mobileOverlayStack.at(-1) === id) mobileOverlayStack.pop();
    return;
  }
  if (mobileOverlayStack.at(-1) === id && window.history.state?.mobileOverlay === id) {
    window.history.back();
  } else {
    mobileOverlayStack = mobileOverlayStack.filter((overlayId) => overlayId !== id);
  }
}

function closeMobileOverlay(id) {
  const closers = {
    ticket: () => modalView.closeTicket(),
    users: () => modalView.closeUsers(),
    profile: closeProfileModal,
    categories: closeCategoriesModal,
    password: closeChangePasswordModal,
    satisfaction: closeSatisfactionModal,
    filters: closeMobileFilters,
    status: closeMobileStatusSheet,
    search: closeMobileSearch,
    'quick-actions': closeMobileTicketActions,
    notifications: () => {
      document.getElementById('notificationsPanel').classList.add('hidden');
      document.getElementById('btnNotifications').setAttribute('aria-expanded', 'false');
      trackMobileOverlayClose('notifications');
    }
  };
  closers[id]?.();
}

function handleMobilePopState(event) {
  if (!isMobileViewport()) return;
  const currentOverlay = mobileOverlayStack.at(-1);
  if (!currentOverlay || event.state?.mobileOverlay === currentOverlay) return;
  suppressMobileOverlayHistory = true;
  closeMobileOverlay(currentOverlay);
  suppressMobileOverlayHistory = false;
}

function handleGlobalEscape(event) {
  if (!isMobileViewport() || event.key !== 'Escape') return;
  const overlayId = mobileOverlayStack.at(-1);
  if (!overlayId) return;
  event.preventDefault();
  event.stopPropagation();
  closeMobileOverlay(overlayId);
}

function handleMobileBoardTouchStart(event) {
  if (!isMobileViewport() || event.touches.length !== 1) return;
  if (event.target.closest?.('.ticket-card')) {
    mobileBoardTouchStart = null;
    return;
  }
  mobileBoardTouchStart = {
    x: event.touches[0].clientX,
    y: event.touches[0].clientY,
    target: event.target
  };
}

function handleMobileBoardTouchEnd(event) {
  if (mobileBoardTouchStart?.target.closest?.('.ticket-card')) {
    mobileBoardTouchStart = null;
    return;
  }
  if (!mobileBoardTouchStart || !isMobileViewport() || event.changedTouches.length !== 1) {
    mobileBoardTouchStart = null;
    return;
  }
  const deltaX = event.changedTouches[0].clientX - mobileBoardTouchStart.x;
  const deltaY = event.changedTouches[0].clientY - mobileBoardTouchStart.y;
  const startedOnControl = mobileBoardTouchStart.target.closest?.('button, a, input, select, textarea');
  mobileBoardTouchStart = null;
  if (startedOnControl || Math.abs(deltaX) < 60 || Math.abs(deltaX) < Math.abs(deltaY) * 1.3) return;

  const statusIds = Object.keys(STATUS_DEFINITIONS);
  const currentIndex = statusIds.indexOf(boardView.activeStatus);
  const nextStatus = statusIds[currentIndex + (deltaX < 0 ? 1 : -1)];
  if (!nextStatus) return;
  event.preventDefault();
  suppressNextBoardClick();
  boardView.setActiveStatus(nextStatus);
  document.querySelector(`.mobile-status-tab[data-status="${nextStatus}"]`)?.scrollIntoView({
    behavior: 'smooth',
    block: 'nearest',
    inline: 'center'
  });
  Haptics.actionSuccess();
}

function handleMobileCardTouchStart(event) {
  clearMobileCardTouch();
  if (!isMobileViewport() || event.touches.length !== 1) return;
  const card = event.target.closest?.('.ticket-card');
  if (!card) return;
  const ticketId = card.dataset.ticketId;
  const ticket = allTickets.find((item) => item.id === ticketId);
  const onControl = Boolean(event.target.closest('button, a, input, select, textarea'));
  mobileCardTouchStart = {
    ticketId,
    x: event.touches[0].clientX,
    y: event.touches[0].clientY,
    onControl,
    longPressTriggered: false,
    timer: null
  };
  if (mobileSelectionMode || onControl || !canSelectMobileTicket(ticket)) return;
  mobileCardTouchStart.timer = window.setTimeout(() => {
    if (!mobileCardTouchStart || mobileCardTouchStart.ticketId !== ticketId) return;
    mobileCardTouchStart.longPressTriggered = true;
    startMobileSelection(ticketId, true);
  }, 400);
}

function handleMobileCardTouchMove(event) {
  if (!mobileCardTouchStart || event.touches.length !== 1) return;
  const touch = event.touches[0];
  if (Math.abs(touch.clientX - mobileCardTouchStart.x) > 12
    || Math.abs(touch.clientY - mobileCardTouchStart.y) > 12) {
    window.clearTimeout(mobileCardTouchStart.timer);
    mobileCardTouchStart.timer = null;
  }
}

function handleMobileCardTouchEnd(event) {
  const touchStart = mobileCardTouchStart;
  if (!touchStart || event.changedTouches.length !== 1) {
    clearMobileCardTouch();
    return;
  }
  window.clearTimeout(touchStart.timer);
  mobileCardTouchStart = null;
  if (touchStart.longPressTriggered) {
    event.preventDefault();
    suppressNextBoardClick();
    return;
  }
  const deltaX = event.changedTouches[0].clientX - touchStart.x;
  const deltaY = event.changedTouches[0].clientY - touchStart.y;
  if (touchStart.onControl || Math.abs(deltaX) < 60 || Math.abs(deltaX) < Math.abs(deltaY) * 1.3) {
    if (mobileSelectionMode && !touchStart.onControl && Math.abs(deltaX) < 20 && Math.abs(deltaY) < 20) {
      event.preventDefault();
      suppressNextBoardClick();
      toggleMobileTicketSelection(touchStart.ticketId);
    }
    return;
  }
  event.preventDefault();
  suppressNextBoardClick();
  if (mobileSelectionMode) return;
  if (deltaX > 0) {
    resolveTicketFromSwipe(touchStart.ticketId);
  } else {
    openMobileTicketActions(touchStart.ticketId);
  }
}

function clearMobileCardTouch() {
  if (mobileCardTouchStart?.timer) window.clearTimeout(mobileCardTouchStart.timer);
  mobileCardTouchStart = null;
}

function suppressNextBoardClick() {
  suppressBoardClick = true;
  window.clearTimeout(boardClickSuppressTimeout);
  boardClickSuppressTimeout = window.setTimeout(() => { suppressBoardClick = false; }, 400);
}

async function resolveTicketFromSwipe(ticketId) {
  const ticket = allTickets.find((item) => item.id === ticketId);
  if (!ticket || ticket.status === 'resolved') return;
  if (!auth.canChangeStatus(activeUser, ticket)) {
    showToast('No tienes permiso para resolver este ticket.');
    return;
  }
  try {
    await ticketService.changeTicketStatus(ticketId, 'resolved');
    await loadTickets();
    renderBoard();
    Haptics.actionSuccess();
    showToast('Ticket marcado como resuelto.');
  } catch (error) {
    showToast(error.message || 'No se pudo resolver el ticket.');
  }
}

function handleMobilePullStart(event) {
  if (!isMobileViewport() || event.touches.length !== 1 || window.scrollY > 2 || mobileRefreshInProgress) return;
  if (document.getElementById('boardPanel').classList.contains('hidden')
    || !event.target.closest?.('#boardPanel, #mobileStatusTabs')
    || mobileOverlayStack.length
    || !activeUser) return;
  mobileTouchStart = { y: event.touches[0].clientY };
}

async function handleMobilePullEnd(event) {
  if (!mobileTouchStart || event.changedTouches.length !== 1) {
    mobileTouchStart = null;
    return;
  }
  const distance = event.changedTouches[0].clientY - mobileTouchStart.y;
  mobileTouchStart = null;
  if (distance < 75 || window.scrollY > 2 || mobileRefreshInProgress) return;
  event.preventDefault();
  await refreshMobileBoard();
}

async function refreshMobileBoard() {
  if (mobileRefreshInProgress || !activeUser) return;
  mobileRefreshInProgress = true;
  const status = document.getElementById('mobileRefreshStatus');
  status.textContent = 'Actualizando tickets…';
  status.classList.add('is-refreshing');
  try {
    await Promise.all([
      loadTickets(),
      loadCategories(),
      refreshNotificationList(),
      loadResponseTemplates(),
      loadSatisfactionEntries()
    ]);
    if (!categoriesModal.classList.contains('hidden')) renderCategoryManagement();
    renderBoard();
    status.textContent = 'Tickets actualizados';
    Haptics.actionSuccess();
  } catch (error) {
    showToast(error.message || 'No se pudieron actualizar los tickets.');
    status.textContent = 'No se pudo actualizar';
  } finally {
    mobileRefreshInProgress = false;
    status.classList.remove('is-refreshing');
    window.setTimeout(() => { status.textContent = ''; }, 1800);
  }
}

function handleMobileScroll() {
  if (!isMobileViewport()) return;
  const currentY = window.scrollY;
  const delta = currentY - lastScrollY;
  const appShell = document.getElementById('appShell');
  if (currentY < 48) {
    appShell.classList.remove('is-chrome-hidden');
  } else if (delta > 8) {
    appShell.classList.add('is-chrome-hidden');
  } else if (delta < -5) {
    appShell.classList.remove('is-chrome-hidden');
  }
  lastScrollY = currentY;
}

function openMobileFilters() {
  const layer = document.getElementById('mobileFiltersLayer');
  trackMobileOverlayOpen('filters');
  layer.classList.remove('hidden');
  document.getElementById('mobileFiltersSheet').setAttribute('role', 'dialog');
  document.getElementById('mobileFiltersSheet').setAttribute('aria-modal', 'true');
  document.getElementById('btnOpenMobileFilters').setAttribute('aria-expanded', 'true');
  layer.querySelector('select, input').focus();
}

function closeMobileFilters() {
  document.getElementById('mobileFiltersLayer').classList.add('hidden');
  document.getElementById('mobileFiltersSheet').removeAttribute('role');
  document.getElementById('mobileFiltersSheet').removeAttribute('aria-modal');
  document.getElementById('btnOpenMobileFilters').setAttribute('aria-expanded', 'false');
  trackMobileOverlayClose('filters');
  document.getElementById('btnOpenMobileFilters').focus();
}

function clearFilters() {
  filters.search.value = '';
  filters.assignedTo.value = 'ALL';
  filters.status.value = 'ALL';
  filters.priority.value = 'ALL';
  filters.category.value = 'ALL';
  filters.dueFilter.value = 'ALL';
  filters.sortField.value = 'createdAt';
  filters.sortDirection.value = 'desc';
  renderBoard();
}

function openMobileSearch() {
  if (!isMobileViewport()) return;
  renderRecentMobileSearches();
  const layer = document.getElementById('mobileSearchLayer');
  layer.classList.remove('hidden');
  layer.setAttribute('role', 'dialog');
  layer.setAttribute('aria-modal', 'true');
  trackMobileOverlayOpen('search');
  const input = document.getElementById('mobileSearchInput');
  input.value = filters.search.value;
  renderMobileSearchResults();
  input.focus();
}

function closeMobileSearch() {
  const layer = document.getElementById('mobileSearchLayer');
  layer.classList.add('hidden');
  layer.removeAttribute('role');
  layer.removeAttribute('aria-modal');
  trackMobileOverlayClose('search');
  filters.search.focus();
}

function handleMobileSearchSubmit(event) {
  event.preventDefault();
  const query = document.getElementById('mobileSearchInput').value.trim();
  filters.search.value = query;
  if (query) {
    recentMobileSearches = [query, ...recentMobileSearches.filter((item) => item.toLowerCase() !== query.toLowerCase())].slice(0, 5);
  }
  renderBoard();
  closeMobileSearch();
}

function renderRecentMobileSearches() {
  const section = document.getElementById('mobileRecentSearchSection');
  const list = document.getElementById('mobileRecentSearches');
  section.classList.toggle('hidden', recentMobileSearches.length === 0);
  list.replaceChildren(...recentMobileSearches.map((query) => {
    const item = document.createElement('li');
    const button = document.createElement('button');
    button.type = 'button';
    button.dataset.recentSearch = query;
    button.textContent = query;
    item.appendChild(button);
    return item;
  }));
}

function renderMobileSearchResults() {
  const query = document.getElementById('mobileSearchInput').value.trim();
  const section = document.getElementById('mobileSearchResultsSection');
  const list = document.getElementById('mobileSearchResults');
  if (!query || !activeUser) {
    section.classList.add('hidden');
    list.replaceChildren();
    return;
  }
  const results = FilterSortService.apply(allTickets, {
    search: query,
    sortField: filters.sortField.value,
    sortDirection: filters.sortDirection.value
  }, usersMap).slice(0, 8);
  section.classList.remove('hidden');
  if (!results.length) {
    const empty = document.createElement('li');
    empty.className = 'mobile-search-empty';
    empty.textContent = 'No se encontraron tickets.';
    list.replaceChildren(empty);
    return;
  }
  list.replaceChildren(...results.map((ticket) => {
    const item = document.createElement('li');
    const button = document.createElement('button');
    button.type = 'button';
    button.dataset.mobileResultId = ticket.id;
    const title = document.createElement('strong');
    title.textContent = ticket.title;
    const details = document.createElement('span');
    details.textContent = `${ticket.id} · ${STATUS_DEFINITIONS[ticket.status]?.name || ticket.status}`;
    button.append(title, details);
    item.appendChild(button);
    return item;
  }));
}

async function handleMobileSearchResult(event) {
  const button = event.target.closest('[data-mobile-result-id]');
  if (!button) return;
  const ticketId = button.dataset.mobileResultId;
  closeMobileSearch();
  await openTicketForEditing(ticketId);
}

function handleRecentSearchClick(event) {
  const button = event.target.closest('[data-recent-search]');
  if (!button) return;
  document.getElementById('mobileSearchInput').value = button.dataset.recentSearch;
  filters.search.value = button.dataset.recentSearch;
  renderBoard();
  closeMobileSearch();
}

function handleMobileQuickFilter(event) {
  const button = event.target.closest('[data-mobile-quick-filter]');
  if (!button) return;
  if (button.dataset.mobileQuickFilter === 'overdue') {
    filters.dueFilter.value = 'overdue';
    filters.status.value = 'ALL';
  } else {
    filters.priority.value = 'Urgente';
  }
  setActiveView('board');
  renderBoard();
  selectFirstVisibleStatus();
  Haptics.actionSuccess();
  closeMobileSearch();
}

function renderMobileFilterChips() {
  const container = document.getElementById('mobileActiveFilters');
  if (!container) return;
  const labels = [
    ['search', filters.search.value.trim() ? `Buscar: ${filters.search.value.trim()}` : ''],
    ['assignedTo', filters.assignedTo.selectedOptions[0]?.textContent || '', filters.assignedTo.value !== 'ALL'],
    ['status', filters.status.selectedOptions[0]?.textContent || '', filters.status.value !== 'ALL'],
    ['priority', filters.priority.selectedOptions[0]?.textContent || '', filters.priority.value !== 'ALL'],
    ['category', filters.category.value !== 'ALL' ? filters.category.value : '', filters.category.value !== 'ALL'],
    ['dueFilter', filters.dueFilter.selectedOptions[0]?.textContent || '', filters.dueFilter.value !== 'ALL']
  ].filter(([key, label, active]) => label && (key === 'search' ? Boolean(filters.search.value.trim()) : active));
  container.replaceChildren(...labels.map(([key, label]) => {
    const chip = document.createElement('button');
    chip.className = 'mobile-filter-chip';
    chip.type = 'button';
    chip.dataset.filterKey = key;
    chip.setAttribute('aria-label', `Quitar filtro ${label}`);
    chip.innerHTML = `${escapeHtml(label)} <span aria-hidden="true">&times;</span>`;
    return chip;
  }));
  container.classList.toggle('is-empty', labels.length === 0);
}

function removeMobileFilterChip(event) {
  const chip = event.target.closest('[data-filter-key]');
  if (!chip) return;
  const key = chip.dataset.filterKey;
  if (key === 'search') filters.search.value = '';
  else if (key === 'assignedTo') filters.assignedTo.value = 'ALL';
  else if (key === 'category') filters.category.value = 'ALL';
  else if (key === 'dueFilter') filters.dueFilter.value = 'ALL';
  else if (key === 'status') filters.status.value = 'ALL';
  else if (key === 'priority') filters.priority.value = 'ALL';
  renderBoard();
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function openMobileStatusSheet(ticketId, trigger) {
  const ticket = allTickets.find((item) => item.id === ticketId);
  if (!ticket || !auth.canChangeStatus(activeUser, ticket)) return;

  mobileStatusTicketId = ticketId;
  trackMobileOverlayOpen('status');
  document.getElementById('ticketStatusTicketId').textContent = ticket.id;
  const options = Object.values(STATUS_DEFINITIONS).map(({ id, name, colorHex }) => {
    const button = document.createElement('button');
    button.className = 'ticket-status-option';
    button.type = 'button';
    button.dataset.status = id;
    button.style.setProperty('--status-color', colorHex);
    button.setAttribute('aria-pressed', String(ticket.status === id));
    button.disabled = ticket.status === id;
    button.textContent = name;
    return button;
  });
  const container = document.getElementById('ticketStatusOptions');
  container.replaceChildren(...options);
  document.getElementById('ticketStatusLayer').classList.remove('hidden');
  container.querySelector('button:not(:disabled)')?.focus();
  if (trigger) trigger.setAttribute('aria-expanded', 'true');
}

function closeMobileStatusSheet() {
  document.getElementById('ticketStatusLayer').classList.add('hidden');
  [...boardEl.querySelectorAll('.btn-change-status')]
    .find((button) => button.dataset.ticketId === mobileStatusTicketId)
    ?.setAttribute('aria-expanded', 'false');
  trackMobileOverlayClose('status');
  mobileStatusTicketId = null;
  document.querySelector('#mobileStatusTabs .mobile-status-tab[aria-pressed="true"]')?.focus();
}

async function handleMobileStatusSelection(event) {
  const option = event.target.closest('.ticket-status-option');
  if (!option || !mobileStatusTicketId) return;
  const ticketId = mobileStatusTicketId;
  const nextStatus = option.dataset.status;
  const options = [...document.querySelectorAll('.ticket-status-option')];
  options.forEach((button) => { button.disabled = true; });
  try {
    await ticketService.changeTicketStatus(ticketId, nextStatus);
    Haptics.actionSuccess();
    closeMobileStatusSheet();
    await loadTickets();
    renderBoard();
    showToast('Estado actualizado');
    document.querySelector('#mobileStatusTabs .mobile-status-tab[aria-pressed="true"]')?.focus();
  } catch (error) {
    const currentStatus = allTickets.find((ticket) => ticket.id === ticketId)?.status;
    options.forEach((button) => { button.disabled = button.dataset.status === currentStatus; });
    showToast(error.message || 'No se pudo actualizar el estado del ticket.');
  }
}

function canSelectMobileTicket(ticket) {
  return Boolean(isMobileViewport() && activeUser && ticket
    && (auth.canChangeStatus(activeUser, ticket) || auth.canAssignOrSetDue(activeUser)));
}

function startMobileSelection(ticketId = null, preserveTouchTarget = false) {
  if (!isMobileViewport()) return;
  mobileSelectionMode = true;
  const selectionButton = document.getElementById('btnStartBatchSelection');
  selectionButton.setAttribute('aria-pressed', 'true');
  selectionButton.setAttribute('aria-label', 'Salir de la selección de tickets');
  selectionButton.textContent = 'Cancelar';
  if (ticketId && canSelectMobileTicket(allTickets.find((ticket) => ticket.id === ticketId))) {
    selectedMobileTicketIds.add(ticketId);
    Haptics.selectionTick();
  }
  document.getElementById('boardPanel').classList.add('is-selection-mode');
  renderMobileBatchToolbar();
  if (preserveTouchTarget) syncMobileCardSelectionButtons();
  else renderBoard();
}

function toggleMobileTicketSelection(ticketId) {
  if (!mobileSelectionMode) return;
  const ticket = allTickets.find((item) => item.id === ticketId);
  if (!canSelectMobileTicket(ticket)) return;
  if (selectedMobileTicketIds.has(ticketId)) selectedMobileTicketIds.delete(ticketId);
  else selectedMobileTicketIds.add(ticketId);
  Haptics.selectionTick();
  renderMobileBatchToolbar();
  renderBoard();
}

function exitMobileSelection() {
  mobileSelectionMode = false;
  const selectionButton = document.getElementById('btnStartBatchSelection');
  selectionButton.setAttribute('aria-pressed', 'false');
  selectionButton.setAttribute('aria-label', 'Seleccionar tickets');
  selectionButton.textContent = 'Seleccionar';
  selectedMobileTicketIds.clear();
  document.getElementById('boardPanel').classList.remove('is-selection-mode');
  renderMobileBatchToolbar();
  renderBoard();
}

function renderMobileBatchToolbar() {
  const toolbar = document.getElementById('mobileBatchToolbar');
  const selectionButton = document.getElementById('btnStartBatchSelection');
  const selectedCount = selectedMobileTicketIds.size;
  selectionButton.classList.toggle('hidden', mobileSelectionMode || !activeUser);
  toolbar.classList.toggle('hidden', !mobileSelectionMode);
  toolbar.setAttribute('aria-hidden', String(!mobileSelectionMode));
  document.getElementById('mobileBatchSelectionCount').textContent =
    `${selectedCount} ${selectedCount === 1 ? 'seleccionado' : 'seleccionados'}`;
  document.getElementById('mobileBatchHint').classList.toggle('hidden', selectedCount > 0);

  const statusSelect = document.getElementById('mobileBatchStatus');
  const previousStatus = statusSelect.value;
  const statusPlaceholder = document.createElement('option');
  statusPlaceholder.value = '';
  statusPlaceholder.textContent = 'Selecciona un estado';
  const statusOptions = Object.values(STATUS_DEFINITIONS).map(({ id, name }) => {
    const option = document.createElement('option');
    option.value = id;
    option.textContent = name;
    return option;
  });
  statusSelect.replaceChildren(statusPlaceholder, ...statusOptions);
  statusSelect.value = STATUS_DEFINITIONS[previousStatus] ? previousStatus : '';

  const assigneeSelect = document.getElementById('mobileBatchAssignee');
  const previousAssignee = assigneeSelect.value;
  const assigneePlaceholder = document.createElement('option');
  assigneePlaceholder.value = '';
  assigneePlaceholder.textContent = 'Selecciona un responsable';
  const assigneeOptions = [...usersMap.values()]
    .filter((user) => ['Admin', 'Agent'].includes(user.role) && user.workspaceId === activeUser?.workspaceId)
    .map((user) => {
      const option = document.createElement('option');
      option.value = user.id;
      option.textContent = user.fullName;
      return option;
    });
  const unassignedOption = document.createElement('option');
  unassignedOption.value = '__unassigned__';
  unassignedOption.textContent = 'Sin asignar';
  assigneeSelect.replaceChildren(assigneePlaceholder, unassignedOption, ...assigneeOptions);
  assigneeSelect.value = [ '', '__unassigned__', ...assigneeOptions.map((option) => option.value) ]
    .includes(previousAssignee) ? previousAssignee : '';

  const canAssign = auth.canAssignOrSetDue(activeUser);
  document.getElementById('mobileBatchAssigneeGroup').classList.toggle('hidden', !canAssign || !selectedCount);
  document.getElementById('mobileBatchMoveGroup').classList.toggle('hidden', !selectedCount);
  document.getElementById('btnMobileBatchMove').disabled = !selectedCount || !statusSelect.value;
  document.getElementById('btnMobileBatchClose').disabled = !selectedCount;
  document.getElementById('btnMobileBatchAssign').disabled = !selectedCount || !canAssign || !assigneeSelect.value;
}

function syncMobileCardSelectionButtons() {
  boardEl.querySelectorAll('[data-select-ticket]').forEach((button) => {
    const selected = selectedMobileTicketIds.has(button.dataset.selectTicket);
    button.classList.add('is-visible');
    button.setAttribute('aria-pressed', String(selected));
    button.setAttribute('aria-label', `${selected ? 'Quitar' : 'Seleccionar'} ticket ${button.dataset.selectTicket}`);
  });
}

function handleMobileBatchKeydown(event) {
  if (event.key === 'Escape') {
    event.preventDefault();
    exitMobileSelection();
  }
}

async function applyMobileBatchStatus(status) {
  if (!STATUS_DEFINITIONS[status] || !selectedMobileTicketIds.size) return;
  await runMobileBatchAction(
    status === 'closed' ? 'Tickets cerrados' : `Tickets movidos a ${STATUS_DEFINITIONS[status].name}`,
    (ticketId) => ticketService.changeTicketStatus(ticketId, status)
  );
}

async function applyMobileBatchAssignee() {
  const value = document.getElementById('mobileBatchAssignee').value;
  if (!selectedMobileTicketIds.size || !value) return;
  if (!auth.canAssignOrSetDue(activeUser)) {
    showToast('No tienes permiso para reasignar tickets.');
    return;
  }
  const assignedTo = value === '__unassigned__' ? null : value;
  await runMobileBatchAction('Responsables actualizados', async (ticketId) => {
    const ticket = allTickets.find((item) => item.id === ticketId);
    if (!ticket) throw new Error('El ticket ya no está disponible.');
    return ticketService.updateTicket({ ...ticket, assignedTo });
  });
  document.getElementById('mobileBatchAssignee').value = '';
  renderMobileBatchToolbar();
}

async function runMobileBatchAction(successMessage, action) {
  const ticketIds = [...selectedMobileTicketIds];
  if (!ticketIds.length) return;
  const buttons = [...document.querySelectorAll('#mobileBatchToolbar button')];
  buttons.forEach((button) => { button.disabled = true; });
  const failed = [];
  let succeeded = 0;
  try {
    for (const ticketId of ticketIds) {
      try {
        await action(ticketId);
        succeeded += 1;
      } catch (error) {
        failed.push({ ticketId, error });
      }
    }
    if (succeeded) {
      await loadTickets();
      ticketIds.filter((ticketId) => !failed.some((item) => item.ticketId === ticketId))
        .forEach((ticketId) => selectedMobileTicketIds.delete(ticketId));
      Haptics.actionSuccess();
    }
    renderBoard();
    renderMobileBatchToolbar();
    if (failed.length) {
      const firstError = failed[0].error.message || 'No se pudo completar la acción.';
      showToast(`${successMessage}: ${succeeded}; ${failed.length} no se pudieron actualizar. ${firstError}`, 7000);
    } else {
      showToast(`${successMessage}: ${succeeded}.`);
    }
  } catch (error) {
    showToast(error.message || 'No se pudieron sincronizar los tickets actualizados.', 7000);
  } finally {
    buttons.forEach((button) => { button.disabled = false; });
    renderMobileBatchToolbar();
  }
}

function mobileTicketActionPermissions(ticket) {
  return {
    canEdit: auth.canEditTicket(activeUser, ticket),
    canAssign: auth.canAssignOrSetDue(activeUser),
    canDelete: auth.canDelete(activeUser)
  };
}

function populateMobileAssigneeSelect(select, selectedValue) {
  const options = [...usersMap.values()]
    .filter((user) => ['Admin', 'Agent'].includes(user.role) && user.workspaceId === activeUser?.workspaceId)
    .map((user) => {
      const option = document.createElement('option');
      option.value = user.id;
      option.textContent = user.fullName;
      return option;
    });
  const unassignedOption = document.createElement('option');
  unassignedOption.value = '';
  unassignedOption.textContent = 'Sin asignar';
  select.replaceChildren(unassignedOption, ...options);
  select.value = selectedValue || '';
}

function openMobileTicketActions(ticketId) {
  const ticket = allTickets.find((item) => item.id === ticketId);
  if (!ticket) return;
  const permissions = mobileTicketActionPermissions(ticket);
  if (!permissions.canEdit && !permissions.canAssign && !permissions.canDelete) {
    showToast('No tienes permisos para modificar este ticket.');
    return;
  }
  mobileActionTicketId = ticketId;
  document.getElementById('mobileTicketActionsTicketId').textContent = ticket.id;
  const prioritySelect = document.getElementById('mobileTicketPriority');
  prioritySelect.replaceChildren(...PRIORITY_ORDER.map((priority) => {
    const option = document.createElement('option');
    option.value = priority;
    option.textContent = priority;
    return option;
  }));
  prioritySelect.value = ticket.priority;
  document.getElementById('mobileTicketPriorityGroup').classList.toggle('hidden', !permissions.canEdit);
  const assigneeSelect = document.getElementById('mobileTicketAssignee');
  populateMobileAssigneeSelect(assigneeSelect, ticket.assignedTo);
  document.getElementById('mobileTicketAssigneeGroup').classList.toggle('hidden', !permissions.canAssign);
  document.getElementById('btnSaveMobileTicketActions').classList.toggle('hidden', !permissions.canEdit && !permissions.canAssign);
  document.getElementById('btnDeleteMobileTicket').classList.toggle('hidden', !permissions.canDelete);
  document.getElementById('mobileTicketActionsLayer').classList.remove('hidden');
  trackMobileOverlayOpen('quick-actions');
  document.getElementById('mobileTicketActionsSheet').querySelector('button:not(.hidden)')?.focus();
}

function closeMobileTicketActions() {
  const wasOpen = !document.getElementById('mobileTicketActionsLayer').classList.contains('hidden');
  document.getElementById('mobileTicketActionsLayer').classList.add('hidden');
  if (wasOpen) trackMobileOverlayClose('quick-actions');
  const ticketId = mobileActionTicketId;
  mobileActionTicketId = null;
  [...boardEl.querySelectorAll('.ticket-card')]
    .find((card) => card.dataset.ticketId === ticketId)?.focus();
}

async function saveMobileTicketActions() {
  const ticket = allTickets.find((item) => item.id === mobileActionTicketId);
  if (!ticket) return;
  const permissions = mobileTicketActionPermissions(ticket);
  const priority = permissions.canEdit
    ? document.getElementById('mobileTicketPriority').value
    : ticket.priority;
  const assignedTo = permissions.canAssign
    ? document.getElementById('mobileTicketAssignee').value || null
    : ticket.assignedTo;
  if (priority === ticket.priority && assignedTo === ticket.assignedTo) {
    closeMobileTicketActions();
    return;
  }
  const saveButton = document.getElementById('btnSaveMobileTicketActions');
  saveButton.disabled = true;
  try {
    await ticketService.updateTicket({ ...ticket, priority, assignedTo });
    await loadTickets();
    closeMobileTicketActions();
    renderBoard();
    Haptics.actionSuccess();
    showToast('Acciones guardadas correctamente.');
  } catch (error) {
    showToast(error.message || 'No se pudieron guardar los cambios.');
  } finally {
    saveButton.disabled = false;
  }
}

async function deleteMobileTicket() {
  const ticket = allTickets.find((item) => item.id === mobileActionTicketId);
  if (!ticket) return;
  if (!auth.canDelete(activeUser)) {
    showToast('Solo un administrador puede eliminar tickets.');
    return;
  }
  if (!window.confirm(`¿Eliminar el ticket ${ticket.id}? Esta acción no se puede deshacer.`)) return;
  const deleteButton = document.getElementById('btnDeleteMobileTicket');
  deleteButton.disabled = true;
  try {
    await ticketService.deleteTicket(ticket.id);
    Haptics.destructive();
    selectedMobileTicketIds.delete(ticket.id);
    await loadTickets();
    closeMobileTicketActions();
    renderBoard();
    showToast('Ticket eliminado correctamente.');
  } catch (error) {
    showToast(error.message || 'No se pudo eliminar el ticket.');
  } finally {
    deleteButton.disabled = false;
  }
}

function handleBottomSheetKeydown(event) {
  if (event.key === 'Escape') {
    event.preventDefault();
    if (event.currentTarget.id === 'mobileFiltersSheet') closeMobileFilters();
    else if (event.currentTarget.id === 'mobileSearchLayer') closeMobileSearch();
    else if (event.currentTarget.id === 'mobileTicketActionsSheet') closeMobileTicketActions();
    else closeMobileStatusSheet();
    return;
  }
  if (event.key !== 'Tab') return;
  const focusable = [...event.currentTarget.querySelectorAll('button:not(:disabled), input:not(:disabled), select:not(:disabled)')]
    .filter((element) => !element.closest('.hidden'));
  if (!focusable.length) return;
  const first = focusable[0];
  const last = focusable[focusable.length - 1];
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
}

async function openTicketForEditing(ticketId) {
  const ticket = allTickets.find((item) => item.id === ticketId);
  if (!ticket) return;
  const user = await auth.getCurrentUser();
  modalView.openTicket(ticket, {
    canEdit: auth.canEditTicket(user, ticket),
    canManageChecklist: auth.canEditTicket(user, ticket),
    canManageAssignment: auth.canAssignOrSetDue(user),
    canManageComplexity: auth.canAssignOrSetDue(user),
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
  if (!ticket) return false;

  try {
    const dueDate = dateKey
      ? dueDateForCalendarDay(new Date(`${dateKey}T12:00:00`), ticket.dueDate)
      : null;
    await ticketService.rescheduleTicket(ticketId, dueDate);
    await loadTickets();
    renderBoard();
    showToast(dateKey ? 'Fecha límite actualizada' : 'Fecha límite quitada');
    return true;
  } catch (error) {
    showToast(error.message || 'No se pudo cambiar la fecha límite');
    renderBoard();
    return false;
  }
}

function setActiveView(view) {
  const updateView = () => {
    const showCalendar = view === 'calendar';
    const showMetrics = view === 'metrics';
    if (showMetrics) {
      document.getElementById('btnNewTicket')?.classList.add('hidden');
    } else {
      document.getElementById('btnNewTicket')?.classList.remove('hidden');
    }
    document.getElementById('appShell').classList.toggle('is-calendar-view', showCalendar);
    document.getElementById('appShell').classList.toggle('is-metrics-view', showMetrics);
    document.querySelector('.mobile-selection-entry').classList.toggle('hidden', showCalendar || showMetrics);
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
  };

  if (typeof document.startViewTransition === 'function') {
    document.startViewTransition(updateView);
  } else {
    updateView();
  }
}

function updateUserRoleDescription() {
  if (document.getElementById('userCreateWorkspace').checked) {
    document.getElementById('userRoleDescription').textContent = 'Se creará un espacio independiente y esta cuenta será su Administrador inicial.';
    return;
  }

  const descriptions = {
    Reporter: 'Puede crear tickets nuevos, consultar los tickets del equipo, comentar en los que creó y valorar sus tickets al cerrarse. No puede asignar, editar ni cambiar estados.',
    Agent: 'Puede trabajar tickets abiertos o asignados: editarlos, cambiar su estado, gestionar subtareas, asignar responsables y definir fechas límite. No administra usuarios ni categorías.',
    Admin: 'Tiene acceso completo a los tickets del equipo. Puede asignar tareas, gestionar usuarios y roles, crear o eliminar categorías y configurar plantillas.'
  };
  const role = document.getElementById('userRole').value;
  document.getElementById('userRoleDescription').textContent = descriptions[role] || '';
}

function syncNewWorkspaceForm() {
  const checkbox = document.getElementById('userCreateWorkspace');
  const roleSelect = document.getElementById('userRole');
  const nameRow = document.getElementById('newWorkspaceNameRow');
  const nameInput = document.getElementById('newWorkspaceName');

  if (checkbox.checked) {
    if (!roleSelect.disabled) roleSelect.dataset.previousValue = roleSelect.value;
    roleSelect.value = 'Admin';
    roleSelect.disabled = true;
    nameRow.hidden = false;
    nameInput.required = true;
  } else {
    if (roleSelect.disabled) roleSelect.value = roleSelect.dataset.previousValue || 'Reporter';
    delete roleSelect.dataset.previousValue;
    roleSelect.disabled = false;
    nameRow.hidden = true;
    nameInput.required = false;
    nameInput.value = '';
  }

  updateUserRoleDescription();
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
        complexityScore: Number(document.getElementById('formComplexityScore').value),
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
        complexityScore: Number(document.getElementById('formComplexityScore').value),
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
  const password = document.getElementById('passwordInput').value;

  try {
    const user = await auth.login(email, password);
    if (user) {
      await syncAuthState();
      renderBoard();
      handleAppShortcut();
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
  const createWorkspace = document.getElementById('userCreateWorkspace').checked;
  if (password !== passwordConfirm) {
    showToast('Las contraseñas no coinciden.');
    return;
  }

  try {
    await auth.registerUser({
      fullName: document.getElementById('userFullName').value,
      email: document.getElementById('userEmail').value,
      role: document.getElementById('userRole').value,
      password,
      createWorkspace,
      workspaceName: document.getElementById('newWorkspaceName').value
    });
    await loadUsers();
    modalView.openUsers([...usersMap.values()], activeUser?.id);
    showToast(createWorkspace
      ? 'Espacio de trabajo creado y Administrador inicial registrado.'
      : 'Usuario creado correctamente.');
  } catch (error) {
    showToast(error.message || 'No se pudo crear el usuario.');
  }
}

async function handleUserRoleUpdate(event) {
  const button = event.target.closest('[data-update-user-role]');
  if (!button || button.disabled) return;

  const target = usersMap.get(button.dataset.updateUserRole);
  const roleSelect = button.closest('li')?.querySelector('[data-user-role-id]');
  if (!target || !roleSelect || target.role === roleSelect.value) return;

  let currentUser;
  try {
    currentUser = await auth.getCurrentUser();
  } catch (error) {
    showToast(error.message || 'No se pudo verificar tu sesión.');
    return;
  }
  if (!auth.canManageUsers(currentUser)) {
    showToast('Solo un administrador puede cambiar roles.');
    return;
  }

  const isSelf = target.id === currentUser.id;
  const confirmation = isSelf
    ? `¿Cambiar tu rol de ${target.role} a ${roleSelect.value}? Tus permisos cambiarán de inmediato.`
    : `¿Cambiar el rol de ${target.fullName} de ${target.role} a ${roleSelect.value}?`;
  if (!window.confirm(confirmation)) return;

  button.disabled = true;
  roleSelect.disabled = true;
  try {
    await auth.updateUserRole(target.id, roleSelect.value);
    if (isSelf) {
      modalView.closeUsers();
      await auth.refreshCurrentUser();
      await syncAuthState();
      renderBoard();
    } else {
      await loadUsers();
      modalView.openUsers([...usersMap.values()], activeUser?.id);
    }
    showToast(`Rol actualizado a ${roleSelect.value}.`);
  } catch (error) {
    roleSelect.value = target.role;
    button.disabled = true;
    showToast(error.message || 'No se pudo cambiar el rol.');
  } finally {
    roleSelect.disabled = false;
  }
}

function renderBoard() {
  if (!boardView) return;

  if (!activeUser) {
    boardEl.innerHTML = '';
    mobileSelectionMode = false;
    selectedMobileTicketIds.clear();
    document.getElementById('boardPanel').classList.remove('is-selection-mode');
    renderMobileBatchToolbar();
    if (calendarView) calendarView.render([], false);
    renderMobileFilterChips();
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

  const statusCountTickets = isMobileViewport()
    ? FilterSortService.apply(allTickets, { ...criteria, status: 'ALL' }, usersMap)
    : null;
  const visibleTickets = FilterSortService.apply(allTickets, criteria, usersMap);
  boardView.render(
    visibleTickets,
    (ticket) => auth.canChangeStatus(activeUser, ticket),
    statusCountTickets || visibleTickets,
    {
      selectionMode: mobileSelectionMode,
      selectedTicketIds: selectedMobileTicketIds,
      canSelectTicket: canSelectMobileTicket
    }
  );
  renderMobileBatchToolbar();
  renderMobileFilterChips();
  const mobileSearchInput = document.getElementById('mobileSearchInput');
  if (mobileSearchInput && document.activeElement !== mobileSearchInput) {
    mobileSearchInput.value = filters.search.value;
  }
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
    metrics = calculateTicketMetrics(
      allTickets,
      usersMap,
      start.value,
      end.value,
      satisfactionEntries,
      document.getElementById('metricsGrouping').value
    );
  } catch (error) {
    document.getElementById('agentMetricsBody').replaceChildren();
    clearMetricsCharts('No se pudieron calcular las gráficas para este período.');
    const message = error.message || 'El rango de fechas del informe no es válido.';
    document.getElementById('metricsError').textContent = message;
    document.getElementById('metricsError').classList.remove('hidden');
    return null;
  }
  document.getElementById('metricsError').classList.add('hidden');
  document.getElementById('metricCreated').textContent = String(metrics.createdCount);
  document.getElementById('metricResolved').textContent = String(metrics.resolvedCount);
  document.getElementById('metricClosed').textContent = String(metrics.closedCount);
  document.getElementById('metricCompletedPoints').textContent = String(metrics.completedPoints);
  document.getElementById('metricOpen').textContent = String(metrics.openCount);
  document.getElementById('metricSla').textContent = `${metrics.slaCompliance}%`;
  document.getElementById('metricResolution').textContent = `${metrics.averageResolutionHours} h`;
  document.getElementById('metricSatisfaction').textContent = metrics.averageSatisfaction === null
    ? 'Sin datos'
    : `${metrics.averageSatisfaction} / 5`;
  renderMetricsCharts(metrics);
  const body = document.getElementById('agentMetricsBody');
  const rows = metrics.byAgent.map((agent) => {
    const row = document.createElement('tr');
    const name = document.createElement('td');
    const active = document.createElement('td');
    const resolved = document.createElement('td');
    const closed = document.createElement('td');
    const completedPoints = document.createElement('td');
    name.textContent = agent.name;
    active.textContent = String(agent.active);
    resolved.textContent = String(agent.resolved);
    closed.textContent = String(agent.closed);
    completedPoints.textContent = String(agent.completedPoints);
    row.append(name, active, resolved, closed, completedPoints);
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

async function dispatchStatusMutation(ticketId, nextStatus) {
  const ticket = allTickets.find((item) => item.id === ticketId);
  if (!ticket || ticket.status === nextStatus) return { status: 'unchanged' };
  const previousStatus = ticket.status;
  const result = await mutations.dispatch({
    type: 'ticket.status.set',
    entityId: ticketId,
    payload: { status: nextStatus, previousStatus },
    optimistic: () => {
      ticket.status = nextStatus;
      renderBoard();
      renderMobileSearchResults();
    },
    rollback: () => {
      const current = allTickets.find((item) => item.id === ticketId);
      if (current?.status === nextStatus) current.status = previousStatus;
      renderBoard();
      renderMobileSearchResults();
    }
  });
  if (result.status === 'synced') showToast('Estado actualizado');
  return result;
}

function handleChecklistToggle(index, completed) {
  const ticketId = modalView.currentTicketId;
  const ticket = allTickets.find((item) => item.id === ticketId);
  const checklist = ticket?.checklist || [];
  const item = checklist[index];
  const draftItem = modalView.getChecklist()[index];
  if (!item || item.completed === completed) return;
  if (draftItem?.text !== item.text) {
    modalView.setChecklistCompletion(index, item.completed);
    showToast('Guarda los cambios de subtareas antes de cambiar su estado.');
    return;
  }
  const previousCompleted = item.completed;
  void mutations.dispatch({
    type: 'ticket.checklist.complete',
    entityId: ticketId,
    payload: { index, text: item.text, completed, previousCompleted },
    optimistic: () => {
      item.completed = completed;
      modalView.setChecklistCompletion(index, completed);
      renderBoard();
      renderMobileSearchResults();
    },
    rollback: () => {
      const current = allTickets.find((item) => item.id === ticketId);
      if (current?.checklist[index]?.text === item.text) {
        current.checklist[index].completed = previousCompleted;
      }
      if (modalView.currentTicketId === ticketId) {
        modalView.setChecklistCompletion(index, previousCompleted);
      }
      renderBoard();
      renderMobileSearchResults();
    }
  }).then((result) => {
    if (result.status === 'synced') showToast('Subtarea actualizada');
  }).catch((error) => showToast(error.message || 'No se pudo actualizar la subtarea.'));
}

function handleCalendarChecklistToggle(ticket, index, completed) {
  const current = allTickets.find((item) => item.id === ticket.id);
  const checklist = current?.checklist;
  const item = checklist?.[index];
  if (!item) {
    return Promise.reject(new Error('La subtarea ya no está disponible. Recarga el calendario e inténtalo de nuevo.'));
  }
  if (Boolean(item.completed || item.done) === completed) return Promise.resolve({ status: 'synced' });

  const previousCompleted = Boolean(item.completed || item.done);
  const text = item.text;
  if (typeof text !== 'string') {
    return Promise.reject(new Error('No se pudo identificar la subtarea para guardarla.'));
  }

  return mutations.dispatch({
    type: 'ticket.checklist.complete',
    entityId: current.id,
    payload: { index, text, completed, previousCompleted },
    optimistic: () => {
      item.completed = completed;
      if ('done' in item) item.done = completed;
      calendarView?.updateTicketProgress(current);
    },
    rollback: () => {
      const latest = allTickets.find((candidate) => candidate.id === current.id);
      const latestItem = latest?.checklist?.[index];
      if (latestItem?.text === text) {
        latestItem.completed = previousCompleted;
        if ('done' in latestItem) latestItem.done = previousCompleted;
        calendarView?.updateTicketProgress(latest);
      }
    }
  }).then((result) => {
    if (result.status === 'synced') showToast('Subtarea actualizada');
    return result;
  });
}

async function handleMutationSynced(action, ticket) {
  if (ticket) {
    const index = allTickets.findIndex((item) => item.id === ticket.id);
    const previous = index === -1 ? null : allTickets[index];
    const syncedTicket = {
      ...ticket,
      ...previous,
      updatedAt: ticket.updatedAt || previous?.updatedAt,
      statusHistory: ticket.statusHistory?.length ? ticket.statusHistory : previous?.statusHistory || []
    };
    if (index === -1) allTickets.unshift(syncedTicket);
    else allTickets[index] = syncedTicket;
    if (action.type === 'ticket.checklist.complete') {
      calendarView?.updateTicketProgress(syncedTicket);
      if (modalView.currentTicketId === ticket.id) modalView.syncChecklist(syncedTicket.checklist || []);
    } else {
      renderBoard();
    }
    renderMobileSearchResults();
  }
  await refreshPendingSyncStatus();
}

async function refreshPendingSyncStatus() {
  const statusEl = document.getElementById('pendingSyncStatus');
  const messageEl = document.getElementById('pendingSyncMessage');
  const retryButton = document.getElementById('btnRetrySync');
  if (!statusEl || !messageEl || !retryButton) return;
  if (!activeUser) {
    statusEl.classList.add('hidden');
    return;
  }

  const user = activeUser;
  try {
    const pending = await outbox.list({
      userId: user.id,
      workspaceId: user.workspaceId
    });
    if (activeUser?.id !== user.id || activeUser?.workspaceId !== user.workspaceId) {
      statusEl.classList.add('hidden');
      return;
    }
    if (pending.length === 0) {
      statusEl.classList.add('hidden');
      return;
    }

    statusEl.classList.remove('hidden');
    if (!navigator.onLine) {
      messageEl.textContent = `${pending.length} ${pending.length === 1 ? 'cambio pendiente' : 'cambios pendientes'} · Sin conexión`;
    } else if (connectionRecoveryPromise) {
      messageEl.textContent = `Sincronizando ${pending.length} ${pending.length === 1 ? 'cambio pendiente' : 'cambios pendientes'}…`;
    } else {
      messageEl.textContent = `${pending.length} ${pending.length === 1 ? 'cambio pendiente' : 'cambios pendientes'}`;
    }
    retryButton.disabled = !navigator.onLine || Boolean(connectionRecoveryPromise);
    retryButton.textContent = connectionRecoveryPromise ? 'Sincronizando…' : 'Reintentar';
    retryButton.title = navigator.onLine
      ? 'Volver a intentar la sincronización de los cambios pendientes'
      : 'Conéctate a internet para sincronizar los cambios pendientes';
  } catch (error) {
    if (activeUser?.id !== user.id || activeUser?.workspaceId !== user.workspaceId) {
      statusEl.classList.add('hidden');
      return;
    }
    statusEl.classList.remove('hidden');
    messageEl.textContent = 'No se pudo consultar la cola de sincronización';
    retryButton.disabled = !navigator.onLine || Boolean(connectionRecoveryPromise);
    retryButton.textContent = connectionRecoveryPromise ? 'Sincronizando…' : 'Reintentar';
    showToast(error.message || 'No se pudo consultar la cola de sincronización.');
  }
}

async function recoverRejectedMutation(action) {
  try {
    await loadTickets();
  } catch (error) {
    const ticket = allTickets.find((item) => item.id === action.entityId);
    if (ticket && action.type === 'ticket.status.set') {
      ticket.status = action.payload.previousStatus;
    } else if (ticket && action.type === 'ticket.checklist.complete') {
      if (ticket.checklist[action.payload.index]?.text === action.payload.text) {
        ticket.checklist[action.payload.index].completed = action.payload.previousCompleted;
      }
      if (modalView.currentTicketId === action.entityId) {
        modalView.setChecklistCompletion(action.payload.index, action.payload.previousCompleted);
      }
    }
    throw error;
  }
  const current = allTickets.find((ticket) => ticket.id === action.entityId);
  if (action.type === 'ticket.checklist.complete' && modalView.currentTicketId === action.entityId) {
    const serverItem = current?.checklist?.[action.payload.index];
    if (serverItem?.text === action.payload.text) {
      modalView.setChecklistCompletion(action.payload.index, serverItem.completed);
    } else if (current) {
      modalView.syncChecklist(current.checklist || []);
    }
  }
  renderBoard();
  renderMobileSearchResults();
}

function syncCheckpointKey(user = activeUser) {
  return user ? `last_sync:${user.workspaceId}:${user.id}` : null;
}

async function initializeSyncCheckpoint() {
  const key = syncCheckpointKey();
  if (!key) return;
  try {
    if (await outbox.getCheckpoint(key)) return;
    const latest = allTickets
      .map((ticket) => ticket.updatedAt)
      .filter(Boolean)
      .sort()
      .at(-1);
    if (latest) await outbox.setCheckpoint(key, latest);
  } catch (error) {
    showToast(error.message || 'No se pudo guardar el punto de sincronización.');
  }
}

async function reconcileTicketsSinceLastSync() {
  const key = syncCheckpointKey();
  if (!key || !activeUser) return;
  const checkpoint = await outbox.getCheckpoint(key);
  if (!checkpoint) {
    await loadTickets();
    await initializeSyncCheckpoint();
    return;
  }

  const syncIndex = await ticketService.getTicketSyncIndex();
  const changedTickets = await ticketService.getTicketsUpdatedSince(checkpoint);
  const visibleIds = new Set(syncIndex.map((ticket) => ticket.id));
  const ticketsById = new Map(
    allTickets
      .filter((ticket) => visibleIds.has(ticket.id))
      .map((ticket) => [ticket.id, ticket])
  );
  changedTickets.forEach((ticket) => {
    const previous = ticketsById.get(ticket.id);
    ticketsById.set(ticket.id, {
      ...previous,
      ...ticket,
      statusHistory: ticket.statusHistory?.length ? ticket.statusHistory : previous?.statusHistory || []
    });
  });
  allTickets = [...ticketsById.values()].sort((first, second) => (
    (second.createdAt || '').localeCompare(first.createdAt || '')
  ));
  allTickets = await mutations.applyPending(allTickets);

  const latest = [...syncIndex, ...changedTickets]
    .map((ticket) => ticket.updatedAt)
    .filter((timestamp) => timestamp && timestamp > checkpoint)
    .sort()
    .at(-1);
  if (latest) await outbox.setCheckpoint(key, latest);
}

function handleConnectionRestored() {
  if (!activeUser) return Promise.resolve();
  if (connectionRecoveryPromise) return connectionRecoveryPromise;
  connectionRecoveryPromise = (async () => {
    try {
      const syncedCount = await mutations.flush();
      await reconcileTicketsSinceLastSync();
      renderBoard();
      renderMobileSearchResults();
      if (syncedCount > 0) showToast(`Se sincronizaron ${syncedCount} cambios pendientes.`);
    } catch (error) {
      showToast(error.message || 'No se pudieron recuperar los cambios de Supabase.');
    } finally {
      connectionRecoveryPromise = null;
      void refreshPendingSyncStatus();
    }
  })();
  void refreshPendingSyncStatus();
  return connectionRecoveryPromise;
}

async function syncAuthState() {
  const currentUser = await auth.getCurrentUser();
  const btnNewTicket = document.getElementById('btnNewTicket');
  const btnManageUsers = document.getElementById('btnManageUsers');
  const profileManageUsersBtn = document.getElementById('profileManageUsersBtn');
  const btnManageCategories = document.getElementById('btnManageCategories');

  if (currentUser) {
    activeUser = currentUser;
    mutations.setScope({ userId: currentUser.id, workspaceId: currentUser.workspaceId });
    await Promise.all([
      loadUsers(currentUser),
      loadTickets(),
      loadCategories(),
      loadResponseTemplates(),
      loadSatisfactionEntries()
    ]);
    await refreshPendingSyncStatus();
    await initializeSyncCheckpoint();
    await realtimeService.subscribe({
      userId: currentUser.id,
      workspaceId: currentUser.workspaceId,
      getAccessToken: () => auth.getAccessToken()
    });
    await refreshNotificationList();
    modalView.hideLogin();
    window.requestAnimationFrame(updateMobileHeaderHeight);
    if (btnNewTicket) {
      btnNewTicket.disabled = false;
      btnNewTicket.style.opacity = '1';
    }
    if (btnManageUsers) btnManageUsers.classList.toggle('hidden', !auth.canManageUsers(currentUser));
    if (profileManageUsersBtn) profileManageUsersBtn.classList.toggle('hidden', !auth.canManageUsers(currentUser));
    if (btnManageCategories) btnManageCategories.classList.toggle('hidden', !auth.canManageCategories(currentUser));
    const sessionUserName = document.getElementById('sessionUserName');
    const sessionUserRole = document.getElementById('sessionUserRole');
    if (sessionUserName) sessionUserName.textContent = currentUser.fullName;
    if (sessionUserRole) sessionUserRole.textContent = currentUser.role;
    renderHeaderUser(currentUser);
    if (profileModal && !profileModal.classList.contains('hidden')) renderProfileSummary(currentUser);
  } else {
    realtimeService.stop();
    activeUser = null;
    mutations.setScope(null);
    modalView.showLogin();
    if (btnNewTicket) {
      btnNewTicket.disabled = true;
      btnNewTicket.style.opacity = '0.5';
    }
    if (btnManageUsers) btnManageUsers.classList.add('hidden');
    if (profileManageUsersBtn) profileManageUsersBtn.classList.add('hidden');
    if (btnManageCategories) btnManageCategories.classList.add('hidden');
    const sessionUserName = document.getElementById('sessionUserName');
    const sessionUserRole = document.getElementById('sessionUserRole');
    if (sessionUserName) sessionUserName.textContent = 'Invitado';
    if (sessionUserRole) sessionUserRole.textContent = 'Sin sesión';
    renderHeaderUser(null);
    usersMap.clear();
    allTickets = [];
    ticketCategories = [];
    renderCategoryOptions();
    closeCategoriesModal();
    document.getElementById('categoryList').replaceChildren();
    notifications = [];
    responseTemplates = [];
    satisfactionEntries = [];
    renderNotifications();
    document.getElementById('notificationBadge').classList.add('hidden');
    document.getElementById('notificationsPanel').classList.add('hidden');
    document.getElementById('btnNotifications').setAttribute('aria-expanded', 'false');
    document.getElementById('pendingSyncStatus').classList.add('hidden');
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
  const reconnected = status === 'connected' && lastRealtimeStatus !== 'connected';
  lastRealtimeStatus = status;
  if (reconnected) void handleConnectionRestored();
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
  trackMobileOverlayOpen('satisfaction');
}

function closeSatisfactionModal() {
  const wasOpen = !document.getElementById('satisfactionModal').classList.contains('hidden');
  document.getElementById('satisfactionModal').classList.add('hidden');
  if (wasOpen) trackMobileOverlayClose('satisfaction');
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
  splashScreen.hide({ ready: false });
  const message = /tickets\.(sla_due_at|sla_warning_at|category)|column .*sla_(due|warning)_at does not exist|category.*tickets|response_templates|ticket_satisfaction/i.test(error.message || '')
    ? 'Falta aplicar una migración pendiente en Supabase. Desde kanban-ticket-management, ejecuta: npx.cmd supabase db push --linked'
    : error.message || 'Error al iniciar la aplicación';
  showToast(message, 10_000);
});

export { db, auth, ticketService };
