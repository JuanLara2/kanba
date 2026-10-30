export const STATUS_DEFINITIONS = {
  new: { id: 'new', name: 'Nuevo', colorHex: '#f59e0b', badgeClass: 'text-new', borderClass: 'status-new' },
  open: { id: 'open', name: 'Abierto', colorHex: '#06b6d4', badgeClass: 'text-open', borderClass: 'status-open' },
  in_progress: { id: 'in_progress', name: 'En Progreso', colorHex: '#3b82f6', badgeClass: 'text-in_progress', borderClass: 'status-in_progress' },
  resolved: { id: 'resolved', name: 'Resuelto', colorHex: '#10b981', badgeClass: 'text-resolved', borderClass: 'status-resolved' },
  closed: { id: 'closed', name: 'Cerrado', colorHex: '#64748b', badgeClass: 'text-closed', borderClass: 'status-closed' },
  blocked: { id: 'blocked', name: 'Bloqueado', colorHex: '#ef4444', badgeClass: 'text-blocked', borderClass: 'status-blocked' }
};

export const SLA_REFRESH_INTERVAL_MS = 60 * 1000;

export const PRIORITY_ORDER = ['Baja', 'Media', 'Alta', 'Urgente'];

export const TICKET_CATEGORIES = [
  'Soporte técnico',
  'Accesos',
  'Incidente',
  'Solicitud de servicio',
  'Consulta',
  'Mejora',
  'Nómina y Pagos'
];
