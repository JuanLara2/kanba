function checkResult(name, passed, details) {
  return { check: name, status: passed ? 'PASS' : 'FAIL', details };
}

export function testMetricsView() {
  const panel = document.getElementById('metricsPanel');
  if (!panel) {
    const report = {
      passed: 0,
      failed: 1,
      checks: [checkResult('Metrics panel', false, '#metricsPanel was not found')]
    };
    console.table(report.checks);
    return report;
  }

  const mobileLayout = window.matchMedia(
    '(max-width: 768px), (max-height: 600px) and (orientation: landscape)'
  ).matches;
  const panelStyle = getComputedStyle(panel);
  const panelVisible = panel.getClientRects().length > 0;
  const scrollEnabled = ['auto', 'scroll'].includes(panelStyle.overflowY);
  const verticalScroll = !mobileLayout || (panelVisible
    && (panel.scrollHeight > panel.clientHeight + 1 || scrollEnabled));
  const checks = [
    checkResult(
      'Vertical scroll',
      verticalScroll,
      mobileLayout
        ? `visible=${panelVisible}; scrollHeight=${panel.scrollHeight}; clientHeight=${panel.clientHeight}; overflow-y=${panelStyle.overflowY}`
        : 'PASS: desktop layout scrolls in its board wrapper; mobile panel scrolling is not required'
    )
  ];

  const horizontalOverflow = panel.scrollWidth > window.innerWidth + 1;
  checks.push(checkResult(
    'No horizontal panel overflow',
    !horizontalOverflow,
    `panel.scrollWidth=${panel.scrollWidth}; viewport=${window.innerWidth}; tolerance=1px`
  ));

  const kpis = [...panel.querySelectorAll('.kpi-card, .metrics-card')];
  const unreadableKpis = kpis.filter((card) => {
    const label = card.querySelector('.metrics-card-label, span');
    const value = card.querySelector('.metrics-card-value, strong');
    return card.getBoundingClientRect().height <= 0
      || !label?.textContent.trim()
      || !value?.textContent.trim()
      || label.scrollWidth > label.clientWidth + 1
      || value.scrollWidth > value.clientWidth + 1;
  });
  checks.push(checkResult(
    'Readable KPI cards',
    kpis.length > 0 && unreadableKpis.length === 0,
    `${kpis.length} KPI cards found; unreadable: ${unreadableKpis.length ? unreadableKpis.map((card) => card.textContent.trim()).join(', ') : 'none'}`
  ));

  const canvases = [...panel.querySelectorAll('canvas')];
  let chartsPass;
  let chartDetails;
  if (canvases.length) {
    const invalidCanvases = canvases.filter((canvas) => {
      const fixedCssSize = [canvas.style.width, canvas.style.height]
        .some((size) => /^\d+(?:\.\d+)?px$/.test(size));
      const fixedAttributes = canvas.hasAttribute('width') || canvas.hasAttribute('height');
      return canvas.clientHeight <= 100
        || canvas.clientWidth <= 100
        || fixedCssSize
        || fixedAttributes;
    });
    chartsPass = invalidCanvases.length === 0;
    chartDetails = `${canvases.length} canvas elements; invalid dimensions or fixed pixel sizing: ${invalidCanvases.length}`;
  } else {
    const chartHosts = [...panel.querySelectorAll('.metrics-chart-canvas')];
    const invalidHosts = chartHosts.filter((host) => {
      const rect = host.getBoundingClientRect();
      const svgCharts = [...host.querySelectorAll('svg')];
      const hasChart = svgCharts.length > 0 || host.querySelector('.metrics-chart-empty');
      const undersizedSvg = svgCharts.some((svg) => {
        const svgRect = svg.getBoundingClientRect();
        return svgRect.width <= 100 || svgRect.height <= 100;
      });
      return rect.width <= 100 || rect.height <= 100 || !hasChart || undersizedSvg;
    });
    chartsPass = chartHosts.length > 0 && invalidHosts.length === 0;
    chartDetails = `No Chart.js canvas present; ${chartHosts.length} native SVG chart wrappers; invalid or unrendered: ${invalidHosts.length}`;
  }
  checks.push(checkResult('Responsive chart dimensions', chartsPass, chartDetails));

  const paddingBottom = Number.parseFloat(panelStyle.paddingBottom) || 0;
  checks.push(checkResult(
    'Bottom safe-area padding',
    !mobileLayout || paddingBottom >= 80,
    mobileLayout
      ? `padding-bottom=${paddingBottom}px; minimum=80px`
      : 'PASS: desktop layout does not use a fixed bottom navigation bar'
  ));

  const passed = checks.filter((check) => check.status === 'PASS').length;
  const report = { passed, failed: checks.length - passed, checks };
  console.table(checks);
  console.info(`Metrics view: ${passed}/${checks.length} checks passed.`);
  return report;
}

if (typeof window !== 'undefined') {
  window.__testMetricsView = testMetricsView;
}
