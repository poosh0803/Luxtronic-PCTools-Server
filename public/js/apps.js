'use strict';

// Shared by apps.html and drivers.html; the page picks its category via <body data-category>.
const CATEGORY = document.body.dataset.category || 'app';
const NOUN = CATEGORY;

function showError(message) {
  const box = document.getElementById('error');
  box.textContent = message;
  box.style.display = 'block';
}

function clearError() {
  document.getElementById('error').style.display = 'none';
}

const HTML_ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => HTML_ESCAPES[c]);
}

function fmtDateTime(iso) {
  return iso ? new Date(iso).toLocaleString() : '-';
}

function fmtSize(bytes) {
  if (bytes == null) return '';
  const n = Number(bytes);
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

async function fetchJson(url, options) {
  const res = await fetch(url, options);
  if (!res.ok) {
    let detail = '';
    try {
      detail = (await res.json()).message || '';
    } catch {
      /* ignore */
    }
    throw new Error(`${res.status} ${res.statusText}${detail ? ` -- ${detail}` : ''}`);
  }
  if (res.status === 204) return null;
  return res.json();
}

// XHR rather than fetch so large installers get upload progress.
function putFile(url, file, contentType, label) {
  return new Promise((resolve, reject) => {
    const bar = document.getElementById('upload-bar');
    const wrap = document.getElementById('upload-progress');
    const text = document.getElementById('upload-label');
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', url);
    xhr.setRequestHeader('Content-Type', contentType);
    xhr.upload.onprogress = (e) => {
      if (!e.lengthComputable) return;
      const pct = Math.round((e.loaded / e.total) * 100);
      wrap.style.display = '';
      bar.style.width = `${pct}%`;
      text.textContent = `${label} ${pct}% (${fmtSize(e.loaded)} / ${fmtSize(e.total)})`;
    };
    xhr.onload = () => {
      wrap.style.display = 'none';
      if (xhr.status >= 200 && xhr.status < 300) return resolve(JSON.parse(xhr.responseText));
      let detail = '';
      try {
        detail = JSON.parse(xhr.responseText).message || '';
      } catch {
        /* ignore */
      }
      reject(new Error(`${xhr.status}${detail ? ` -- ${detail}` : ''}`));
    };
    xhr.onerror = () => {
      wrap.style.display = 'none';
      reject(new Error('network error during upload'));
    };
    xhr.send(file);
  });
}

function uploadPackage(id, file) {
  return putFile(
    `/api/apps/${id}/file?filename=${encodeURIComponent(file.name)}`,
    file,
    'application/octet-stream',
    `Uploading ${file.name}`
  );
}

function uploadIcon(id, file) {
  const type = file.type || (/\.ico$/i.test(file.name) ? 'image/x-icon' : '');
  return putFile(`/api/apps/${id}/icon`, file, type, 'Uploading icon');
}

function iconCell(a) {
  if (!a.icon_mime) return '<span class="app-icon app-icon-empty"><i class="fas fa-cube"></i></span>';
  return `<img class="app-icon" src="/api/apps/${a.id}/icon?v=${encodeURIComponent(a.updated_at)}" alt="">`;
}

function rowHtml(a) {
  const fileCell = a.file_name
    ? `${esc(a.file_name)} <span class="muted">${fmtSize(a.file_size)}</span>` +
      `<div class="muted sha" title="SHA-256">${esc(a.file_sha256)}</div>`
    : '<span class="badge aborted">no file</span>';
  return `
    <tr>
      <td>${iconCell(a)}</td>
      <td><strong>${esc(a.name)}</strong>${a.version ? ` <span class="muted">v${esc(a.version)}</span>` : ''}
        ${a.description ? `<div class="muted">${esc(a.description)}</div>` : ''}</td>
      <td>${fileCell}</td>
      <td>${fmtDateTime(a.updated_at)}</td>
      <td class="row-actions">
        ${a.file_name ? `<a class="button-link" href="/api/apps/${a.id}/download">Download</a>` : ''}
        <button type="button" class="secondary act-edit" data-id="${a.id}">Edit</button>
        <button type="button" class="stop-btn act-delete" data-id="${a.id}">Delete</button>
      </td>
    </tr>`;
}

let allApps = [];

function matchesSearch(a, q) {
  return [a.name, a.version, a.description, a.file_name].some((v) => (v || '').toLowerCase().includes(q));
}

async function loadApps() {
  try {
    allApps = await fetchJson(`/api/apps?category=${CATEGORY}`);
  } catch (err) {
    document.getElementById('apps-body').innerHTML = '<tr><td colspan="5" class="empty-state">-</td></tr>';
    showError(`Failed to load ${NOUN}s: ${err.message}`);
    return;
  }
  renderApps();
}

function renderApps() {
  const body = document.getElementById('apps-body');
  const q = document.getElementById('search').value.trim().toLowerCase();
  const list = q ? allApps.filter((a) => matchesSearch(a, q)) : allApps;
  try {
    if (list.length === 0) {
      body.innerHTML = `<tr><td colspan="5" class="empty-state">${allApps.length ? `No ${NOUN}s match your search.` : `No ${NOUN}s yet.`}</td></tr>`;
      return;
    }
    body.innerHTML = list.map(rowHtml).join('');
    const byId = Object.fromEntries(list.map((a) => [a.id, a]));
    const wire = (cls, fn) =>
      body.querySelectorAll(cls).forEach((b) => b.addEventListener('click', () => fn(byId[b.dataset.id])));
    wire('.act-edit', editApp);
    wire('.act-delete', deleteApp);
  } catch (err) {
    showError(`Failed to show ${NOUN}s: ${err.message}`);
  }
}

async function deleteApp(app) {
  if (!confirm(`Permanently delete ${app.name} and its uploaded file? This cannot be undone.`)) return;
  clearError();
  try {
    await fetchJson(`/api/apps/${app.id}`, { method: 'DELETE' });
    await loadApps();
  } catch (err) {
    showError(`Failed to delete ${app.name}: ${err.message}`);
  }
}

const dialog = document.getElementById('new-app-dialog');
const form = document.getElementById('create-form');
const dialogTitle = dialog.querySelector('h2');
const submitBtn = document.getElementById('create-btn');
const createTitle = dialogTitle.textContent;
let editing = null; // the app being edited, or null when creating

// "Current file" note shown above the fields in edit mode.
const editHint = document.createElement('p');
editHint.className = 'muted';
editHint.style.display = 'none';
dialog.querySelector('.modal-body').prepend(editHint);

const dialogError = document.createElement('div');
dialogError.className = 'error-banner';
dialogError.style.display = 'none';
dialog.querySelector('.modal-body').prepend(dialogError);

function openDialog(app) {
  clearError();
  editing = app || null;
  dialogError.style.display = 'none';
  form.reset();
  dialogTitle.textContent = app ? `Edit ${NOUN}` : createTitle;
  submitBtn.textContent = app ? 'Save' : 'Create';
  if (app) {
    form.elements.name.value = app.name;
    form.elements.version.value = app.version || '';
    form.elements.description.value = app.description || '';
    editHint.textContent = app.file_name
      ? `Current file: ${app.file_name} (${fmtSize(app.file_size)}). Choose a new file only to replace it.`
      : 'No file uploaded yet.';
    editHint.style.display = '';
  } else {
    editHint.style.display = 'none';
  }
  dialog.showModal();
  form.elements.name.focus();
}

function editApp(app) {
  openDialog(app);
}

document.getElementById('new-app-btn').addEventListener('click', () => openDialog(null));
const closeDialog = () => {
  if (!submitBtn.disabled) dialog.close();
};
// Only the X closes the dialog: clicking outside it and Esc are deliberately ignored.
document.getElementById('cancel-btn').addEventListener('click', closeDialog);
dialog.addEventListener('cancel', (e) => e.preventDefault());
document.getElementById('search').addEventListener('input', renderApps);

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  clearError();
  dialogError.style.display = 'none';
  const data = new FormData(form);
  const file = data.get('file');
  const icon = data.get('icon');
  const fields = {
    name: data.get('name').trim(),
    version: data.get('version').trim(),
    description: data.get('description').trim(),
  };
  submitBtn.disabled = true;
  let saved = null;
  try {
    saved = editing
      ? await fetchJson(`/api/apps/${editing.id}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(fields),
        })
      : await fetchJson('/api/apps', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ category: CATEGORY, ...fields }),
        });
    // Icon first so the .exe auto-extraction on the file upload doesn't override a chosen icon.
    if (icon && icon.size) await uploadIcon(saved.id, icon);
    if (file && file.size) await uploadPackage(saved.id, file);
    form.reset();
    dialog.close();
  } catch (err) {
    // Keep the dialog open (with what was typed) and show the error inside it.
    dialogError.textContent = saved
      ? `Saved, but an upload failed: ${err.message}. Press Save to retry the upload.`
      : `Failed to ${editing ? 'save' : 'create'} ${NOUN}: ${err.message}`;
    dialogError.style.display = 'block';
    if (saved && !editing) editing = saved; // retry updates this entry instead of creating a duplicate
  } finally {
    submitBtn.disabled = false;
    await loadApps();
  }
});

loadApps();
