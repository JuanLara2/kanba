import { SupabaseClient } from './data/supabaseClient.js';
import { SupabaseAdapter } from './data/db.js';
import { AuthService } from './services/authService.js';
import { TicketService } from './services/ticketService.js';
import { FilterSortService } from './services/filterService.js';
import { BoardView } from './ui/boardView.js';
import { ModalView } from './ui/modalView.js';
import { DragDropController } from './ui/dragDrop.js';
import { initializeThemeController } from './ui/themeController.js';
import { SLA_REFRESH_INTERVAL_MS } from './config/constants.js';

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
  dueFilter: document.getElementById('filterSla'),
  sortField: document.getElementById('sortField'),
  sortDirection: document.getElementById('sortDirection')
};

let allTickets = [];
let usersMap = new Map();
let activeUser = null;
let boardView;
let modalView;
let dragDropController;

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
    },
    onEditRequest: async (ticketId) => {
      const ticket = allTickets.find((item) => item.id === ticketId);
      if (ticket) {
        const user = await auth.getCurrentUser();
        modalView.openTicket(ticket, {
          canEdit: auth.canEditTicket(user, ticket),
          canManageAssignment: auth.canAssignOrSetDue(user),
          canDelete: auth.canDelete(user)
        });
      }
    }
  });

  bindStaticEvents();
  await syncAuthState();
  renderBoard();
  window.setInterval(() => {
    if (activeUser && modalEl.classList.contains('hidden') && !boardEl.contains(document.activeElement)) {
      renderBoard();
    }
  }, SLA_REFRESH_INTERVAL_MS);
}

async function loadUsers() {
  const users = await db.getAll('users');
  usersMap.clear();
  users.forEach((user) => usersMap.set(user.id, user));
  populateAssigneeSelect(users);
}

function populateAssigneeSelect(users) {
  const select = document.getElementById('formAssignee');
  select.innerHTML = '<option value="">Sin asignar</option>';

  users.filter((user) => user.role === 'Admin' || user.role === 'Agent').forEach((user) => {
    const option = document.createElement('option');
    option.value = user.id;
    option.textContent = `${user.fullName} (${user.role})`;
    select.appendChild(option);
  });

  const filterSelect = filters.assignedTo;
  filterSelect.innerHTML = '<option value="ALL">Todos los miembros</option>';
  users.forEach((user) => {
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
  document.getElementById('btnNewTicket').addEventListener('click', async () => {
    const user = await auth.getCurrentUser();
    modalView.openTicket(null, { canManageAssignment: auth.canAssignOrSetDue(user) });
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
  document.getElementById('modalCloseBtn').addEventListener('click', () => modalView.closeTicket());
  document.getElementById('btnCancelModal').addEventListener('click', () => modalView.closeTicket());
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
        assignedTo,
        dueDate
      });
      showToast('Ticket actualizado correctamente');
    } else {
      await ticketService.createTicket({ title, description, priority, initialStatus, assignedTo, dueDate });
      showToast('Ticket creado correctamente');
    }

    await loadTickets();
    modalView.closeTicket();
    renderBoard();
  } catch (error) {
    showToast(error.message || 'No se pudo guardar el ticket');
  }
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
    return;
  }

  const criteria = {
    search: filters.search.value,
    assignedTo: filters.assignedTo.value,
    status: filters.status.value,
    priority: filters.priority.value,
    dueFilter: filters.dueFilter.value,
    sortField: filters.sortField.value,
    sortDirection: filters.sortDirection.value
  };

  const visibleTickets = FilterSortService.apply(allTickets, criteria, usersMap);
  boardView.render(visibleTickets);
}

function showToast(message) {
  const toast = document.getElementById('toastNotification');
  toast.textContent = message;
  toast.classList.remove('hidden');
  clearTimeout(showToast.timeoutId);
  showToast.timeoutId = setTimeout(() => toast.classList.add('hidden'), 2200);
}

async function syncAuthState() {
  const currentUser = await auth.getCurrentUser();
  const btnNewTicket = document.getElementById('btnNewTicket');
  const btnManageUsers = document.getElementById('btnManageUsers');

  if (currentUser) {
    await Promise.all([loadUsers(), loadTickets()]);
    activeUser = currentUser;
    modalView.hideLogin();
    btnNewTicket.disabled = false;
    btnNewTicket.style.opacity = '1';
    btnManageUsers.classList.toggle('hidden', !auth.canManageUsers(currentUser));
    document.getElementById('sessionUserName').textContent = currentUser.fullName;
    document.getElementById('sessionUserRole').textContent = currentUser.role;
  } else {
    activeUser = null;
    modalView.showLogin();
    btnNewTicket.disabled = true;
    btnNewTicket.style.opacity = '0.5';
    btnManageUsers.classList.add('hidden');
    document.getElementById('sessionUserName').textContent = 'Invitado';
    document.getElementById('sessionUserRole').textContent = 'Sin sesión';
    usersMap.clear();
    allTickets = [];
    boardEl.innerHTML = '';
    populateAssigneeSelect([]);
  }
}

bootstrap().catch((error) => {
  console.error(error);
  showToast('Error al iniciar la aplicación');
});

export { db, auth, ticketService };
