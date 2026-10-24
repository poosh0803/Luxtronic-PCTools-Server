'use strict';

// Dark mode per LUXTRONIC-DESIGN-GUIDELINES.md section 4: a `dark-mode` class on <body>,
// persisted in localStorage under "theme" ("dark"/"light"). Opt-in via the toggle only, never
// inferred from prefers-color-scheme. The class is first applied by a tiny inline script right
// after <body> opens (so there's no flash); this file syncs the icon and handles clicks.
//
// window.onThemeChange is an optional hook a page can define (session.js uses it to rebuild its
// Chart.js charts, which bake theme-dependent colors in at construction time) -- called on every
// user-initiated toggle, not on page load.

const THEME_STORAGE_KEY = 'theme';

function isDark() {
  return document.body.classList.contains('dark-mode');
}

function updateThemeIcon() {
  const icon = document.getElementById('themeIcon');
  if (!icon) return;
  icon.classList.toggle('fa-sun', isDark());
  icon.classList.toggle('fa-moon', !isDark());
}

function highlightNav() {
  // session.html is a child of the Sessions list, so keep that tab lit there.
  let path = window.location.pathname;
  if (path === '/' || path.endsWith('/session.html')) path = '/index.html';
  document.querySelectorAll('.nav-bar .nav-item').forEach((a) => {
    a.classList.toggle('active', a.getAttribute('href') === path);
  });
}

function initDarkMode() {
  updateThemeIcon();
  document.getElementById('darkModeToggle')?.addEventListener('click', () => {
    document.body.classList.toggle('dark-mode');
    try {
      localStorage.setItem(THEME_STORAGE_KEY, isDark() ? 'dark' : 'light');
    } catch (e) { /* storage blocked: toggle still works for this page view */ }
    updateThemeIcon();
    if (typeof window.onThemeChange === 'function') window.onThemeChange(isDark() ? 'dark' : 'light');
  });
}

document.addEventListener('DOMContentLoaded', () => {
  highlightNav();
  initDarkMode();
});
