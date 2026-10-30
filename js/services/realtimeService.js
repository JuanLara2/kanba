export class RealtimeService {
  constructor(client, { WebSocketImpl = globalThis.WebSocket, onChange, onStatus } = {}) {
    this.client = client;
    this.WebSocketImpl = WebSocketImpl;
    this.onChange = onChange;
    this.onStatus = onStatus;
    this.socket = null;
    this.closed = true;
    this.retryCount = 0;
    this.heartbeatId = null;
    this.reconnectId = null;
    this.ref = 0;
  }

  async connect({ accessToken, workspaceId }) {
    this.stop();
    if (!this.client.isConfigured || !this.WebSocketImpl) {
      this.onStatus?.('unavailable');
      return;
    }

    this.closed = false;
    this.accessToken = accessToken;
    this.workspaceId = workspaceId;
    this.openSocket();
  }

  async openSocket() {
    if (this.closed) return;
    try {
      this.accessToken = await this.getAccessToken();
      if (!this.accessToken) throw new Error('No hay una sesión válida para la conexión en tiempo real.');
    } catch (error) {
      if (this.closed) return;
      this.onStatus?.('error', error);
      this.scheduleReconnect();
      return;
    }
    if (this.closed) return;
    const url = new URL(`${this.client.url.replace(/^http/, 'ws')}/realtime/v1/websocket`);
    url.searchParams.set('apikey', this.client.anonKey);
    url.searchParams.set('vsn', '1.0.0');

    this.onStatus?.('connecting');
    let socket;
    try {
      socket = new this.WebSocketImpl(url.toString());
    } catch (error) {
      this.onStatus?.('error', error);
      this.scheduleReconnect();
      return;
    }

    this.socket = socket;
    socket.addEventListener('open', () => this.joinChannel(socket));
    socket.addEventListener('message', (event) => this.handleMessage(event, socket));
    socket.addEventListener('error', () => this.onStatus?.('error', new Error('La conexión en tiempo real tuvo un error.')));
    socket.addEventListener('close', () => {
      if (this.socket !== socket) return;
      this.clearHeartbeat();
      this.onStatus?.('disconnected');
      this.scheduleReconnect();
    });
  }

  joinChannel(socket) {
    if (this.socket !== socket || socket.readyState !== this.WebSocketImpl.OPEN) return;
    this.topic = `realtime:workspace-${this.workspaceId}`;
    this.joinRef = this.nextRef();
    const ref = this.nextRef();
    socket.send(JSON.stringify([
      this.joinRef,
      ref,
      this.topic,
      'phx_join',
      {
        config: {
          broadcast: { self: false },
          presence: { key: '' },
          postgres_changes: [
            { event: '*', schema: 'public', table: 'tickets' },
            { event: '*', schema: 'public', table: 'ticket_comments' },
            { event: '*', schema: 'public', table: 'notifications', filter: `user_id=eq.${this.userId}` }
          ]
        },
        access_token: this.accessToken
      }
    ]));
    this.startHeartbeat(socket);
  }

  async subscribe({ userId, workspaceId, getAccessToken }) {
    this.userId = userId;
    this.getAccessToken = getAccessToken;
    const accessToken = await getAccessToken();
    await this.connect({ accessToken, workspaceId });
  }

  handleMessage(event, socket) {
    if (this.socket !== socket) return;
    let message;
    try {
      message = JSON.parse(event.data);
    } catch (error) {
      this.onStatus?.('error', new Error('Supabase Realtime envió un mensaje no válido.', { cause: error }));
      return;
    }
    if (!Array.isArray(message) || message.length < 5) return;

    const [joinRef, , topic, type, payload] = message;
    if (topic === this.topic && type === 'phx_reply' && joinRef === this.joinRef) {
      if (payload?.status === 'ok') {
        this.retryCount = 0;
        this.onStatus?.('connected');
      } else {
        this.onStatus?.('error', new Error(payload?.response?.reason || 'No se pudo suscribir a Supabase Realtime.'));
        socket.close();
      }
      return;
    }
    if (topic === this.topic && (type === 'postgres_changes' || type === 'INSERT' || type === 'UPDATE' || type === 'DELETE')) {
      this.onChange?.(payload);
    }
  }

  startHeartbeat(socket) {
    this.clearHeartbeat();
    this.heartbeatId = setInterval(async () => {
      if (this.socket !== socket || socket.readyState !== this.WebSocketImpl.OPEN) return;
      try {
        this.accessToken = await this.getAccessToken();
        const authRef = this.nextRef();
        socket.send(JSON.stringify([this.joinRef, authRef, this.topic, 'access_token', { access_token: this.accessToken }]));
        socket.send(JSON.stringify([null, this.nextRef(), 'phoenix', 'heartbeat', {}]));
      } catch (error) {
        this.onStatus?.('error', error);
        socket.close();
      }
    }, 30_000);
  }

  scheduleReconnect() {
    if (this.closed || this.reconnectId) return;
    const delay = Math.min(30_000, 1000 * (2 ** this.retryCount));
    this.retryCount += 1;
    this.reconnectId = setTimeout(() => {
      this.reconnectId = null;
      this.openSocket();
    }, delay);
  }

  clearHeartbeat() {
    if (this.heartbeatId) clearInterval(this.heartbeatId);
    this.heartbeatId = null;
  }

  nextRef() {
    this.ref += 1;
    return String(this.ref);
  }

  stop() {
    this.closed = true;
    this.clearHeartbeat();
    if (this.reconnectId) clearTimeout(this.reconnectId);
    this.reconnectId = null;
    const socket = this.socket;
    this.socket = null;
    if (socket && socket.readyState < this.WebSocketImpl.CLOSING) socket.close();
  }
}
