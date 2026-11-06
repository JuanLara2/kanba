import assert from 'node:assert/strict';
import test from 'node:test';
import { SoundManager } from '../js/utils/soundManager.js';

test('sound manager unlocks after interaction, synthesizes effects, and persists mute state', async () => {
  const originalContext = Object.getOwnPropertyDescriptor(globalThis, 'AudioContext');
  const originalDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
  const originalStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  const listeners = new Map();
  const oscillators = [];
  const masterValues = [];
  const tonePeaks = [];
  const storage = new Map();

  class FakeAudioParam {
    constructor(isGain = false) {
      this.isGain = isGain;
    }

    setValueAtTime() {}
    exponentialRampToValueAtTime(value) {
      if (this.isGain) tonePeaks.push(value);
    }
    setTargetAtTime(value) {
      masterValues.push(value);
    }
  }

  class FakeAudioContext {
    constructor() {
      this.currentTime = 1;
      this.state = 'suspended';
      this.destination = {};
    }

    createGain() {
      return { gain: Object.assign(new FakeAudioParam(true), { value: 0 }), connect() {}, disconnect() {} };
    }

    createOscillator() {
      const oscillator = {
        frequency: new FakeAudioParam(),
        connect() {},
        start(time) { this.startTime = time; },
        stop(time) { this.stopTime = time; },
        disconnect() {},
        addEventListener() {}
      };
      oscillators.push(oscillator);
      return oscillator;
    }

    createBiquadFilter() {
      return { frequency: new FakeAudioParam(), connect() {}, disconnect() {} };
    }

    resume() {
      this.state = 'running';
      return Promise.resolve();
    }
  }

  Object.defineProperty(globalThis, 'AudioContext', { configurable: true, value: FakeAudioContext });
  Object.defineProperty(globalThis, 'document', {
    configurable: true,
    value: {
      addEventListener(type, handler) { listeners.set(type, handler); },
      removeEventListener(type) { listeners.delete(type); }
    }
  });
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      getItem(key) { return storage.get(key) ?? null; },
      setItem(key, value) { storage.set(key, value); }
    }
  });

  try {
    const sounds = new SoundManager();
    assert.equal(sounds.enabled, true);
    listeners.get('pointerdown')();
    assert.equal(listeners.has('keydown'), false);
    assert.equal(await sounds.unlock(), true);
    assert.equal(sounds.masterGain.gain.value, 0.144);
    assert.equal(sounds.playDragStart(), true);
    assert.equal(listeners.has('pointerdown'), false);

    sounds.playDrop();
    sounds.playSubtaskToggle();
    sounds.playTaskDone();
    sounds.playDelete();
    assert.equal(oscillators.length, 7);
    assert.ok(oscillators.every((oscillator) => oscillator.stopTime > oscillator.startTime));
    assert.ok(masterValues.every((value) => value === 0 || value === 0.144));
    assert.ok(tonePeaks.some((value) => value >= 0.6));
    assert.ok(tonePeaks.every((value) => value <= 1));

    assert.equal(sounds.toggleMute(), false);
    assert.equal(sounds.isMuted(), true);
    assert.equal(storage.get('vortex-task-sounds-muted'), 'true');
    assert.equal(sounds.playDrop(), false);
    assert.equal(oscillators.length, 7);

    assert.equal(sounds.toggleMute(), true);
    assert.equal(sounds.isMuted(), false);
    assert.equal(storage.get('vortex-task-sounds-muted'), 'false');
  } finally {
    if (originalContext) Object.defineProperty(globalThis, 'AudioContext', originalContext);
    else delete globalThis.AudioContext;
    if (originalDocument) Object.defineProperty(globalThis, 'document', originalDocument);
    else delete globalThis.document;
    if (originalStorage) Object.defineProperty(globalThis, 'localStorage', originalStorage);
    else delete globalThis.localStorage;
  }
});

test('sound manager waits for audio context resume before scheduling a tone', async () => {
  const originalContext = Object.getOwnPropertyDescriptor(globalThis, 'AudioContext');
  const oscillators = [];
  let finishResume;

  class FakeParam {
    setValueAtTime() {}
    exponentialRampToValueAtTime() {}
    setTargetAtTime() {}
  }

  class FakeAudioContext {
    constructor() {
      this.currentTime = 1;
      this.state = 'suspended';
      this.destination = {};
    }

    createGain() {
      return { gain: Object.assign(new FakeParam(), { value: 0 }), connect() {}, disconnect() {} };
    }

    createOscillator() {
      const oscillator = {
        frequency: new FakeParam(),
        connect() {},
        start() {},
        stop() {},
        disconnect() {},
        addEventListener() {}
      };
      oscillators.push(oscillator);
      return oscillator;
    }

    resume() {
      return new Promise((resolve) => {
        finishResume = () => {
          this.state = 'running';
          resolve();
        };
      });
    }
  }

  Object.defineProperty(globalThis, 'AudioContext', { configurable: true, value: FakeAudioContext });

  try {
    const sounds = new SoundManager();
    assert.equal(sounds.playSubtaskToggle(), true);
    assert.equal(oscillators.length, 0);
    finishResume();
    assert.equal(await sounds.unlock(), true);
    await Promise.resolve();
    assert.equal(oscillators.length, 1);
  } finally {
    if (originalContext) Object.defineProperty(globalThis, 'AudioContext', originalContext);
    else delete globalThis.AudioContext;
  }
});

test('sound manager safely no-ops when Web Audio is unavailable', () => {
  const originalContext = Object.getOwnPropertyDescriptor(globalThis, 'AudioContext');
  const originalWebkitContext = Object.getOwnPropertyDescriptor(globalThis, 'webkitAudioContext');
  Object.defineProperty(globalThis, 'AudioContext', { configurable: true, value: undefined });
  Object.defineProperty(globalThis, 'webkitAudioContext', { configurable: true, value: undefined });

  try {
    const sounds = new SoundManager();
    assert.equal(sounds.playDragStart(), false);
    assert.equal(sounds.playDrop(), false);
    assert.equal(sounds.playSubtaskToggle(), false);
    assert.equal(sounds.playTaskDone(), false);
    assert.equal(sounds.playDelete(), false);
  } finally {
    if (originalContext) Object.defineProperty(globalThis, 'AudioContext', originalContext);
    else delete globalThis.AudioContext;
    if (originalWebkitContext) Object.defineProperty(globalThis, 'webkitAudioContext', originalWebkitContext);
    else delete globalThis.webkitAudioContext;
  }
});
