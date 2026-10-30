function isWithinRange(value, start, end) {
  const timestamp = new Date(value).getTime();
  return Number.isFinite(timestamp) && timestamp >= start && timestamp <= end;
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

export function calculateTicketMetrics(tickets, usersMap, start, end, satisfaction = []) {
  const startAt = new Date(`${start}T00:00:00`).getTime();
  const endAt = new Date(`${end}T23:59:59.999`).getTime();
  if (!Number.isFinite(startAt) || !Number.isFinite(endAt) || startAt > endAt) {
    throw new Error('El rango de fechas del informe no es válido.');
  }

  const created = tickets.filter((ticket) => isWithinRange(ticket.createdAt, startAt, endAt));
  const resolved = tickets.map((ticket) => ({ ticket, resolvedAt: firstResolution(ticket) }))
    .filter(({ resolvedAt }) => resolvedAt && isWithinRange(resolvedAt, startAt, endAt));
  const resolutionHours = resolved.map(({ ticket, resolvedAt }) => (
    (new Date(resolvedAt).getTime() - new Date(ticket.createdAt).getTime()) / 3_600_000
  )).filter((hours) => hours >= 0);
  const compliant = resolved.filter(({ ticket, resolvedAt }) => (
    ticket.slaDueAt && new Date(resolvedAt).getTime() <= new Date(ticket.slaDueAt).getTime()
  )).length;
  const agentMetrics = new Map();

  tickets.forEach((ticket) => {
    const user = usersMap.get(ticket.assignedTo);
    if (!user || !['Agent', 'Admin'].includes(user.role)) return;
    const current = agentMetrics.get(user.id) || { name: user.fullName, active: 0, resolved: 0 };
    if (!['resolved', 'closed'].includes(ticket.status)) current.active += 1;
    agentMetrics.set(user.id, current);
  });
  resolved.forEach(({ ticket }) => {
    const user = usersMap.get(ticket.assignedTo);
    if (!user || !['Agent', 'Admin'].includes(user.role)) return;
    const current = agentMetrics.get(user.id) || { name: user.fullName, active: 0, resolved: 0 };
    current.resolved += 1;
    agentMetrics.set(user.id, current);
  });

  const periodSatisfaction = satisfaction.filter((item) => isWithinRange(item.createdAt, startAt, endAt));

  return {
    createdCount: created.length,
    resolvedCount: resolved.length,
    openCount: tickets.filter((ticket) => !['resolved', 'closed'].includes(ticket.status)).length,
    slaCompliance: resolved.length ? Math.round((compliant / resolved.length) * 100) : 0,
    averageResolutionHours: resolutionHours.length
      ? Math.round((resolutionHours.reduce((sum, hours) => sum + hours, 0) / resolutionHours.length) * 10) / 10
      : 0,
    averageSatisfaction: periodSatisfaction.length
      ? Math.round((periodSatisfaction.reduce((sum, item) => sum + item.rating, 0) / periodSatisfaction.length) * 10) / 10
      : null,
    byAgent: [...agentMetrics.values()].sort((a, b) => b.resolved - a.resolved || a.name.localeCompare(b.name, 'es'))
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
    ['Tickets abiertos actuales', metrics.openCount],
    ['Cumplimiento SLA (%)', metrics.slaCompliance],
    ['Tiempo promedio resolución (horas)', metrics.averageResolutionHours],
    ['Satisfacción promedio (1–5)', metrics.averageSatisfaction ?? 'Sin datos'],
    [],
    ['Agente', 'Tickets activos asignados', 'Tickets resueltos'],
    ...metrics.byAgent.map((agent) => [agent.name, agent.active, agent.resolved])
  ];
  return `\uFEFF${rows.map((row) => row.map(quoteCsv).join(',')).join('\r\n')}`;
}
