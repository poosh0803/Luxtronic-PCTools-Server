'use strict';

// Wires up the #theme-toggle button on both dashboard pages. Dark mode is only ever applied
// because the button was clicked (or because localStorage remembers a previous click) -- it is
// never inferred from the OS/browser's prefers-color-scheme, which used to be how this worked
// and surprised someone whose system was set to dark. The actual `data-theme` attribute is set
// by a small inline script in each page's <head>, before this file loads, so there's no flash of
// the wrong theme on page load; this file only syncs the button's icon and handles clicks.
//
// window.onThemeChange is an optional hook a page can define (session.js uses it to rebuild its
// Chart.js charts, which bake theme-dependent colors in at construction time and don't pick up
// new Chart.defaults on their own) -- called on every *user-initiated* toggle, not on page load.

const THEME_STORAGE_KEY = 'luxtronic-theme';

function currentTheme() {
  return document.documentElement.getAttribute('data-theme') === 'dark' ? 'dark' : 'light';
}

function updateToggleButton(theme) {
  const btn = document.getElementById('theme-toggle');
  if (!btn) return;
  btn.textContent = theme === 'dark' ? '☀️ Light' : '🌙 Dark';
  btn.setAttribute('aria-label', theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme');
}

function applyTheme(theme, notify) {
  document.documentElement.setAttribute('data-theme', theme);
  localStorage.setItem(THEME_STORAGE_KEY, theme);
  updateToggleButton(theme);
  if (notify && typeof window.onThemeChange === 'function') {
    window.onThemeChange(theme);
  }
}

// Sync the button to whatever the head script already applied -- no notify, this isn't a change.
updateToggleButton(currentTheme());

document.getElementById('theme-toggle')?.addEventListener('click', () => {
  applyTheme(currentTheme() === 'dark' ? 'light' : 'dark', true);
});
