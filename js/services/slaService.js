const COMPLETED_STATUSES = new Set(['resolved', 'closed']);

export function getSlaState(ticket, now = Date.now()) {
  if (!ticket?.slaDueAt) return { state: 'none', label: '' };
  if (COMPLETED_STATUSES.has(ticket.status)) return { state: 'complete', label: 'Resuelto' };

  const dueAt = new Date(ticket.slaDueAt).getTime();
  if (!Number.isFinite(dueAt)) return { state: 'invalid', label: 'SLA no válido' };
  const remainingMs = dueAt - now;
  if (remainingMs <= 0) return { state: 'overdue', label: 'SLA vencido', remainingMs };

  const warningAt = new Date(ticket.slaWarningAt).getTime();
  if (Number.isFinite(warningAt) && now >= warningAt) {
    return { state: 'warning', label: 'SLA próximo a vencer', remainingMs };
  }

  return { state: 'normal', label: 'SLA en plazo', remainingMs };
}

export function formatSlaRemaining(milliseconds) {
  if (!Number.isFinite(milliseconds) || milliseconds <= 0) return '0 min';

  const totalMinutes = Math.ceil(milliseconds / 60_000);
  const days = Math.floor(totalMinutes / (60 * 24));
  const hours = Math.floor((totalMinutes % (60 * 24)) / 60);
  const minutes = totalMinutes % 60;

  if (days) return `${days} d ${hours} h`;
  if (hours) return `${hours} h ${minutes} min`;
  return `${minutes} min`;
}
