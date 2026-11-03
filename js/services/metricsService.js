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

function finalClosure(ticket) {
  if (ticket.status !== 'closed') return null;
  return (ticket.statusHistory || [])
    .filter((record) => record.to === 'closed')
    .sort((a, b) => new Date(b.changedAt) - new Date(a.changedAt))[0]
    || (ticket.createdAt && ticket.status === 'closed'
      ? { changedAt: ticket.createdAt, assignedToAtChange: ticket.assignedTo }
      : null);
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
    ))
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
