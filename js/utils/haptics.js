function vibrate(pattern) {
  const device = globalThis.navigator;
  if (!Haptics.isSupported) return false;
  if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return false;

  const activation = device.userActivation;
  if (activation?.isActive === false && activation?.hasBeenActive === false) return false;

  try {
    return device.vibrate(pattern);
  } catch {
    return false;
  }
}

export const Haptics = {
  get isSupported() {
    return typeof navigator !== 'undefined'
      && 'vibrate' in navigator
      && typeof navigator.vibrate === 'function';
  },

  dragStart() {
    return vibrate(35);
  },

  dropSuccess() {
    return vibrate([20, 30, 20]);
  },

  selectionTick() {
    return vibrate(15);
  },

  tabSwitch() {
    return vibrate(10);
  },

  destructive() {
    return vibrate([40, 60, 60]);
  },

  actionSuccess() {
    return vibrate(15);
  }
};
