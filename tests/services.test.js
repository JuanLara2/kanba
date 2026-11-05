import assert from 'node:assert/strict';
import test from 'node:test';
import { AuthService } from '../js/services/authService.js';
import { SupabaseAdapter } from '../js/data/db.js';
import { FilterSortService } from '../js/services/filterService.js';
import { SupabaseClient } from '../js/data/supabaseClient.js';
import { getChecklistProgress, normalizeChecklist, TicketService } from '../js/services/ticketService.js';
import { formatSlaRemaining, getSlaState } from '../js/services/slaService.js';
import { calculateTicketMetrics, metricsToCsv } from '../js/services/metricsService.js';
import { RealtimeService } from '../js/services/realtimeService.js';
import { initializeThemeController, THEME_STORAGE_KEY } from '../js/ui/themeController.js';
import { CalendarView, dueDateForCalendarDay, getMonthGridDates, localDateKey } from '../js/ui/calendarView.js';
import { DragDropController } from '../js/ui/dragDrop.js';

function createContext() {
  const users = [
    { id: 'usr-admin-01', fullName: 'Carlos Administrador', email: 'admin@nexus.com', role: 'Admin', workspaceId: 'workspace-test', password: 'AdminPassword123!' },
    { id: 'usr-agent-01', fullName: 'Laura Agente', email: 'laura@nexus.com', role: 'Agent', workspaceId: 'workspace-test', password: 'AgentPassword123!' },
    { id: 'usr-reporter-01', fullName: 'Pedro Reportero', email: 'pedro@nexus.com', role: 'Reporter', workspaceId: 'workspace-test', password: 'ReporterPassword123!' },
    { id: 'usr-isolated-01', fullName: 'Otra persona', email: 'other@example.com', role: 'Agent', workspaceId: 'another-workspace', password: 'OtherPassword123!' }
  ];
  const tickets = [];
  const comments = [];
  const notifications = [];
  const satisfaction = [];
  const responseTemplates = [];
  const categories = [
    'Soporte técnico',
    'Accesos',
    'Incidente',
    'Solicitud de servicio',
    'Consulta',
    'Mejora',
    'Nómina y Pagos'
  ];
  const stores = { users, tickets };
  const sessions = new Map();
  let createdUserId = 0;
  const db = {
    async getAll(storeName) {
      return stores[storeName].slice();
    },
    async getCategories() {
      return categories.slice();
    },
    async createCategory(name) {
      categories.push(name);
      return name;
    },
    async getCategoryUsage(name) {
      return tickets.some((ticket) => ticket.category === name);
    },
    async deleteCategory(name) {
      const index = categories.indexOf(name);
      if (index === -1) throw new Error('La categoría ya no existe.');
      categories.splice(index, 1);
      return name;
    },
    async getById(storeName, id) {
      return stores[storeName].find((item) => item.id === id) || null;
    },
    async put(storeName, value) {
      const store = stores[storeName];
      const index = store.findIndex((item) => item.id === value.id);
      if (index === -1) store.push(value);
      else store[index] = value;
      return value;
    },
    async delete(storeName, id) {
      const store = stores[storeName];
      const index = store.findIndex((item) => item.id === id);
      if (index !== -1) store.splice(index, 1);
    },
    async getComments(ticketId) {
      return comments.filter((comment) => comment.ticketId === ticketId);
    },
    async createComment(ticketId, body) {
      const comment = {
        id: comments.length + 1,
        ticketId,
        authorId: auth.currentUser.id,
        body,
        createdAt: new Date().toISOString()
      };
      comments.push(comment);
      return comment;
    },
    async getNotifications(userId) {
      return notifications.filter((notification) => notification.userId === userId);
    },
    async markNotificationRead(notificationId) {
      const notification = notifications.find((item) => item.id === Number(notificationId));
      if (!notification) throw new Error('No existe la notificación.');
      notification.readAt = new Date().toISOString();
      return notification;
    },
    async getSatisfaction(ticketId) {
      return satisfaction.find((entry) => entry.ticketId === ticketId) || null;
    },
    async getAllSatisfaction() {
      return satisfaction.slice();
    },
    async submitSatisfaction(ticketId, rating, comment) {
      if (satisfaction.some((entry) => entry.ticketId === ticketId)) {
        throw new Error('Ya se envió una valoración para este ticket.');
      }
      const entry = {
        ticketId,
        rating,
        comment: comment || null,
        submittedBy: auth.currentUser.id,
        createdAt: new Date().toISOString()
      };
      satisfaction.push(entry);
      return entry;
    },
    async getResponseTemplates() {
      return responseTemplates.slice();
    },
    async saveResponseTemplate(template) {
      const existing = responseTemplates.find((item) => item.id === template.id);
      if (existing) Object.assign(existing, template);
      else responseTemplates.push({ ...template, id: `template-${responseTemplates.length + 1}` });
      return existing || responseTemplates.at(-1);
    },
    async deleteResponseTemplate(templateId) {
      const index = responseTemplates.findIndex((item) => item.id === templateId);
      if (index !== -1) responseTemplates.splice(index, 1);
    },
    async createUser({ fullName, email, role, createWorkspace, workspaceName }) {
      const id = `usr-created-${++createdUserId}`;
      const user = {
        id,
        fullName,
        email,
        role: createWorkspace ? 'Admin' : role,
        workspaceName,
        workspaceId: createWorkspace ? `workspace-created-${createdUserId}` : 'workspace-test'
      };
      users.push(user);
      return user;
    },
    async updateUserRole(userId, role) {
      const user = users.find((item) => item.id === userId);
      if (!user) throw new Error('El usuario no existe.');
      user.role = role;
      return role;
    }
  };
  const client = {
    async requestAuth(path, options = {}) {
      if (path === 'token?grant_type=password') {
        const user = users.find((item) => item.email === options.body.email && item.password === options.body.password);
        if (!user) {
          const error = new Error('Invalid login credentials');
          error.status = 400;
          throw error;
        }
        const accessToken = `access-${user.id}`;
        sessions.set(accessToken, user.id);
        return { access_token: accessToken, refresh_token: `refresh-${user.id}`, expires_in: 3600, user: { id: user.id } };
      }
      if (path === 'token?grant_type=refresh_token') {
        const userId = options.body.refresh_token.replace('refresh-', '');
        const accessToken = `refreshed-${userId}`;
        sessions.set(accessToken, userId);
        return { access_token: accessToken, refresh_token: `refresh-${userId}`, expires_in: 3600, user: { id: userId } };
      }
      if (path === 'user') {
        return { id: sessions.get(options.accessToken) };
      }
      if (path === 'logout') return null;
      throw new Error(`Unexpected auth request: ${path}`);
    }
  };

  const stored = new Map();
  globalThis.localStorage = {
    getItem(key) {
      return stored.get(key) ?? null;
    },
    setItem(key, value) {
      stored.set(key, value);
    },
    removeItem(key) {
      stored.delete(key);
    }
  };

  const auth = new AuthService(client, db);
  return { users, tickets, categories, db, auth, ticketService: new TicketService(db, auth) };
}

test('theme selector restores, applies, and persists only supported themes', () => {
  const stored = new Map([[THEME_STORAGE_KEY, 'pink']]);
  const listeners = new Map();
  const selector = {
    value: '',
    addEventListener(event, handler) {
      listeners.set(event, handler);
    }
  };
  const documentRef = {
    documentElement: { dataset: {} },
    getElementById(id) {
      assert.equal(id, 'themeSelect');
      return selector;
    }
  };
  const storage = {
    getItem(key) {
      return stored.get(key) ?? null;
    },
    setItem(key, value) {
      stored.set(key, value);
    }
  };

  const setTheme = initializeThemeController(documentRef, storage);
  assert.equal(documentRef.documentElement.dataset.theme, 'pink');
  assert.equal(selector.value, 'pink');

  selector.value = 'light';
  listeners.get('change')();
  assert.equal(documentRef.documentElement.dataset.theme, 'light');
  assert.equal(stored.get(THEME_STORAGE_KEY), 'light');

  setTheme('unknown');
  assert.equal(documentRef.documentElement.dataset.theme, 'light');
});

test('drag and drop handlers safely resolve text-node event targets', async () => {
  const handlers = new Map();
  const boardEl = {
    addEventListener(type, handler) {
      handlers.set(type, handler);
    }
  };
  const card = {
    nodeType: 1,
    dataset: { ticketId: 'TCK-1001' },
    classList: {
      add() {},
      remove() {}
    },
    closest(selector) {
      return selector === '.ticket-card' ? this : null;
    }
  };
  const dropZone = {
    nodeType: 1,
    dataset: { status: 'open' },
    closest(selector) {
      return selector === '.drop-zone' ? this : null;
    }
  };
  const changes = [];
  new DragDropController({
    boardEl,
    onStatusChange: async (...args) => changes.push(args)
  });

  const handle = {
    nodeType: 1,
    closest(selector) {
      if (selector === '.card-drag-handle') return this;
      if (selector === '.ticket-card') return card;
      if (selector.includes('button')) return this;
      return null;
    }
  };
  const textTarget = { nodeType: 3, parentElement: handle };
  const dataTransfer = {
    effectAllowed: '',
    dropEffect: '',
    setData() {},
    getData() {
      return 'TCK-1001';
    }
  };

  let backgroundDragPrevented = false;
  handlers.get('dragstart')({
    target: card,
    dataTransfer,
    preventDefault() { backgroundDragPrevented = true; }
  });
  handlers.get('dragstart')({ target: textTarget, dataTransfer, preventDefault() {} });
  handlers.get('dragend')({ target: textTarget });
  handlers.get('dragover')({ target: { nodeType: 3, parentElement: dropZone }, preventDefault() {}, dataTransfer });
  await handlers.get('drop')({
    target: { nodeType: 3, parentElement: dropZone },
    preventDefault() {},
    dataTransfer
  });
  handlers.get('click')({ target: textTarget });

  assert.equal(backgroundDragPrevented, true);
  assert.equal(dataTransfer.effectAllowed, 'move');
  assert.equal(dataTransfer.dropEffect, 'move');
  assert.deepEqual(changes, [['TCK-1001', 'open']]);
});

test('ticket status controls do not trigger the card detail click handler', () => {
  const handlers = new Map();
  const card = {
    nodeType: 1,
    dataset: { ticketId: 'TCK-1001' },
    closest(selector) {
      return selector === '.ticket-card' ? this : null;
    }
  };
  const button = {
    nodeType: 1,
    closest(selector) {
      if (selector === '.ticket-card') return card;
      if (selector.includes('button')) return this;
      return null;
    }
  };
  const boardEl = {
    addEventListener(type, handler) {
      handlers.set(type, handler);
    }
  };
  const openedTickets = [];
  new DragDropController({
    boardEl,
    onEditRequest: (ticketId) => openedTickets.push(ticketId)
  });

  handlers.get('click')({ target: button });
  handlers.get('click')({ target: card });

  assert.deepEqual(openedTickets, ['TCK-1001']);
});

test('Supabase login authenticates each configured role and stores a managed session', async () => {
  const { auth } = createContext();

  assert.equal((await auth.login('admin@nexus.com', 'AdminPassword123!')).role, 'Admin');
  assert.equal((await auth.login('laura@nexus.com', 'AgentPassword123!')).role, 'Agent');
  assert.equal((await auth.login('pedro@nexus.com', 'ReporterPassword123!')).role, 'Reporter');
  await assert.rejects(() => auth.login('admin@nexus.com', 'incorrect'), /Credenciales inválidas/);
});

test('Supabase password recovery sends a normalized email to the configured redirect URL', async () => {
  const { auth } = createContext();
  let request;
  auth.client.requestAuth = async (path, options) => {
    request = { path, options };
    return null;
  };

  await auth.requestPasswordReset(' User@Example.com ', 'https://juanlara2.github.io/kanba/');

  assert.equal(request.path, 'recover?redirect_to=https%3A%2F%2Fjuanlara2.github.io%2Fkanba%2F');
  assert.deepEqual(request.options, {
    method: 'POST',
    body: { email: 'user@example.com' }
  });
  await auth.requestPasswordReset('user@example.com', 'http://127.0.0.1:8765/');
  await assert.rejects(
    () => auth.requestPasswordReset('not-an-email', 'https://juanlara2.github.io/kanba/'),
    /correo electrónico válido/
  );
  await assert.rejects(
    () => auth.requestPasswordReset('user@example.com', 'http://example.com/'),
    /debe usar HTTPS/
  );
  await assert.rejects(
    () => auth.requestPasswordReset('user@example.com', 'ftp://localhost/'),
    /debe usar HTTPS/
  );
});

test('Supabase password update uses an active or password-recovery access token', async () => {
  const { auth } = createContext();
  await auth.login('admin@nexus.com', 'AdminPassword123!');
  let update;
  auth.client.requestAuth = async (path, options) => {
    update = { path, options };
    return {};
  };

  await auth.updatePassword('ChangedPassword123');
  assert.equal(update.path, 'user');
  assert.equal(update.options.method, 'PUT');
  assert.equal(update.options.accessToken, 'access-usr-admin-01');
  assert.deepEqual(update.options.body, { password: 'ChangedPassword123' });

  auth.clearSession();
  await auth.updatePassword('RecoveredPassword123', 'recovery-access-token');
  assert.equal(update.options.accessToken, 'recovery-access-token');
  assert.equal(localStorage.getItem('nexusdesk-supabase-session'), null);
  await assert.rejects(() => auth.updatePassword('short'), /al menos 12 caracteres/);
});

test('Supabase auth refreshes an expired access token before database requests', async () => {
  const { auth } = createContext();
  await auth.login('admin@nexus.com', 'AdminPassword123!');

  const session = JSON.parse(localStorage.getItem('nexusdesk-supabase-session'));
  session.expires_at = 0;
  localStorage.setItem('nexusdesk-supabase-session', JSON.stringify(session));

  assert.equal(await auth.getAccessToken(), 'refreshed-usr-admin-01');
  const refreshedSession = JSON.parse(localStorage.getItem('nexusdesk-supabase-session'));
  assert.ok(refreshedSession.expires_at > Date.now());
});

test('Supabase auth clears the session when its refresh token is no longer valid', async () => {
  const { auth } = createContext();
  await auth.login('admin@nexus.com', 'AdminPassword123!');

  const session = JSON.parse(localStorage.getItem('nexusdesk-supabase-session'));
  session.expires_at = 0;
  localStorage.setItem('nexusdesk-supabase-session', JSON.stringify(session));
  auth.client.requestAuth = async (path) => {
    if (path !== 'token?grant_type=refresh_token') throw new Error(`Unexpected auth request: ${path}`);
    const error = new Error('Invalid Refresh Token: Refresh Token Not Found');
    error.status = 400;
    throw error;
  };

  assert.equal(await auth.getAccessToken(), null);
  assert.equal(localStorage.getItem('nexusdesk-supabase-session'), null);
});

test('Supabase auth clears a stored session that no longer exists on the server', async () => {
  const { auth } = createContext();
  await auth.login('admin@nexus.com', 'AdminPassword123!');
  auth.currentUser = null;
  auth.client.requestAuth = async (path) => {
    if (path !== 'user') throw new Error(`Unexpected auth request: ${path}`);
    const error = new Error('Session from session_id claim in JWT does not exist');
    error.status = 403;
    throw error;
  };

  assert.equal(await auth.getCurrentUser(), null);
  assert.equal(localStorage.getItem('nexusdesk-supabase-session'), null);
});

test('only administrators can create users through the secure provisioning adapter', async () => {
  const { auth, users } = createContext();

  await assert.rejects(
    () => auth.registerUser({
      fullName: 'Nueva persona',
      email: 'new@example.com',
      password: 'SecurePassword123',
      role: 'Agent'
    }),
    /Solo un administrador/
  );

  await auth.login('admin@nexus.com', 'AdminPassword123!');
  const created = await auth.registerUser({
    fullName: 'Nueva agente',
    email: ' NEW.AGENT@example.com ',
    password: 'SecurePassword123',
    role: 'Agent'
  });
  const stored = users.find((user) => user.id === created.id);

  assert.equal(created.email, 'new.agent@example.com');
  assert.equal(created.role, 'Agent');
  assert.equal('password' in stored, false);
  await assert.rejects(
    () => auth.registerUser({
      fullName: 'Duplicada',
      email: 'new.agent@example.com',
      password: 'SecurePassword123',
      role: 'Reporter'
    }),
    /ya se encuentra registrado/
  );
  await assert.rejects(
    () => auth.registerUser({
      fullName: 'Clave corta',
      email: 'short@example.com',
      password: 'short',
      role: 'Reporter'
    }),
    /al menos 12/
  );
});

test('only admins can change existing user roles and the active profile can be refreshed', async () => {
  const { auth, users } = createContext();
  const admin = users.find((user) => user.role === 'Admin');
  const agent = users.find((user) => user.role === 'Agent');

  await assert.rejects(() => auth.updateUserRole(agent.id, 'Reporter'), /Solo un administrador/);
  await auth.login(admin.email, 'AdminPassword123!');
  assert.equal(await auth.updateUserRole(agent.id, 'Reporter'), 'Reporter');
  assert.equal(agent.role, 'Reporter');
  await assert.rejects(() => auth.updateUserRole(agent.id, 'Owner'), /rol seleccionado no es válido/);

  assert.equal(await auth.updateUserRole(admin.id, 'Agent'), 'Agent');
  assert.equal((await auth.refreshCurrentUser()).role, 'Agent');
});

test('ticket operations enforce roles and preserve state audit history', async () => {
  const { auth, users, ticketService } = createContext();
  const admin = users.find((user) => user.role === 'Admin');
  const agent = users.find((user) => user.role === 'Agent');
  const reporter = users.find((user) => user.role === 'Reporter');

  await auth.login(admin.email, 'AdminPassword123!');
  const ticket = await ticketService.createTicket({ title: 'Solicitud inicial', description: 'Detalle requerido' });

  await auth.login(reporter.email, 'ReporterPassword123!');
  await assert.rejects(
    () => ticketService.changeTicketStatus(ticket.id, 'open'),
    /Permisos insuficientes/
  );
  await assert.rejects(
    () => ticketService.createTicket({
      title: 'Solicitud asignada',
      description: 'Detalle requerido',
      assignedTo: agent.id
    }),
    /no puede asignar/
  );
  await assert.rejects(
    () => ticketService.createTicket({
      title: 'Solicitud cerrada',
      description: 'Detalle requerido',
      initialStatus: 'closed'
    }),
    /solo pueden crear/
  );

  await auth.login(admin.email, 'AdminPassword123!');
  await ticketService.changeTicketStatus(ticket.id, 'open');
  await auth.login(agent.email, 'AgentPassword123!');
  await ticketService.changeTicketStatus(ticket.id, 'in_progress');

  assert.deepEqual(
    ticket.statusHistory.map(({ from, to, changedBy }) => [from, to, changedBy]),
    [['new', 'open', admin.id], ['open', 'in_progress', agent.id]]
  );
  assert.equal(ticket.updatedAt, ticket.statusHistory.at(-1).changedAt);

  const originalTitle = ticket.title;
  await auth.login('admin@nexus.com', 'AdminPassword123!');
  const otherAgent = { ...agent, id: 'usr-other-agent' };
  auth.getCurrentUser = async () => otherAgent;
  await ticketService.updateTicket({
    id: ticket.id,
    title: 'Edición no autorizada',
    description: 'No debe aplicarse',
    priority: 'Urgente'
  });
  assert.equal(ticket.title, originalTitle);
});

test('ticket checklists validate subtasks, persist updates, and respect ticket edit permissions', async () => {
  const { auth, users, ticketService } = createContext();
  const admin = users.find((user) => user.role === 'Admin');
  const agent = users.find((user) => user.role === 'Agent');
  const reporter = users.find((user) => user.role === 'Reporter');
  const checklist = [
    { text: 'Analizar logs', completed: true },
    { text: 'Probar en staging', completed: false }
  ];

  await auth.login(admin.email, 'AdminPassword123!');
  const ticket = await ticketService.createTicket({
    title: 'Tarea con subtareas',
    description: 'Verificar progreso asociado al ticket.',
    assignedTo: agent.id,
    checklist
  });
  assert.deepEqual(ticket.checklist, checklist);
  const lockedTicket = await ticketService.createTicket({
    title: 'Ticket restringido',
    description: 'El agente no puede cambiar sus subtareas.',
    initialStatus: 'closed'
  });

  await auth.login(agent.email, 'AgentPassword123!');
  const updatedChecklist = [
    { text: 'Analizar logs', completed: true },
    { text: 'Probar en staging', completed: true }
  ];
  await ticketService.updateTicket({
    id: ticket.id,
    title: ticket.title,
    description: ticket.description,
    priority: ticket.priority,
    checklist: updatedChecklist
  });
  assert.deepEqual(ticket.checklist, updatedChecklist);
  await ticketService.setChecklistCompletion(ticket.id, 0, 'Analizar logs', false);
  assert.deepEqual(ticket.checklist, [
    { text: 'Analizar logs', completed: false },
    { text: 'Probar en staging', completed: true }
  ]);
  await assert.rejects(
    () => ticketService.setChecklistCompletion(ticket.id, 0, 'Texto obsoleto', true),
    /La subtarea cambió/
  );
  await ticketService.updateTicket({
    id: lockedTicket.id,
    title: 'Intento de edición no autorizado',
    description: 'No debe modificar este ticket.',
    priority: 'Urgente',
    checklist: [{ text: 'No debe agregarse', completed: false }]
  });
  assert.deepEqual(lockedTicket.checklist, []);
  assert.equal(lockedTicket.title, 'Ticket restringido');

  await auth.login(reporter.email, 'ReporterPassword123!');
  await assert.rejects(
    () => ticketService.createTicket({
      title: 'Ticket sin permiso',
      description: 'No debe permitir subtareas al reportero.',
      checklist: [{ text: 'No autorizada', completed: false }]
    }),
    /no puede asignar responsables/
  );
  await assert.rejects(
    () => ticketService.setChecklistCompletion(ticket.id, 0, 'Analizar logs', true),
    /Permisos insuficientes/
  );

  assert.deepEqual(normalizeChecklist(checklist), checklist);
  assert.throws(() => normalizeChecklist([{ text: '   ', completed: false }]), /entre 1 y 200 caracteres/);
  assert.throws(() => normalizeChecklist([{ text: 'Subtarea', completed: 'false' }]), /estado de cada subtarea/);
  assert.throws(() => normalizeChecklist(Array.from({ length: 101 }, () => ({ text: 'Paso', completed: false }))), /hasta 100/);
  assert.deepEqual(getChecklistProgress(checklist), { completed: 1, total: 2, percentage: 50 });
  assert.deepEqual(getChecklistProgress([]), { completed: 0, total: 0, percentage: 0 });
});

test('calendar rescheduling is restricted to team admins and agents and changes only the due date', async () => {
  const { auth, db, users, ticketService } = createContext();
  const admin = users.find((user) => user.role === 'Admin');
  const agent = users.find((user) => user.role === 'Agent');
  const reporter = users.find((user) => user.role === 'Reporter');

  await auth.login(admin.email, 'AdminPassword123!');
  const ticket = await ticketService.createTicket({
    title: 'Ticket para calendario',
    description: 'Debe conservar el resto de sus datos.',
    assignedTo: agent.id,
    dueDate: '2026-10-25T09:30:00.000Z'
  });
  const original = { ...ticket };

  await auth.login(agent.email, 'AgentPassword123!');
  await ticketService.rescheduleTicket(ticket.id, '2026-10-26T09:30:00.000Z');
  assert.equal(ticket.dueDate, '2026-10-26T09:30:00.000Z');
  assert.equal(ticket.title, original.title);
  assert.equal(ticket.description, original.description);
  assert.equal(ticket.status, original.status);
  assert.equal(ticket.priority, original.priority);
  assert.equal(ticket.assignedTo, original.assignedTo);
  assert.equal(ticket.createdBy, original.createdBy);

  await auth.login(reporter.email, 'ReporterPassword123!');
  await assert.rejects(
    () => ticketService.rescheduleTicket(ticket.id, null),
    /Solo Admin y Agent/
  );
  assert.equal(ticket.dueDate, '2026-10-26T09:30:00.000Z');

  await auth.login(agent.email, 'AgentPassword123!');
  await assert.rejects(
    () => ticketService.rescheduleTicket(ticket.id, 'invalid-date'),
    /fecha límite no es válida/
  );

  const otherWorkspaceTicket = {
    ...ticket,
    id: 'TCK-9999',
    workspaceId: 'another-workspace'
  };
  await db.put('tickets', otherWorkspaceTicket);
  await assert.rejects(
    () => ticketService.rescheduleTicket(otherWorkspaceTicket.id, null),
    /otro espacio de trabajo/
  );
  assert.equal(otherWorkspaceTicket.dueDate, '2026-10-26T09:30:00.000Z');
});

test('calendar date helpers build Monday-first month grids and preserve the due time', () => {
  const month = new Date(2026, 9, 1);
  const dates = getMonthGridDates(month);
  assert.equal(dates.length, 42);
  assert.equal(dates[0].getDay(), 1);
  assert.equal(dates.at(-1).getDay(), 0);
  assert.equal(localDateKey(new Date(2026, 9, 25)), '2026-10-25');
  assert.equal(localDateKey(null), '');

  const priorDueDate = new Date(2026, 9, 25, 9, 30);
  const movedDueDate = new Date(dueDateForCalendarDay(new Date(2026, 9, 26), priorDueDate));
  assert.equal(localDateKey(movedDueDate), '2026-10-26');
  assert.equal(movedDueDate.getHours(), 9);
  assert.equal(movedDueDate.getMinutes(), 30);

  const newlyScheduledDate = new Date(dueDateForCalendarDay(new Date(2026, 9, 26)));
  assert.equal(newlyScheduledDate.getHours(), 17);
  assert.equal(newlyScheduledDate.getMinutes(), 0);
});

test('calendar ticket touch captures the pointer only after drag movement starts on its handle', () => {
  const handlers = new Map();
  const container = {
    addEventListener(type, handler) {
      handlers.set(type, handler);
    },
    contains() {
      return false;
    },
  };
  let captures = 0;
  let preventions = 0;
  const ticket = {
    dataset: { ticketId: 'TCK-1001' },
    classList: {
      add() {},
      remove() {},
    },
    setPointerCapture() {
      captures += 1;
    }
  };
  const handle = {
    nodeType: 1,
    closest(selector) {
      if (selector === '.calendar-drag-handle') return this;
      if (selector === '[data-calendar-ticket].can-drag') return ticket;
      return null;
    }
  };
  const ticketTarget = {
    nodeType: 1,
    closest(selector) {
      return selector === '[data-calendar-ticket].can-drag' ? ticket : null;
    }
  };
  const originalDocument = globalThis.document;
  globalThis.document = { elementFromPoint: () => null };
  const calendar = new CalendarView({ container, onDateChange() {}, canReschedule: true });

  try {
    handlers.get('pointerdown')({
      target: ticketTarget,
      isPrimary: true,
      button: 0,
      pointerId: 1,
      clientX: 10,
      clientY: 10
    });
    assert.equal(calendar.pointerDrag, null);

    handlers.get('pointerdown')({
      target: handle,
      isPrimary: true,
      button: 0,
      pointerId: 2,
      clientX: 10,
      clientY: 10
    });
    assert.equal(captures, 0);

    const pointerMove = (clientX) => handlers.get('pointermove')({
      pointerId: 2,
      clientX,
      clientY: 10,
      preventDefault() {
        preventions += 1;
      },
    });
    pointerMove(14);
    assert.equal(captures, 0);
    assert.equal(preventions, 0);

    pointerMove(16);
    assert.equal(captures, 1);
    assert.equal(preventions, 1);
  } finally {
    if (originalDocument === undefined) delete globalThis.document;
    else globalThis.document = originalDocument;
  }
});

test('only administrators delete tickets and invalid ticket fields are rejected', async () => {
  const { auth, users, tickets, ticketService } = createContext();
  const admin = users.find((user) => user.role === 'Admin');
  const reporter = users.find((user) => user.role === 'Reporter');

  await auth.login(admin.email, 'AdminPassword123!');
  const ticket = await ticketService.createTicket({ title: 'Solicitud válida', description: 'Detalle requerido' });
  await assert.rejects(
    () => ticketService.createTicket({ title: 'abc', description: 'Detalle requerido' }),
    /al menos 4/
  );
  await assert.rejects(
    () => ticketService.createTicket({ title: 'Título válido', description: 'Detalle requerido', priority: 'P0' }),
    /prioridad no es válida/
  );
  await assert.rejects(
    () => ticketService.createTicket({
      title: 'Fecha inválida',
      description: 'Detalle requerido',
      dueDate: 'invalid-date'
    }),
    /fecha límite no es válida/
  );

  await auth.login(reporter.email, 'ReporterPassword123!');
  await assert.rejects(() => ticketService.deleteTicket(ticket.id), /Solo un administrador/);
  await auth.login(admin.email, 'AdminPassword123!');
  await ticketService.deleteTicket(ticket.id);
  assert.equal(tickets.length, 0);
});

test('admin-created members share assigned tickets while other workspaces stay isolated', async () => {
  const { auth, ticketService } = createContext();
  await auth.login('admin@nexus.com', 'AdminPassword123!');
  const createdAgent = await auth.registerUser({
    fullName: 'Agente aislado',
    email: 'isolated.agent@example.com',
    password: 'SecurePassword123',
    role: 'Agent'
  });

  assert.equal(createdAgent.workspaceId, 'workspace-test');
  const ticket = await ticketService.createTicket({
    title: 'Ticket del equipo',
    description: 'El agente del mismo equipo debe poder verlo.',
    assignedTo: createdAgent.id
  });
  assert.equal(ticket.assignedTo, createdAgent.id);

  await assert.rejects(
    () => ticketService.createTicket({
      title: 'Ticket externo',
      description: 'No puede asignarse a otro equipo.',
      assignedTo: 'usr-isolated-01'
    }),
    /responsable debe pertenecer a tu espacio/
  );
});

test('admins can create an independent workspace with its own initial admin', async () => {
  const { auth } = createContext();
  await auth.login('admin@nexus.com', 'AdminPassword123!');
  const createdAdmin = await auth.registerUser({
    fullName: 'Admin de otro equipo',
    email: 'new.admin@example.com',
    password: 'SecurePassword123',
    role: 'Reporter',
    createWorkspace: true,
    workspaceName: 'Equipo Independiente'
  });

  assert.equal(createdAdmin.role, 'Admin');
  assert.equal(createdAdmin.workspaceId, 'workspace-created-1');
  assert.equal(createdAdmin.workspaceName, 'Equipo Independiente');
  assert.notEqual(createdAdmin.workspaceId, 'workspace-test');

  await assert.rejects(
    () => auth.registerUser({
      fullName: 'Equipo sin nombre',
      email: 'missing.workspace@example.com',
      password: 'SecurePassword123',
      createWorkspace: true
    }),
    /nombre del equipo debe tener entre 2 y 100 caracteres/
  );
});

test('unconfigured Supabase client refuses network requests with setup instructions', async () => {
  const client = new SupabaseClient({ url: '', anonKey: '' });
  await assert.rejects(() => client.requestAuth('token?grant_type=password', { method: 'POST' }), /SUPABASE_URL/);
});

test('Supabase adapter maps ticket rows and requests the database audit history', async () => {
  const calls = [];
  const ticketRow = {
    id: 'TCK-1001',
    title: 'Solicitud remota',
    description: 'Detalle requerido',
    status: 'open',
    priority: 'Alta',
    assigned_to: 'agent-id',
    created_by: 'reporter-id',
    workspace_id: 'workspace-id',
    created_at: '2026-10-20T09:00:00.000Z',
    updated_at: '2026-10-20T10:00:00.000Z',
    complexity_score: 6,
    due_date: null,
    sla_due_at: '2026-10-22T09:00:00.000Z',
    sla_warning_at: '2026-10-22T04:12:00.000Z',
    checklist: [{ text: 'Validar integración', completed: true }]
  };
  const client = {
    async requestRest(path, options) {
      calls.push({ path, options });
      if (path === 'tickets') return [ticketRow];
      if (path.startsWith('tickets?')) return [ticketRow];
      if (path.startsWith('profiles?')) {
        return [{
          id: 'admin-id',
          full_name: 'Admin',
          email: 'admin@example.com',
          role: 'Admin',
          workspace_id: 'workspace-id',
          created_by_admin_id: null
        }];
      }
      if (path.startsWith('ticket_status_history?')) {
        return [{
          ticket_id: 'TCK-1001',
          from_status: 'new',
          to_status: 'open',
          changed_at: '2026-10-20T10:00:00.000Z',
          changed_by: 'admin-id',
          assigned_to_at_change: 'agent-id'
        }];
      }
      throw new Error(`Unexpected request: ${path}`);
    }
  };
  const adapter = new SupabaseAdapter(client, async () => 'test-access-token');

  const [ticket] = await adapter.getAll('tickets');

  assert.equal(ticket.assignedTo, 'agent-id');
  assert.equal(ticket.workspaceId, 'workspace-id');
  assert.equal(ticket.slaDueAt, ticketRow.sla_due_at);
  assert.equal(ticket.slaWarningAt, ticketRow.sla_warning_at);
  assert.equal(ticket.complexityScore, 6);
  assert.deepEqual(ticket.checklist, [{ text: 'Validar integración', completed: true }]);
  assert.deepEqual(ticket.statusHistory, [{
    from: 'new',
    to: 'open',
    changedAt: '2026-10-20T10:00:00.000Z',
    changedBy: 'admin-id',
    assignedToAtChange: 'agent-id'
  }]);
  assert.equal(calls.length, 2);
  assert.ok(calls[0].path.startsWith('tickets?select='));
  assert.ok(calls[1].path.includes('ticket_id=in.("TCK-1001")'));

  await adapter.createTicket({
    id: 'client-id-must-not-be-used',
    title: 'Nueva solicitud',
    description: 'Detalle',
    status: 'new',
    priority: 'Media',
    complexityScore: 8,
    assignedTo: null,
    createdBy: 'client-user-id',
    dueDate: null,
    checklist: [{ text: 'Preparar pruebas', completed: false }]
  });
  assert.equal(calls[2].options.body.id, undefined);
  assert.equal(calls[2].options.body.complexity_score, 8);
  assert.equal(calls[2].options.body.created_by, undefined);
  assert.deepEqual(calls[2].options.body.checklist, [{ text: 'Preparar pruebas', completed: false }]);

  const [profile] = await adapter.getAll('users');
  assert.equal(profile.workspaceId, 'workspace-id');
  assert.equal(profile.createdByAdminId, null);

  const [syncIndex] = await adapter.getTicketSyncIndex();
  assert.deepEqual(syncIndex, { id: 'TCK-1001', updatedAt: ticketRow.updated_at });
  const [changedTicket] = await adapter.getTicketsUpdatedSince('2026-10-20T09:30:00.000Z');
  assert.equal(changedTicket.id, 'TCK-1001');
  assert.ok(calls.some(({ path }) => path.includes('updated_at=gt.2026-10-20T09%3A30%3A00.000Z')));
});

test('Supabase adapter reads and manages workspace ticket categories', async () => {
  const calls = [];
  const client = {
    async requestRest(path, options = {}) {
      calls.push({ path, options });
      if (path === 'ticket_categories?select=name&order=name.asc') {
        return [{ name: 'Consulta' }, { name: 'Facturación' }];
      }
      if (path === 'ticket_categories') return [{ name: options.body.name }];
      if (path.startsWith('tickets?select=id&category=')) return [{ id: 'TCK-1001' }];
      if (path.startsWith('ticket_categories?name=')) return [{ name: 'Facturación' }];
      throw new Error(`Unexpected request: ${path}`);
    }
  };
  const adapter = new SupabaseAdapter(client, async () => 'test-access-token');

  assert.deepEqual(await adapter.getCategories(), ['Consulta', 'Facturación']);
  assert.equal(await adapter.createCategory('Facturación'), 'Facturación');
  assert.equal(await adapter.getCategoryUsage('Facturación'), true);
  assert.equal(await adapter.deleteCategory('Facturación'), 'Facturación');
  assert.equal(calls[1].options.method, 'POST');
  assert.deepEqual(calls[1].options.body, { name: 'Facturación' });
  assert.equal(calls[2].options.method, undefined);
  assert.equal(calls[3].options.method, 'DELETE');
  assert.equal(calls[3].options.prefer, 'return=representation');
});

test('Supabase adapter changes roles through the authenticated database function', async () => {
  const calls = [];
  const client = {
    async requestRest(path, options) {
      calls.push({ path, options });
      return options.body.p_role;
    }
  };
  const adapter = new SupabaseAdapter(client, async () => 'test-access-token');

  assert.equal(await adapter.updateUserRole('user-123', 'Agent'), 'Agent');
  assert.deepEqual(calls, [{
    path: 'rpc/admin_update_user_role',
    options: {
      method: 'POST',
      accessToken: 'test-access-token',
      body: { p_user_id: 'user-123', p_role: 'Agent' }
    }
  }]);
});

test('SLA filters classify overdue, warning, and future SLA deadlines', () => {
  const originalNow = Date.now;
  const fixedNow = Date.parse('2026-10-25T12:00:00.000Z');
  Date.now = () => fixedNow;

  try {
    const tickets = [
      { id: 'overdue', status: 'in_progress', slaDueAt: '2026-10-25T11:00:00.000Z' },
      { id: 'warning', status: 'open', slaDueAt: '2026-10-26T00:00:00.000Z', slaWarningAt: '2026-10-25T11:00:00.000Z' },
      { id: 'future', status: 'new', slaDueAt: '2026-10-27T12:00:00.000Z', slaWarningAt: '2026-10-26T12:00:00.000Z' },
      { id: 'invalid', status: 'new', slaDueAt: 'not-a-date', slaWarningAt: 'not-a-date' }
    ];
    const usersMap = new Map();

    assert.deepEqual(FilterSortService.apply(tickets, { dueFilter: 'overdue' }, usersMap).map((item) => item.id), ['overdue']);
    assert.deepEqual(FilterSortService.apply(tickets, { dueFilter: 'warning' }, usersMap).map((item) => item.id), ['warning']);
    assert.deepEqual(FilterSortService.apply(tickets, { dueFilter: 'future' }, usersMap).map((item) => item.id), ['future']);
  } finally {
    Date.now = originalNow;
  }
});

test('SLA evaluation follows warning time, deadline, and completion state', () => {
  const now = Date.parse('2026-10-29T12:00:00.000Z');
  assert.equal(getSlaState({
    status: 'in_progress',
    slaWarningAt: '2026-10-29T11:00:00.000Z',
    slaDueAt: '2026-10-29T13:00:00.000Z'
  }, now).state, 'warning');
  assert.equal(getSlaState({
    status: 'open',
    slaWarningAt: '2026-10-29T11:00:00.000Z',
    slaDueAt: '2026-10-29T11:59:00.000Z'
  }, now).state, 'overdue');
  assert.equal(getSlaState({
    status: 'resolved',
    slaWarningAt: '2026-10-28T00:00:00.000Z',
    slaDueAt: '2026-10-29T11:00:00.000Z'
  }, now).state, 'complete');
  assert.equal(getSlaState({
    status: 'new',
    slaWarningAt: '2026-10-29T13:00:00.000Z',
    slaDueAt: '2026-10-29T14:00:00.000Z'
  }, now).state, 'normal');
  assert.equal(formatSlaRemaining(90 * 60 * 1000), '1 h 30 min');
});

test('ticket categories are validated and saved', async () => {
  const { auth, users, ticketService } = createContext();
  await auth.login(users[0].email, 'AdminPassword123!');
  const ticket = await ticketService.createTicket({
    title: 'Pago de nómina',
    description: 'Consulta de pago pendiente.',
    category: 'Nómina y Pagos'
  });
  assert.equal(ticket.category, 'Nómina y Pagos');
  await assert.rejects(() => ticketService.createTicket({
    title: 'Categoría inventada',
    description: 'No debe guardar categorías arbitrarias.',
    category: 'Otra'
  }), /categoría no es válida/);
});

test('ticket complexity is scored by admins and agents and locks on closure', async () => {
  const { auth, users, ticketService } = createContext();
  const admin = users.find((user) => user.role === 'Admin');
  const agent = users.find((user) => user.role === 'Agent');
  const reporter = users.find((user) => user.role === 'Reporter');

  await auth.login(admin.email, admin.password);
  const ticket = await ticketService.createTicket({
    title: 'Trabajo complejo',
    description: 'Este ticket tiene una estimación inicial.',
    complexityScore: 8
  });
  assert.equal(ticket.complexityScore, 8);

  await auth.login(agent.email, agent.password);
  await ticketService.updateTicket({
    id: ticket.id,
    title: ticket.title,
    description: ticket.description,
    priority: ticket.priority,
    category: ticket.category,
    complexityScore: 5,
    assignedTo: null,
    dueDate: null,
    checklist: []
  });
  assert.equal(ticket.complexityScore, 5);
  await assert.rejects(() => ticketService.updateTicket({
    id: ticket.id,
    title: ticket.title,
    description: ticket.description,
    priority: ticket.priority,
    category: ticket.category,
    complexityScore: 11,
    assignedTo: null,
    dueDate: null,
    checklist: []
  }), /entero entre 1 y 10/);

  await auth.login(reporter.email, reporter.password);
  const reporterTicket = await ticketService.createTicket({
    title: 'Solicitud del reporter',
    description: 'Debe iniciar con el puntaje base.'
  });
  assert.equal(reporterTicket.complexityScore, 1);
  await assert.rejects(() => ticketService.createTicket({
    title: 'Puntaje no autorizado',
    description: 'El Reporter no puede modificar la complejidad.',
    complexityScore: 4
  }), /Solo Admin y Agent/);

  await auth.login(admin.email, admin.password);
  await ticketService.changeTicketStatus(ticket.id, 'closed');
  await assert.rejects(() => ticketService.updateTicket({
    id: ticket.id,
    title: ticket.title,
    description: ticket.description,
    priority: ticket.priority,
    category: ticket.category,
    complexityScore: 7,
    assignedTo: null,
    dueDate: null,
    checklist: []
  }), /no se puede cambiar después de cerrar/);
});

test('only admins can manage shared categories and categories in use cannot be deleted', async () => {
  const { auth, users, categories, ticketService } = createContext();
  const admin = users.find((user) => user.role === 'Admin');
  const agent = users.find((user) => user.role === 'Agent');
  await auth.login(admin.email, admin.password);

  assert.equal(await ticketService.addCategory('  Facturación  '), 'Facturación');
  assert.ok(categories.includes('Facturación'));
  await assert.rejects(() => ticketService.addCategory('facturación'), /Ya existe/);
  const ticket = await ticketService.createTicket({
    title: 'Consulta de facturación',
    description: 'El equipo debe revisar esta nueva categoría.',
    category: 'Facturación'
  });
  await assert.rejects(
    () => ticketService.deleteCategory('Facturación'),
    /todavía usan tickets/
  );
  await ticketService.updateTicket({
    id: ticket.id,
    title: ticket.title,
    description: ticket.description,
    priority: ticket.priority,
    category: 'Consulta',
    assignedTo: null,
    dueDate: null,
    checklist: []
  });
  assert.equal(await ticketService.deleteCategory('Facturación'), 'Facturación');
  assert.ok(!categories.includes('Facturación'));

  await auth.login(agent.email, agent.password);
  await assert.rejects(() => ticketService.addCategory('Nueva'), /Solo un administrador/);
  await assert.rejects(() => ticketService.deleteCategory('Mejora'), /Solo un administrador/);
});

test('only an authorized assignee can reopen a resolved ticket and its creator can rate it when closed', async () => {
  const { auth, users, ticketService } = createContext();
  const admin = users.find((user) => user.role === 'Admin');
  const reporter = users.find((user) => user.role === 'Reporter');
  const agent = users.find((user) => user.role === 'Agent');
  await auth.login(reporter.email, 'ReporterPassword123!');
  const ticket = await ticketService.createTicket({
    title: 'Incidente resuelto',
    description: 'Verificar reapertura y encuesta.'
  });
  await auth.login(admin.email, 'AdminPassword123!');
  await ticketService.updateTicket({
    id: ticket.id,
    title: ticket.title,
    description: ticket.description,
    priority: ticket.priority,
    category: ticket.category,
    assignedTo: agent.id,
    dueDate: null,
    checklist: []
  });
  await ticketService.changeTicketStatus(ticket.id, 'resolved');
  await auth.login(agent.email, 'AgentPassword123!');
  await ticketService.reopenTicket(ticket.id);
  assert.equal(ticket.status, 'open');
  assert.equal(ticket.statusHistory.at(-1).to, 'open');
  await ticketService.changeTicketStatus(ticket.id, 'resolved');
  await ticketService.changeTicketStatus(ticket.id, 'closed');
  await auth.login(reporter.email, 'ReporterPassword123!');
  const rating = await ticketService.submitSatisfaction(ticket.id, 5, 'Atención excelente');
  assert.equal(rating.rating, 5);
  assert.equal((await ticketService.getSatisfaction(ticket.id)).comment, 'Atención excelente');
  await assert.rejects(() => ticketService.submitSatisfaction(ticket.id, 6), /entre 1 y 5/);
});

test('metrics calculate date-bounded volume, SLA, satisfaction, and per-agent load', () => {
  const users = new Map([
    ['agent-1', { id: 'agent-1', fullName: 'Ana Agente', role: 'Agent' }]
  ]);
  const tickets = [
    {
      id: 'TCK-1',
      assignedTo: 'agent-1',
      status: 'resolved',
      createdAt: '2026-10-01T10:00:00.000Z',
      slaDueAt: '2026-10-02T10:00:00.000Z',
      statusHistory: [{ to: 'resolved', changedAt: '2026-10-01T14:00:00.000Z' }]
    },
    {
      id: 'TCK-2',
      assignedTo: 'agent-1',
      status: 'in_progress',
      createdAt: '2026-10-03T10:00:00.000Z',
      statusHistory: []
    },
    {
      id: 'TCK-3',
      assignedTo: null,
      status: 'closed',
      createdAt: '2026-09-01T10:00:00.000Z',
      statusHistory: [{ to: 'closed', changedAt: '2026-09-02T10:00:00.000Z' }]
    }
  ];
  const metrics = calculateTicketMetrics(tickets, users, '2026-10-01', '2026-10-31', [
    { rating: 5, createdAt: '2026-10-05T10:00:00.000Z' },
    { rating: 1, createdAt: '2026-09-05T10:00:00.000Z' }
  ]);
  assert.equal(metrics.createdCount, 2);
  assert.equal(metrics.resolvedCount, 1);
  assert.equal(metrics.closedCount, 0);
  assert.equal(metrics.completedPoints, 0);
  assert.equal(metrics.openCount, 1);
  assert.equal(metrics.slaCompliance, 100);
  assert.equal(metrics.averageResolutionHours, 4);
  assert.equal(metrics.averageSatisfaction, 5);
  assert.deepEqual(metrics.byAgent, [{
    name: 'Ana Agente',
    active: 1,
    resolved: 1,
    closed: 0,
    completedPoints: 0
  }]);
  assert.match(metricsToCsv(metrics), /Ana Agente/);
  assert.match(metricsToCsv({ ...metrics, byAgent: [{ name: '=2\+2', active: 0, resolved: 0, closed: 0, completedPoints: 0 }] }), /"'=2/);
  const completedMetrics = calculateTicketMetrics([{
    id: 'TCK-4',
    assignedTo: null,
    complexityScore: 7,
    status: 'closed',
    createdAt: '2026-10-01T10:00:00.000Z',
    statusHistory: [{
      to: 'closed',
      changedAt: '2026-10-04T10:00:00.000Z',
      assignedToAtChange: 'agent-1'
    }]
  }], users, '2026-10-01', '2026-10-31');
  assert.equal(completedMetrics.closedCount, 1);
  assert.equal(completedMetrics.completedPoints, 7);
  assert.equal(completedMetrics.byAgent[0].name, 'Ana Agente');
  assert.equal(completedMetrics.byAgent[0].completedPoints, 7);
  assert.match(metricsToCsv(completedMetrics), /Puntos de complejidad completados/);
  assert.throws(() => calculateTicketMetrics(tickets, users, '2026-11-01', '2026-10-01'), /rango de fechas/);
});

test('metrics build volume, historical backlog, category, and resolution chart data', () => {
  const tickets = [
    {
      id: 'TCK-10',
      title: 'Acceso',
      category: 'Acceso',
      status: 'open',
      createdAt: '2026-10-01T12:00:00.000Z',
      statusHistory: [
        { from: 'new', to: 'open', changedAt: '2026-10-01T14:00:00.000Z' }
      ]
    },
    {
      id: 'TCK-11',
      title: 'Correo',
      category: 'Correo',
      status: 'resolved',
      createdAt: '2026-10-02T12:00:00.000Z',
      statusHistory: [{ from: 'new', to: 'resolved', changedAt: '2026-10-03T12:00:00.000Z' }]
    }
  ];

  const daily = calculateTicketMetrics(tickets, new Map(), '2026-10-01', '2026-10-03');
  assert.deepEqual(daily.charts.volume.map(({ created, resolved }) => [created, resolved]), [
    [1, 0],
    [1, 0],
    [0, 1]
  ]);
  assert.deepEqual(daily.charts.backlog.map(({ counts }) => [counts.new, counts.open, counts.blocked]), [
    [0, 1, 0],
    [1, 1, 0],
    [0, 1, 0]
  ]);
  assert.deepEqual(daily.charts.byCategory, [
    { name: 'Acceso', created: 1, closed: 0 },
    { name: 'Correo', created: 1, closed: 0 }
  ]);
  assert.equal(daily.charts.resolutionDistribution[3].count, 1);

  const weekly = calculateTicketMetrics(tickets, new Map(), '2026-10-01', '2026-10-03', [], 'week');
  assert.equal(weekly.charts.volume.length, 1);
  assert.deepEqual(weekly.charts.volume[0], {
    label: weekly.charts.volume[0].label,
    created: 2,
    resolved: 1
  });
  assert.throws(
    () => calculateTicketMetrics(tickets, new Map(), '2026-10-01', '2026-10-03', [], 'year'),
    /agrupación temporal/
  );
});

test('Realtime service subscribes workspace tables and forwards database changes', async () => {
  class MockWebSocket {
    static CONNECTING = 0;
    static OPEN = 1;
    static CLOSING = 2;
    static CLOSED = 3;

    constructor(url) {
      this.url = url;
      this.readyState = MockWebSocket.CONNECTING;
      this.listeners = new Map();
      this.sent = [];
    }

    addEventListener(type, handler) {
      this.listeners.set(type, handler);
    }

    send(value) {
      this.sent.push(JSON.parse(value));
    }

    close() {
      this.readyState = MockWebSocket.CLOSED;
      this.listeners.get('close')?.({});
    }

    emit(type, payload = {}) {
      if (type === 'open') this.readyState = MockWebSocket.OPEN;
      this.listeners.get(type)?.(payload);
    }
  }

  const changes = [];
  const statuses = [];
  const service = new RealtimeService({
    url: 'https://project.supabase.co',
    anonKey: 'public-key',
    isConfigured: true
  }, {
    WebSocketImpl: MockWebSocket,
    onChange: (change) => changes.push(change),
    onStatus: (status) => statuses.push(status)
  });
  await service.subscribe({
    userId: 'user-1',
    workspaceId: 'workspace-1',
    getAccessToken: async () => 'jwt-token'
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
  const socket = service.socket;
  assert.match(socket.url, /^wss:/);
  assert.equal(new URL(socket.url).searchParams.get('vsn'), '2.0.0');
  assert.deepEqual(statuses, ['connecting']);
  socket.emit('open');
  const join = socket.sent[0];
  assert.equal(join[3], 'phx_join');
  assert.equal(join[2], 'realtime:workspace-workspace-1');
  assert.deepEqual(join[4].config.postgres_changes.map((change) => change.table), [
    'tickets',
    'ticket_categories',
    'ticket_comments',
    'notifications'
  ]);
  socket.emit('message', {
    data: JSON.stringify([service.joinRef, '2', service.topic, 'phx_reply', { status: 'ok', response: {} }])
  });
  assert.deepEqual(statuses, ['connecting', 'connected']);
  socket.emit('message', {
    data: JSON.stringify([service.joinRef, '2', service.topic, 'postgres_changes', { data: { record: { id: 'TCK-1' } } }])
  });
  assert.deepEqual(changes, [{ data: { record: { id: 'TCK-1' } } }]);
  service.stop();
});

test('ticket comments enforce role, workspace, and text length before persistence', async () => {
  const { auth, db, users, ticketService } = createContext();
  const reporter = users.find((user) => user.role === 'Reporter');
  const agent = users.find((user) => user.role === 'Agent');
  await auth.login(reporter.email, 'ReporterPassword123!');
  const ticket = await ticketService.createTicket({
    title: 'Comentario permitido',
    description: 'El Reporter que creó el ticket puede conversar.'
  });

  const comment = await ticketService.addComment(ticket.id, '  Ya adjunté los detalles.  ');
  assert.equal(comment.authorId, reporter.id);
  assert.equal(comment.body, 'Ya adjunté los detalles.');
  assert.equal((await ticketService.getComments(ticket.id)).length, 1);
  await assert.rejects(() => ticketService.addComment(ticket.id, '  '), /entre 1 y 4000/);
  await assert.rejects(() => ticketService.addComment(ticket.id, 'x'.repeat(4001)), /entre 1 y 4000/);

  await auth.login(agent.email, 'AgentPassword123!');
  assert.equal((await ticketService.addComment(ticket.id, 'Lo estamos revisando.')).authorId, agent.id);

  await auth.login(users.find((user) => user.role === 'Admin').email, 'AdminPassword123!');
  const adminTicket = await ticketService.createTicket({
    title: 'Otro ticket del espacio',
    description: 'El Reporter no debe comentar en tickets de otras personas.'
  });
  await auth.login(reporter.email, 'ReporterPassword123!');
  await assert.rejects(
    () => ticketService.addComment(adminTicket.id, 'No autorizado'),
    /permiso para comentar/
  );

  const outsideTicket = {
    ...ticket,
    id: 'TCK-9998',
    workspaceId: 'another-workspace'
  };
  await db.put('tickets', outsideTicket);
  await assert.rejects(
    () => ticketService.addComment(outsideTicket.id, 'No autorizado'),
    /permiso para comentar/
  );
});
