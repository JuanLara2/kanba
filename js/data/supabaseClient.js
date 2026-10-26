import { SUPABASE_ANON_KEY, SUPABASE_URL } from '../config/supabase.js';

export class SupabaseClient {
  constructor({ url = SUPABASE_URL, anonKey = SUPABASE_ANON_KEY } = {}) {
    this.url = url.replace(/\/+$/, '');
    this.anonKey = anonKey;
  }

  get isConfigured() {
    return Boolean(this.url && this.anonKey);
  }

  requireConfiguration() {
    if (!this.isConfigured) {
      throw new Error('Configura SUPABASE_URL y SUPABASE_ANON_KEY en js/config/supabase.js antes de conectarte.');
    }
  }

  async request(endpoint, path, { method = 'GET', body, accessToken, prefer } = {}) {
    this.requireConfiguration();
    const headers = {
      apikey: this.anonKey,
      Accept: 'application/json'
    };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (accessToken) headers.Authorization = `Bearer ${accessToken}`;
    if (prefer) headers.Prefer = prefer;

    let response;
    try {
      response = await fetch(`${this.url}/${endpoint}/${path}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body)
      });
    } catch {
      throw new Error('No fue posible conectar con Supabase. Comprueba tu conexión e intenta de nuevo.');
    }

    const text = await response.text();
    let result = null;
    if (text) {
      try {
        result = JSON.parse(text);
      } catch {
        throw new Error('Supabase devolvió una respuesta que no se pudo interpretar.');
      }
    }

    if (!response.ok) {
      const message = result?.msg || result?.message || result?.error_description || result?.error;
      const error = new Error(message || `Solicitud a Supabase fallida (${response.status}).`);
      error.status = response.status;
      throw error;
    }

    return result;
  }

  requestAuth(path, options = {}) {
    return this.request('auth/v1', path, options);
  }

  requestRest(path, options = {}) {
    return this.request('rest/v1', path, options);
  }
}
