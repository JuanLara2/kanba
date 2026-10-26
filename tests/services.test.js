import assert from 'node:assert/strict';
import test from 'node:test';
import { AuthService } from '../js/services/authService.js';
import { SupabaseAdapter } from '../js/data/db.js';
import { FilterSortService } from '../js/services/filterService.js';
import { SupabaseClient } from '../js/data/supabaseClient.js';
import { TicketService } from '../js/services/ticketService.js';
import { initializeThemeController, THEME_STORAGE_KEY } from '../js/ui/themeController.js';

function createContext() {
  const users = [
    { id: 'usr-admin-01', fullName: 'Carlos Administrador', email: 'admin@nexus.com', role: 'Admin', workspaceId: 'workspace-test', password: 'AdminPassword123!' },
    { id: 'usr-agent-01', fullName: 'Laura Agente', email: 'laura@nexus.com', role: 'Agent', workspaceId: 'workspace-test', password: 'AgentPassword123!' },
    { id: 'usr-reporter-01', fullName: 'Pedro Reportero', email: 'pedro@nexus.com', role: 'Reporter', workspaceId: 'workspace-test', password: 'ReporterPassword123!' }
  ];
  const tickets = [];
  const stores = { users, tickets };
  const sessions = new Map();
  let createdUserId = 0;
  const db = {
    async getAll(storeName) {
      return stores[storeName].slice();
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
    async createUser({ fullName, email, role }) {
      const id = `usr-created-${++createdUserId}`;
      const user = { id, fullName, email, role, workspaceId: `workspace-${id}` };
      users.push(user);
      return user;
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
  return { users, tickets, db, auth, ticketService: new TicketService(db, auth) };
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

test('Supabase login authenticates each configured role and stores a managed session', async () => {
  const { auth } = createContext();

  assert.equal((await auth.login('admin@nexus.com', 'AdminPassword123!')).role, 'Admin');
  assert.equal((await auth.login('laura@nexus.com', 'AgentPassword123!')).role, 'Agent');
  assert.equal((await auth.login('pedro@nexus.com', 'ReporterPassword123!')).role, 'Reporter');
  await assert.rejects(() => auth.login('admin@nexus.com', 'incorrect'), /Credenciales inválidas/);
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

test('ticket assignment rejects users from a different workspace', async () => {
  const { auth, ticketService } = createContext();
  await auth.login('admin@nexus.com', 'AdminPassword123!');
  const createdAgent = await auth.registerUser({
    fullName: 'Agente aislado',
    email: 'isolated.agent@example.com',
    password: 'SecurePassword123',
    role: 'Agent'
  });

  await assert.rejects(
    () => ticketService.createTicket({
      title: 'Ticket aislado',
      description: 'No debe compartir su responsable.',
      assignedTo: createdAgent.id
    }),
    /responsable debe pertenecer a tu espacio/
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
    due_date: null
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
          changed_by: 'admin-id'
        }];
      }
      throw new Error(`Unexpected request: ${path}`);
    }
  };
  const adapter = new SupabaseAdapter(client, async () => 'test-access-token');

  const [ticket] = await adapter.getAll('tickets');

  assert.equal(ticket.assignedTo, 'agent-id');
  assert.equal(ticket.workspaceId, 'workspace-id');
  assert.deepEqual(ticket.statusHistory, [{
    from: 'new',
    to: 'open',
    changedAt: '2026-10-20T10:00:00.000Z',
    changedBy: 'admin-id'
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
    assignedTo: null,
    createdBy: 'client-user-id',
    dueDate: null
  });
  assert.equal(calls[2].options.body.id, undefined);
  assert.equal(calls[2].options.body.created_by, undefined);

  const [profile] = await adapter.getAll('users');
  assert.equal(profile.workspaceId, 'workspace-id');
  assert.equal(profile.createdByAdminId, null);
});

test('SLA filters classify overdue, warning, and future deadlines using configured windows', () => {
  const originalNow = Date.now;
  const fixedNow = Date.parse('2026-10-25T12:00:00.000Z');
  Date.now = () => fixedNow;

  try {
    const tickets = [
      { id: 'overdue', dueDate: '2026-10-25T11:00:00.000Z' },
      { id: 'warning', dueDate: '2026-10-26T00:00:00.000Z' },
      { id: 'future', dueDate: '2026-10-27T12:00:00.000Z' },
      { id: 'invalid', dueDate: 'not-a-date' }
    ];
    const usersMap = new Map();

    assert.deepEqual(FilterSortService.apply(tickets, { dueFilter: 'overdue' }, usersMap).map((item) => item.id), ['overdue']);
    assert.deepEqual(FilterSortService.apply(tickets, { dueFilter: 'warning' }, usersMap).map((item) => item.id), ['warning']);
    assert.deepEqual(FilterSortService.apply(tickets, { dueFilter: 'future' }, usersMap).map((item) => item.id), ['future']);
  } finally {
    Date.now = originalNow;
  }
});
