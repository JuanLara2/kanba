const SOUND_MUTED_STORAGE_KEY = 'vortex-task-sounds-muted';
const MASTER_VOLUME = 0.12;

function getAudioContextConstructor() {
  return globalThis.AudioContext || globalThis.webkitAudioContext || null;
}

function readMutedPreference() {
  try {
    return globalThis.localStorage?.getItem(SOUND_MUTED_STORAGE_KEY) === 'true';
  } catch {
    return false;
  }
}

export class SoundManager {
  constructor() {
    this.enabled = !readMutedPreference();
    this.context = null;
    this.masterGain = null;
    this.unlockHandler = () => this.unlock();

    if (typeof document !== 'undefined') {
      document.addEventListener('pointerdown', this.unlockHandler, { capture: true, once: true });
      document.addEventListener('keydown', this.unlockHandler, { capture: true, once: true });
    }
  }

  isMuted() {
    return !this.enabled;
  }

  toggleMute() {
    this.enabled = !this.enabled;
    try {
      globalThis.localStorage?.setItem(SOUND_MUTED_STORAGE_KEY, String(!this.enabled));
    } catch {
      // Audio remains usable when persistent storage is unavailable.
    }
    if (this.masterGain && this.context) {
      const now = this.context.currentTime;
      this.masterGain.gain.setTargetAtTime(this.enabled ? MASTER_VOLUME : 0, now, 0.015);
    }
    return this.enabled;
  }

  unlock() {
    this.removeUnlockListeners();
    if (!this.ensureAudioGraph()) return false;
    if (this.context.state === 'suspended') {
      this.context.resume()?.catch((error) => {
        console.warn('No se pudo activar el audio del navegador.', error);
      });
    }
    return true;
  }

  removeUnlockListeners() {
    if (typeof document === 'undefined') return;
    document.removeEventListener('pointerdown', this.unlockHandler, true);
    document.removeEventListener('keydown', this.unlockHandler, true);
  }

  ensureAudioGraph() {
    if (this.context && this.masterGain) return true;
    const AudioContextConstructor = getAudioContextConstructor();
    if (!AudioContextConstructor) return false;

    try {
      this.context = new AudioContextConstructor();
      this.masterGain = this.context.createGain();
      this.masterGain.gain.value = this.enabled ? MASTER_VOLUME : 0;
      this.masterGain.connect(this.context.destination);
      return true;
    } catch {
      this.context = null;
      this.masterGain = null;
      return false;
    }
  }

  playTone({
    frequency,
    endFrequency = frequency,
    duration,
    volume = 0.7,
    type = 'sine',
    filterFrequency = null,
    delay = 0
  }) {
    if (!this.enabled || !this.ensureAudioGraph()) return false;
    if (this.context.state === 'suspended') this.unlock();

    const start = this.context.currentTime + delay;
    const end = start + duration;
    const oscillator = this.context.createOscillator();
    const envelope = this.context.createGain();
    let output = oscillator;
    let filter = null;

    oscillator.type = type;
    oscillator.frequency.setValueAtTime(frequency, start);
    if (endFrequency !== frequency) {
      oscillator.frequency.exponentialRampToValueAtTime(Math.max(1, endFrequency), end);
    }

    if (filterFrequency) {
      filter = this.context.createBiquadFilter();
      filter.type = 'lowpass';
      filter.frequency.setValueAtTime(filterFrequency, start);
      output.connect(filter);
      output = filter;
    }

    output.connect(envelope);
    envelope.connect(this.masterGain);
    envelope.gain.setValueAtTime(0.0001, start);
    envelope.gain.exponentialRampToValueAtTime(Math.min(volume, 1), start + Math.min(0.006, duration / 3));
    envelope.gain.exponentialRampToValueAtTime(0.0001, end);

    oscillator.start(start);
    oscillator.stop(end + 0.005);
    oscillator.addEventListener('ended', () => {
      oscillator.disconnect();
      filter?.disconnect();
      envelope.disconnect();
    }, { once: true });
    return true;
  }

  playDragStart() {
    return this.playTone({ frequency: 720, endFrequency: 260, duration: 0.055, volume: 0.65 });
  }

  playDrop() {
    return this.playTone({
      frequency: 210,
      endFrequency: 105,
      duration: 0.08,
      volume: 0.85,
      type: 'triangle',
      filterFrequency: 850
    });
  }

  playSubtaskToggle() {
    return this.playTone({ frequency: 680, endFrequency: 520, duration: 0.04, volume: 0.6 });
  }

  playTaskDone() {
    const notes = [523.25, 659.25, 783.99];
    let played = false;
    notes.forEach((frequency, index) => {
      played = this.playTone({
        frequency,
        duration: index === notes.length - 1 ? 0.07 : 0.09,
        delay: index * 0.055,
        volume: 0.75,
        type: 'triangle',
        filterFrequency: 2600
      }) || played;
    });
    return played;
  }

  playDelete() {
    return this.playTone({
      frequency: 240,
      endFrequency: 75,
      duration: 0.1,
      volume: 0.8,
      type: 'triangle',
      filterFrequency: 500
    });
  }
}

export const soundManager = new SoundManager();
