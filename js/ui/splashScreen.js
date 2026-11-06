export function createSplashScreen() {
  const minimumVisibleMs = 5000;
  const startedAt = performance.now();
  const splash = document.getElementById('splashScreen');
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
