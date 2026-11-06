const colorStops = [
  { r: 0, g: 220, b: 255 },
  { r: 60, g: 100, b: 255 },
  { r: 160, g: 30, b: 240 },
  { r: 235, g: 35, b: 195 }
];

function getColor(factor) {
  const scaled = Math.max(0, Math.min(1, factor)) * (colorStops.length - 1);
  const index = Math.floor(scaled);
  const mix = scaled - index;
  const start = colorStops[index];
  const end = colorStops[Math.min(index + 1, colorStops.length - 1)];
  const red = Math.round(start.r + (end.r - start.r) * mix);
  const green = Math.round(start.g + (end.g - start.g) * mix);
  const blue = Math.round(start.b + (end.b - start.b) * mix);
  return `rgb(${red}, ${green}, ${blue})`;
}

export function createSplashScreen() {
  const minimumVisibleMs = 5000;
  const startedAt = performance.now();
  const splash = document.getElementById('splashScreen');
  const canvas = document.getElementById('splashVortex');
  const context = canvas.getContext('2d');
  const progressTrack = document.getElementById('splashProgressTrack');
  const progressFill = document.getElementById('splashProgressFill');
  const status = document.getElementById('splashStatus');
  let hideTimeout;
  let autoHideTimeout;
  let progressTimer;
  let currentProgress = 5;
  let hidePromise;

  const loadingStages = [
    { at: 0, text: 'Iniciando motor...' },
    { at: 450, text: 'Cargando tablero...' },
    { at: 1050, text: 'Sincronizando tareas...' },
    { at: 1800, text: 'Preparando espacio de trabajo...' }
  ];

  function renderVortex() {
    const center = canvas.width / 2;
    context.clearRect(0, 0, canvas.width, canvas.height);
    context.save();
    context.translate(center, center);

    for (let index = 0; index < 28; index += 1) {
      const factor = index / 28;
      const angle = factor * Math.PI * 2;
      const radius = 190;
      const color = getColor(factor);

      context.save();
      context.rotate(angle);
      context.beginPath();
      context.moveTo(radius, 0);
      context.bezierCurveTo(
        radius * 0.75, radius * 0.45,
        radius * 0.35, radius * 0.65,
        0, 0
      );
      context.strokeStyle = color;
      context.lineWidth = 4.2;
      context.lineCap = 'round';
      context.shadowColor = color;
      context.shadowBlur = 12;
      context.stroke();
      context.restore();
    }
    context.restore();
  }

  if (context) {
    renderVortex();
  }

  function setProgress(value, message) {
    const progress = Math.max(0, Math.min(100, value));
    currentProgress = Math.max(currentProgress, progress);
    progressTrack.setAttribute('aria-valuenow', String(currentProgress));
    progressFill.style.width = `${currentProgress}%`;
    status.textContent = message;
  }

  progressTimer = window.setInterval(() => {
    const elapsed = performance.now() - startedAt;
    let stage = loadingStages[0];
    for (const loadingStage of loadingStages) {
      if (elapsed >= loadingStage.at) stage = loadingStage;
    }
    const simulatedProgress = Math.min(88, 5 + (elapsed / minimumVisibleMs) * 83);
    setProgress(simulatedProgress, stage.text);
  }, 100);

  function hide({ ready = true } = {}) {
    if (hidePromise) return hidePromise;

    window.clearTimeout(autoHideTimeout);
    hidePromise = (async () => {
      if (ready) {
        const remainingTime = Math.max(0, minimumVisibleMs - (performance.now() - startedAt));
        if (remainingTime > 0) {
          await new Promise((resolve) => window.setTimeout(resolve, remainingTime));
        }
        window.clearInterval(progressTimer);
        setProgress(100, '¡Listo!');
        await new Promise((resolve) => {
          hideTimeout = window.setTimeout(resolve, 300);
        });
      } else {
        window.clearInterval(progressTimer);
        window.clearTimeout(hideTimeout);
      }

      splash.classList.add('is-hidden');
    })();

    return hidePromise;
  }

  autoHideTimeout = window.setTimeout(() => {
    if (!hidePromise) hide();
  }, minimumVisibleMs);

  return { setProgress, hide };
}
