import { SUPABASE_SESSION_KEY } from '../config/supabase.js';

const VALID_ROLES = ['Admin', 'Agent', 'Reporter'];

export class AuthService {
  constructor(client, db) {
    this.client = client;
    this.db = db;
    this.currentUser = null;
  }

  readSession() {
    const value = localStorage.getItem(SUPABASE_SESSION_KEY);
    if (!value) return null;
    try {
      return JSON.parse(value);
    } catch {
      localStorage.removeItem(SUPABASE_SESSION_KEY);
      return null;
    }
  }

  saveSession(session) {
    localStorage.setItem(SUPABASE_SESSION_KEY, JSON.stringify(session));
  }

  clearSession() {
    localStorage.removeItem(SUPABASE_SESSION_KEY);
    this.currentUser = null;
  }

  async getAccessToken() {
    let session = this.readSession();
    if (!session?.access_token) return null;
    if (session.expires_at && session.expires_at > Date.now() + 60_000) return session.access_token;
    if (!session.refresh_token) {
      this.clearSession();
      return null;
    }

    const refreshed = await this.client.requestAuth('token?grant_type=refresh_token', {
      method: 'POST',
      body: { refresh_token: session.refresh_token }
    });
    session = this.normalizeSession(refreshed);
    this.saveSession(session);
    return session.access_token;
  }

  normalizeSession(response) {
    return {
      access_token: response.access_token,
      refresh_token: response.refresh_token,
      expires_at: Date.now() + (response.expires_in || 3600) * 1000,
      user_id: response.user?.id
    };
  }

  async login(email, password) {
    const normalizedEmail = String(email ?? '').trim().toLowerCase();
    let response;
    try {
      response = await this.client.requestAuth('token?grant_type=password', {
        method: 'POST',
        body: { email: normalizedEmail, password }
      });
    } catch (error) {
      if (error.status === 400 || error.status === 401) throw new Error('Credenciales inválidas');
      throw error;
    }

    const session = this.normalizeSession(response);
    this.saveSession(session);
    try {
      const user = await this.loadProfile(response.user.id, session.access_token);
      if (!user) throw new Error('Tu cuenta no tiene un perfil habilitado. Contacta al administrador.');
      this.currentUser = user;
      return user;
    } catch (error) {
      this.clearSession();
      throw error;
    }
  }

  async loadProfile(userId, accessToken) {
    const profile = await this.db.getById('users', userId, accessToken);
    return profile || null;
  }

  async registerUser({ fullName, email, password, role = 'Reporter' }) {
    const currentUser = await this.getCurrentUser();
    if (!this.canManageUsers(currentUser)) {
      throw new Error('Solo un administrador puede crear usuarios.');
    }

    const normalizedName = String(fullName ?? '').trim();
    const normalizedEmail = String(email ?? '').trim().toLowerCase();
    if (normalizedName.length < 2) throw new Error('El nombre debe tener al menos 2 caracteres.');
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizedEmail)) throw new Error('El correo electrónico no es válido.');
    if (!VALID_ROLES.includes(role)) throw new Error('El rol seleccionado no es válido.');
    if (typeof password !== 'string' || password.length < 12) {
      throw new Error('La contraseña debe tener al menos 12 caracteres.');
    }

    const users = await this.db.getAll('users');
    if (users.some((user) => user.email.toLowerCase() === normalizedEmail)) {
      throw new Error('El correo electrónico ya se encuentra registrado.');
    }

    return this.db.createUser({
      fullName: normalizedName,
      email: normalizedEmail,
      password,
      role
    });
  }

  async getCurrentUser() {
    if (this.currentUser) return this.currentUser;
    const session = this.readSession();
    if (!session?.access_token) return null;

    const accessToken = await this.getAccessToken();
    if (!accessToken) return null;
    let authUser;
    try {
      authUser = await this.client.requestAuth('user', { accessToken });
    } catch (error) {
      if (error.status === 401) {
        this.clearSession();
        return null;
      }
      throw error;
    }

    const profile = await this.loadProfile(authUser.id, accessToken);
    if (!profile) {
      this.clearSession();
      throw new Error('Tu cuenta no tiene un perfil habilitado. Contacta al administrador.');
    }
    this.currentUser = profile;
    return profile;
  }

  async logout() {
    const accessToken = this.readSession()?.access_token;
    try {
      if (accessToken) {
        await this.client.requestAuth('logout', { method: 'POST', accessToken });
      }
    } finally {
      this.clearSession();
    }
  }

  canChangeStatus(user, ticket) {
    if (!user) return false;
    if (user.role === 'Admin') return true;
    if (user.role === 'Agent') {
      return ticket.assignedTo === user.id || ticket.status === 'open';
    }
    return false;
  }

  canAssignOrSetDue(user) {
    return Boolean(user && (user.role === 'Admin' || user.role === 'Agent'));
  }

  canEditTicket(user, ticket) {
    if (!user) return false;
    if (user.role === 'Admin') return true;
    return user.role === 'Agent' && (ticket.assignedTo === user.id || ticket.status === 'open');
  }

  canDelete(user) {
    return Boolean(user && user.role === 'Admin');
  }

  canManageUsers(user) {
    return Boolean(user && user.role === 'Admin');
  }
}
