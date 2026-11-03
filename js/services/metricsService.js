const STATUS_LABELS = {
  new: 'Nuevo',
  open: 'Abierto',
  in_progress: 'En progreso',
  resolved: 'Resuelto',
  closed: 'Cerrado',
  blocked: 'Bloqueado'
};
const BACKLOG_STATUS_LABELS = {
  new: STATUS_LABELS.new,
  open: STATUS_LABELS.open,
  in_progress: STATUS_LABELS.in_progress,
  blocked: STATUS_LABELS.blocked
};

const RESOLUTION_BUCKETS = [
  { label: '< 1 h', max: 1 },
  { label: '1–4 h', max: 4 },
  { label: '4–24 h', max: 24 },
  { label: '1–3 días', max: 72 },
  { label: '> 3 días', max: Infinity }
];

function isWithinRange(value, start, end) {
  const timestamp = new Date(value).getTime();
  return Number.isFinite(timestamp) && timestamp >= start && timestamp <= end;
}

function dateKey(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function periodKey(date, grouping) {
  const groupedDate = new Date(date);
  if (grouping === 'week') {
    groupedDate.setDate(groupedDate.getDate() - ((groupedDate.getDay() + 6) % 7));
  } else if (grouping === 'month') {
    groupedDate.setDate(1);
  }
  return dateKey(groupedDate);
}

function formatPeriod(date, grouping) {
  const options = grouping === 'month'
    ? { month: 'short', year: '2-digit' }
    : { day: 'numeric', month: 'short' };
  return new Intl.DateTimeFormat('es', options).format(date);
}

function buildPeriods(startAt, endAt, grouping) {
  const periods = new Map();
  const cursor = new Date(startAt);
  const lastDay = new Date(endAt);
  cursor.setHours(0, 0, 0, 0);
  lastDay.setHours(0, 0, 0, 0);

  while (cursor <= lastDay) {
    const key = periodKey(cursor, grouping);
    if (!periods.has(key)) {
      periods.set(key, { key, date: new Date(cursor), lastDate: new Date(cursor) });
    } else {
      periods.get(key).lastDate = new Date(cursor);
    }
    cursor.setDate(cursor.getDate() + 1);
  }

  return [...periods.values()].map((period) => ({
    ...period,
    label: formatPeriod(period.date, grouping)
  }));
}

function firstResolution(ticket) {
  const history = (ticket.statusHistory || [])
    .slice()
    .sort((a, b) => new Date(a.changedAt) - new Date(b.changedAt));
  let resolvedAt = null;
  history.forEach((record) => {
    if (['resolved', 'closed'].includes(record.to)) {
      if (!resolvedAt) resolvedAt = record.changedAt;
    } else {
      resolvedAt = null;
    }
  });
  return resolvedAt;
}

function finalClosure(ticket) {
  if (ticket.status !== 'closed') return null;
  return (ticket.statusHistory || [])
    .filter((record) => record.to === 'closed')
    .sort((a, b) => new Date(b.changedAt) - new Date(a.changedAt))[0]
    || (ticket.createdAt && ticket.status === 'closed'
      ? { changedAt: ticket.createdAt, assignedToAtChange: ticket.assignedTo }
      : null);
}

function statusAt(ticket, timestamp, history) {
  if (new Date(ticket.createdAt).getTime() > timestamp) return null;
  let status = null;
  for (const record of history) {
    if (new Date(record.changedAt).getTime() <= timestamp) {
      status = record.to;
    } else {
      if (!status) status = record.from;
      break;
    }
  }
  return status || ticket.status;
}

export function calculateTicketMetrics(tickets, usersMap, start, end, satisfaction = [], grouping = 'day') {
  const startAt = new Date(`${start}T00:00:00`).getTime();
  const endAt = new Date(`${end}T23:59:59.999`).getTime();
  if (!Number.isFinite(startAt) || !Number.isFinite(endAt) || startAt > endAt) {
    throw new Error('El rango de fechas del informe no es válido.');
  }
  if (!['day', 'week', 'month'].includes(grouping)) {
    throw new Error('La agrupación temporal seleccionada no es válida.');
  }

  const periods = buildPeriods(startAt, endAt, grouping);
  const periodByKey = new Map(periods.map((period) => [period.key, period]));
  const historyByTicket = new Map(tickets.map((ticket) => [ticket.id, (ticket.statusHistory || [])
    .slice()
    .sort((a, b) => new Date(a.changedAt) - new Date(b.changedAt))]));
  const getPeriod = (value) => {
    const date = new Date(value);
    if (!Number.isFinite(date.getTime()) || !isWithinRange(value, startAt, endAt)) return null;
    return periodByKey.get(periodKey(date, grouping)) || null;
  };
  const created = tickets.filter((ticket) => isWithinRange(ticket.createdAt, startAt, endAt));
  const resolved = tickets.map((ticket) => ({ ticket, resolvedAt: firstResolution(ticket) }))
    .filter(({ resolvedAt }) => resolvedAt && isWithinRange(resolvedAt, startAt, endAt));
  const closed = tickets.map((ticket) => ({ ticket, closure: finalClosure(ticket) }))
    .filter(({ closure }) => closure && isWithinRange(closure.changedAt, startAt, endAt));
  const resolutionHours = resolved.map(({ ticket, resolvedAt }) => (
    (new Date(resolvedAt).getTime() - new Date(ticket.createdAt).getTime()) / 3_600_000
  )).filter((hours) => hours >= 0);
  const compliant = resolved.filter(({ ticket, resolvedAt }) => (
    ticket.slaDueAt && new Date(resolvedAt).getTime() <= new Date(ticket.slaDueAt).getTime()
  )).length;
  const agentMetrics = new Map();
  const getAgentMetric = (userId) => {
    const user = userId ? usersMap.get(userId) : null;
    const key = user?.id || userId || '__unassigned_at_close__';
    if (!agentMetrics.has(key)) {
      agentMetrics.set(key, {
        name: user?.fullName || (userId ? 'Usuario no disponible' : 'Sin responsable al cierre'),
        active: 0,
        resolved: 0,
        closed: 0,
        completedPoints: 0
      });
    }
    return agentMetrics.get(key);
  };

  tickets.forEach((ticket) => {
    const user = usersMap.get(ticket.assignedTo);
    if (!user || !['Agent', 'Admin'].includes(user.role)) return;
    const current = getAgentMetric(user.id);
    if (!['resolved', 'closed'].includes(ticket.status)) current.active += 1;
  });
  resolved.forEach(({ ticket }) => {
    const user = usersMap.get(ticket.assignedTo);
    if (!user || !['Agent', 'Admin'].includes(user.role)) return;
    getAgentMetric(user.id).resolved += 1;
  });
  closed.forEach(({ ticket, closure }) => {
    const current = getAgentMetric(closure.assignedToAtChange);
    current.closed += 1;
    current.completedPoints += Number.isInteger(ticket.complexityScore) ? ticket.complexityScore : 1;
  });

  const periodSatisfaction = satisfaction.filter((item) => isWithinRange(item.createdAt, startAt, endAt));
  const volumeByPeriod = new Map(periods.map((period) => [period.key, {
    label: period.label,
    created: 0,
    resolved: 0
  }]));
  created.forEach((ticket) => {
    const period = getPeriod(ticket.createdAt);
    if (period) volumeByPeriod.get(period.key).created += 1;
  });
  resolved.forEach(({ resolvedAt }) => {
    const period = getPeriod(resolvedAt);
    if (period) volumeByPeriod.get(period.key).resolved += 1;
  });

  const backlogByPeriod = periods.map((period) => {
    const timestamp = new Date(period.lastDate);
    timestamp.setHours(23, 59, 59, 999);
    const counts = Object.fromEntries(Object.keys(BACKLOG_STATUS_LABELS).map((status) => [status, 0]));
    tickets.forEach((ticket) => {
      const status = statusAt(ticket, timestamp.getTime(), historyByTicket.get(ticket.id));
      if (status && Object.prototype.hasOwnProperty.call(counts, status)) counts[status] += 1;
    });
    return { label: period.label, counts };
  });

  const categories = new Map();
  created.forEach((ticket) => {
    const name = ticket.category || 'Sin categoría';
    if (!categories.has(name)) categories.set(name, { name, created: 0, closed: 0 });
    categories.get(name).created += 1;
  });
  closed.forEach(({ ticket }) => {
    const name = ticket.category || 'Sin categoría';
    if (!categories.has(name)) categories.set(name, { name, created: 0, closed: 0 });
    categories.get(name).closed += 1;
  });

  const resolutionDistribution = RESOLUTION_BUCKETS.map(({ label }) => ({ label, count: 0 }));
  resolutionHours.forEach((hours) => {
    const bucket = RESOLUTION_BUCKETS.findIndex(({ max }) => hours < max);
    if (bucket >= 0) resolutionDistribution[bucket].count += 1;
  });

  return {
    createdCount: created.length,
    resolvedCount: resolved.length,
    closedCount: closed.length,
    completedPoints: closed.reduce((sum, { ticket }) => (
      sum + (Number.isInteger(ticket.complexityScore) ? ticket.complexityScore : 1)
    ), 0),
    openCount: tickets.filter((ticket) => !['resolved', 'closed'].includes(ticket.status)).length,
    slaCompliance: resolved.length ? Math.round((compliant / resolved.length) * 100) : 0,
    averageResolutionHours: resolutionHours.length
      ? Math.round((resolutionHours.reduce((sum, hours) => sum + hours, 0) / resolutionHours.length) * 10) / 10
      : 0,
    averageSatisfaction: periodSatisfaction.length
      ? Math.round((periodSatisfaction.reduce((sum, item) => sum + item.rating, 0) / periodSatisfaction.length) * 10) / 10
      : null,
    byAgent: [...agentMetrics.values()].sort((a, b) => (
      b.completedPoints - a.completedPoints
      || b.resolved - a.resolved
      || a.name.localeCompare(b.name, 'es')
    )),
    charts: {
      grouping,
      volume: periods.map((period) => volumeByPeriod.get(period.key)),
      backlog: backlogByPeriod,
      byCategory: [...categories.values()].sort((a, b) => b.created - a.created || a.name.localeCompare(b.name, 'es')),
      resolutionDistribution,
      statusLabels: BACKLOG_STATUS_LABELS
    }
  };
}

export function metricsToCsv(metrics) {
  const quoteCsv = (cell) => {
    let value = String(cell ?? '');
    if (/^[=+\-@\t\r]/.test(value)) value = `'${value}`;
    return `"${value.replace(/"/g, '""')}"`;
  };
  const rows = [
    ['Indicador', 'Valor'],
    ['Tickets creados', metrics.createdCount],
    ['Tickets resueltos', metrics.resolvedCount],
    ['Tickets cerrados en el período', metrics.closedCount],
    ['Puntos de complejidad completados', metrics.completedPoints],
    ['Tickets abiertos actuales', metrics.openCount],
    ['Cumplimiento SLA (%)', metrics.slaCompliance],
    ['Tiempo promedio resolución (horas)', metrics.averageResolutionHours],
    ['Satisfacción promedio (1–5)', metrics.averageSatisfaction ?? 'Sin datos'],
    [],
    ['Responsable al cierre', 'Tickets activos asignados', 'Tickets resueltos', 'Tickets cerrados', 'Puntos completados'],
    ...metrics.byAgent.map((agent) => [agent.name, agent.active, agent.resolved, agent.closed, agent.completedPoints])
  ];
  return `\uFEFF${rows.map((row) => row.map(quoteCsv).join(',')).join('\r\n')}`;
}
