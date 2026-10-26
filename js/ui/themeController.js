export const THEME_STORAGE_KEY = 'nexusdesk-theme';
export const AVAILABLE_THEMES = ['dark', 'light', 'pink'];

export function initializeThemeController(documentRef = document, storage = localStorage) {
  const selector = documentRef.getElementById('themeSelect');
  const savedTheme = storage.getItem(THEME_STORAGE_KEY);
  const initialTheme = AVAILABLE_THEMES.includes(savedTheme) ? savedTheme : 'dark';

  function setTheme(theme) {
    if (!AVAILABLE_THEMES.includes(theme)) return;
    documentRef.documentElement.dataset.theme = theme;
    selector.value = theme;
    storage.setItem(THEME_STORAGE_KEY, theme);
  }

  setTheme(initialTheme);
  selector.addEventListener('change', () => setTheme(selector.value));
  return setTheme;
}
