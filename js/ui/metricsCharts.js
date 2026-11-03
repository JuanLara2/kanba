const SVG_NS = 'http://www.w3.org/2000/svg';
const CHART_COLORS = {
  created: '#3b82f6',
  resolved: '#10b981',
  closed: '#64748b',
  status: {
    new: '#f59e0b',
    open: '#06b6d4',
    in_progress: '#3b82f6',
    resolved: '#10b981',
    closed: '#64748b',
    blocked: '#ef4444'
  }
};

function svgNode(name, attributes = {}, text = null) {
  const node = document.createElementNS(SVG_NS, name);
  Object.entries(attributes).forEach(([key, value]) => node.setAttribute(key, String(value)));
  if (text !== null) node.textContent = text;
  return node;
}

function prepareChart(host, label) {
  host.replaceChildren();
  const svg = svgNode('svg', {
    viewBox: '0 0 760 280',
    role: 'img',
    'aria-label': label,
    focusable: 'false'
  });
  host.appendChild(svg);
  return svg;
}

function addLegend(host, items) {
  host.replaceChildren();
  items.forEach((item) => {
    const entry = document.createElement('span');
    entry.className = 'metrics-chart-legend-item';
    const swatch = document.createElement('i');
    swatch.className = 'metrics-chart-swatch';
    swatch.style.backgroundColor = item.color;
    const label = document.createElement('span');
    label.textContent = item.label;
    entry.append(swatch, label);
    host.appendChild(entry);
  });
}

function showEmpty(host, label) {
  host.replaceChildren();
  const message = document.createElement('p');
  message.className = 'metrics-chart-empty';
  message.textContent = label;
  host.appendChild(message);
}

function chartFrame(svg, maxValue, xLabels, formatter = (value) => String(value)) {
  const left = 48;
  const right = 744;
  const top = 18;
  const bottom = 220;
  const height = bottom - top;
  const max = Math.max(1, maxValue);
  const ticks = [0, Math.ceil(max / 2), max].filter((value, index, list) => list.indexOf(value) === index);
  ticks.forEach((value) => {
    const y = bottom - (value / max) * height;
    svg.appendChild(svgNode('line', { x1: left, y1: y, x2: right, y2: y, class: 'metrics-chart-gridline' }));
    svg.appendChild(svgNode('text', { x: left - 8, y: y + 4, 'text-anchor': 'end', class: 'metrics-chart-axis-label' }, formatter(value)));
  });
  const step = Math.max(1, Math.ceil(xLabels.length / 7));
  xLabels.forEach((label, index) => {
    if (index % step !== 0 && index !== xLabels.length - 1) return;
    const x = xLabels.length <= 1
      ? (left + right) / 2
      : left + (index / (xLabels.length - 1)) * (right - left);
    svg.appendChild(svgNode('text', {
      x,
      y: bottom + 24,
      'text-anchor': 'middle',
      class: 'metrics-chart-axis-label'
    }, label));
  });
  return {
    left,
    right,
    top,
    bottom,
    height,
    max,
    x: (index) => xLabels.length <= 1
      ? (left + right) / 2
      : left + (index / (xLabels.length - 1)) * (right - left),
    y: (value) => bottom - (value / max) * height
  };
}

function renderVolumeChart(host, legend, data) {
  if (!data.length || !data.some((item) => item.created || item.resolved)) {
    showEmpty(host, 'Sin tickets creados o resueltos en este período.');
    legend.replaceChildren();
    return;
  }
  const svg = prepareChart(host, 'Tickets creados y resueltos por período');
  const max = Math.max(...data.flatMap((item) => [item.created, item.resolved]));
  const frame = chartFrame(svg, max, data.map((item) => item.label));
  [
    { key: 'created', color: CHART_COLORS.created },
    { key: 'resolved', color: CHART_COLORS.resolved }
  ].forEach(({ key, color }) => {
    const points = data.map((item, index) => `${frame.x(index)},${frame.y(item[key])}`);
    svg.appendChild(svgNode('polyline', {
      points: points.join(' '),
      fill: 'none',
      stroke: color,
      'stroke-width': 3,
      'stroke-linecap': 'round',
      'stroke-linejoin': 'round'
    }));
    data.forEach((item, index) => {
      svg.appendChild(svgNode('circle', {
        cx: frame.x(index),
        cy: frame.y(item[key]),
        r: 3.5,
        fill: color
      }));
    });
  });
  addLegend(legend, [
    { label: 'Creados', color: CHART_COLORS.created },
    { label: 'Resueltos', color: CHART_COLORS.resolved }
  ]);
}

function renderBacklogChart(host, legend, data, statusLabels) {
  if (!data.length || !data.some((item) => Object.values(item.counts).some(Boolean))) {
    showEmpty(host, 'No hay historial de tickets para mostrar.');
    legend.replaceChildren();
    return;
  }
  const statuses = Object.keys(statusLabels);
  const totals = data.map((item) => statuses.reduce((sum, status) => sum + item.counts[status], 0));
  const svg = prepareChart(host, 'Evolución del total de tickets por estado');
  const frame = chartFrame(svg, Math.max(...totals), data.map((item) => item.label));
  let accumulated = data.map(() => 0);
  statuses.forEach((status) => {
    const lower = accumulated;
    const upper = data.map((item, index) => lower[index] + item.counts[status]);
    const points = [
      ...upper.map((value, index) => `${frame.x(index)},${frame.y(value)}`),
      ...lower.map((value, index) => {
        const reverseIndex = lower.length - index - 1;
        return `${frame.x(reverseIndex)},${frame.y(lower[reverseIndex])}`;
      })
    ];
    svg.appendChild(svgNode('polygon', {
      points: points.join(' '),
      fill: CHART_COLORS.status[status],
      'fill-opacity': 0.72,
      stroke: CHART_COLORS.status[status],
      'stroke-width': 1
    }));
    accumulated = upper;
  });
  addLegend(legend, statuses.map((status) => ({
    label: statusLabels[status],
    color: CHART_COLORS.status[status]
  })));
}

function renderAgentChart(host, agents) {
  const data = agents.filter((agent) => agent.closed > 0);
  if (!data.length) {
    showEmpty(host, 'No hay tickets cerrados por responsables en este período.');
    return;
  }
  const rowHeight = 38;
  const height = Math.max(170, data.length * rowHeight + 34);
  const svg = svgNode('svg', {
    width: 760,
    height,
    class: 'metrics-chart-wide',
    viewBox: `0 0 760 ${height}`,
    role: 'img',
    'aria-label': 'Tickets cerrados por responsable',
    focusable: 'false'
  });
  const left = 190;
  const right = 680;
  const max = Math.max(1, ...data.map((agent) => agent.closed));
  data.forEach((agent, index) => {
    const y = 24 + index * rowHeight;
    const width = (agent.closed / max) * (right - left);
    svg.appendChild(svgNode('text', {
      x: left - 10,
      y: y + 14,
      'text-anchor': 'end',
      class: 'metrics-chart-axis-label'
    }, agent.name));
    svg.appendChild(svgNode('rect', {
      x: left,
      y,
      width,
      height: 20,
      rx: 4,
      fill: CHART_COLORS.closed
    }));
    svg.appendChild(svgNode('text', {
      x: Math.min(right + 8, left + width + 8),
      y: y + 15,
      class: 'metrics-chart-value-label'
    }, String(agent.closed)));
  });
  host.replaceChildren(svg);
}

function renderCategoryChart(host, legend, categories) {
  if (!categories.length || !categories.some((item) => item.created || item.closed)) {
    showEmpty(host, 'Sin tickets por categoría en este período.');
    legend.replaceChildren();
    return;
  }
  const width = Math.max(760, categories.length * 92 + 90);
  const height = 300;
  const svg = svgNode('svg', {
    width,
    height,
    class: 'metrics-chart-wide',
    viewBox: `0 0 ${width} ${height}`,
    role: 'img',
    'aria-label': 'Tickets creados y cerrados por categoría',
    focusable: 'false'
  });
  const left = 42;
  const right = width - 18;
  const top = 16;
  const bottom = 206;
  const max = Math.max(1, ...categories.flatMap((item) => [item.created, item.closed]));
  const slot = (right - left) / categories.length;
  [0, Math.ceil(max / 2), max].filter((value, index, list) => list.indexOf(value) === index).forEach((value) => {
    const y = bottom - (value / max) * (bottom - top);
    svg.appendChild(svgNode('line', { x1: left, y1: y, x2: right, y2: y, class: 'metrics-chart-gridline' }));
    svg.appendChild(svgNode('text', { x: left - 8, y: y + 4, 'text-anchor': 'end', class: 'metrics-chart-axis-label' }, String(value)));
  });
  categories.forEach((category, index) => {
    const center = left + slot * (index + 0.5);
    const barWidth = Math.min(24, slot * 0.28);
    [
      { value: category.created, offset: -barWidth / 2, color: CHART_COLORS.created },
      { value: category.closed, offset: barWidth / 2, color: CHART_COLORS.closed }
    ].forEach(({ value, offset, color }) => {
      const barHeight = (value / max) * (bottom - top);
      svg.appendChild(svgNode('rect', {
        x: center + offset - barWidth / 2,
        y: bottom - barHeight,
        width: barWidth,
        height: barHeight,
        fill: color
      }));
    });
    svg.appendChild(svgNode('text', {
      x: center,
      y: bottom + 14,
      transform: `rotate(-35 ${center} ${bottom + 14})`,
      'text-anchor': 'end',
      class: 'metrics-chart-axis-label'
    }, category.name));
  });
  host.replaceChildren(svg);
  addLegend(legend, [
    { label: 'Creados', color: CHART_COLORS.created },
    { label: 'Cerrados', color: CHART_COLORS.closed }
  ]);
}

function renderResolutionChart(host, data) {
  if (!data.length || !data.some((item) => item.count)) {
    showEmpty(host, 'No hay resoluciones con duración calculable en este período.');
    return;
  }
  const svg = prepareChart(host, 'Distribución del tiempo de resolución');
  const max = Math.max(...data.map((item) => item.count));
  const frame = chartFrame(svg, max, data.map((item) => item.label));
  const slot = (frame.right - frame.left) / data.length;
  data.forEach((item, index) => {
    const barWidth = slot * 0.58;
    const barHeight = (item.count / frame.max) * frame.height;
    svg.appendChild(svgNode('rect', {
      x: frame.x(index) - barWidth / 2,
      y: frame.bottom - barHeight,
      width: barWidth,
      height: barHeight,
      rx: 4,
      fill: CHART_COLORS.resolved
    }));
  });
}

export function renderMetricsCharts(metrics) {
  renderVolumeChart(
    document.getElementById('chartTicketVolume'),
    document.getElementById('legendTicketVolume'),
    metrics.charts.volume
  );
  renderBacklogChart(
    document.getElementById('chartBacklog'),
    document.getElementById('legendBacklog'),
    metrics.charts.backlog,
    metrics.charts.statusLabels
  );
  renderAgentChart(document.getElementById('chartByAgent'), metrics.byAgent);
  renderCategoryChart(
    document.getElementById('chartByCategory'),
    document.getElementById('legendByCategory'),
    metrics.charts.byCategory
  );
  renderResolutionChart(document.getElementById('chartResolutionTime'), metrics.charts.resolutionDistribution);
}

export function clearMetricsCharts(message) {
  [
    'chartTicketVolume',
    'chartBacklog',
    'chartByAgent',
    'chartByCategory',
    'chartResolutionTime'
  ].forEach((id) => showEmpty(document.getElementById(id), message));
  ['legendTicketVolume', 'legendBacklog', 'legendByCategory'].forEach((id) => {
    document.getElementById(id).replaceChildren();
  });
}
