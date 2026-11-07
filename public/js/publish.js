'use strict';

// Publish page: uploads of PC client builds, one entry per release. Stored as category "client" in
// the apps table (CONTRACT.md section 4); helpers come from common.js.

const CLIENT_NAME = 'Luxtronic PCTools';
let releases = []; // newest first (the API orders client releases by upload time)

function rowHtml(r, isLatest) {
  const fileCell = r.file_name
    ? `${esc(r.file_name)} <span class="muted">${fmtSize(r.file_size)}</span>` +
      `<div class="muted sha" title="SHA-256">${esc(r.file_sha256)}</div>`
    : '<span class="badge aborted">no file</span>';
  return `
    <tr>
      <td><strong>v${esc(r.version)}</strong>${isLatest ? ' <span class="badge pass">Latest</span>' : ''}</td>
      <td class="notes">${r.description ? esc(r.description) : '<span class="muted">-</span>'}</td>
      <td>${fileCell}</td>
      <td>${fmtDateTime(r.created_at)}</td>
      <td class="row-actions">
        ${r.file_name ? `<a class="button-link" href="/api/apps/${r.id}/download">Download</a>` : ''}
        <button type="button" class="secondary act-edit" data-id="${r.id}">Edit</button>
        <button type="button" class="stop-btn act-delete" data-id="${r.id}">Delete</button>
      </td>
    </tr>`;
}

async function loadReleases() {
  try {
    releases = await fetchJson('/api/apps?category=client');
  } catch (err) {
    document.getElementById('releases-body').innerHTML = '<tr><td colspan="5" class="empty-state">-</td></tr>';
    showError(`Failed to load releases: ${err.message}`);
    return;
  }
  renderReleases();
}

function renderReleases() {
  const body = document.getElementById('releases-body');
  const q = document.getElementById('search').value.trim().toLowerCase();
  const latestId = (releases.find((r) => r.file_name) || {}).id;
  const list = q
    ? releases.filter((r) => [r.version, r.description, r.file_name].some((v) => (v || '').toLowerCase().includes(q)))
    : releases;
  if (list.length === 0) {
    body.innerHTML = `<tr><td colspan="5" class="empty-state">${releases.length ? 'No releases match your search.' : 'No releases published yet.'}</td></tr>`;
    return;
  }
  body.innerHTML = list.map((r) => rowHtml(r, r.id === latestId)).join('');
  const byId = Object.fromEntries(list.map((r) => [r.id, r]));
  body.querySelectorAll('.act-edit').forEach((b) => b.addEventListener('click', () => openDialog(byId[b.dataset.id])));
  body.querySelectorAll('.act-delete').forEach((b) => b.addEventListener('click', () => deleteRelease(byId[b.dataset.id])));
}

async function deleteRelease(r) {
  if (!confirm(`Permanently delete release v${r.version} and its uploaded file? This cannot be undone.`)) return;
  clearError();
  try {
    await fetchJson(`/api/apps/${r.id}`, { method: 'DELETE' });
    await loadReleases();
  } catch (err) {
    showError(`Failed to delete v${r.version}: ${err.message}`);
  }
}

const dialog = document.getElementById('release-dialog');
const form = document.getElementById('release-form');
const dialogTitle = dialog.querySelector('h2');
const saveBtn = document.getElementById('save-btn');
let editing = null; // the release being edited (or one created by a failed publish, being retried)

const hint = document.createElement('p');
hint.className = 'muted';
hint.style.display = 'none';
const dialogError = document.createElement('div');
dialogError.className = 'error-banner';
dialogError.style.display = 'none';
dialog.querySelector('.modal-body').prepend(hint);
dialog.querySelector('.modal-body').prepend(dialogError);

function openDialog(release) {
  clearError();
  editing = release || null;
  dialogError.style.display = 'none';
  form.reset();
  dialogTitle.textContent = release ? `Edit release v${release.version}` : 'New release';
  saveBtn.textContent = release ? 'Save' : 'Publish';
  if (release) {
    form.elements.version.value = release.version || '';
    form.elements.notes.value = release.description || '';
    hint.textContent = release.file_name
      ? `Current file: ${release.file_name} (${fmtSize(release.file_size)}). Choose a new file only to replace it.`
      : 'No file uploaded yet.';
    hint.style.display = '';
  } else {
    hint.style.display = 'none';
  }
  dialog.showModal();
  form.elements.version.focus();
}

document.getElementById('new-release-btn').addEventListener('click', () => openDialog(null));
// Only the X closes the dialog: clicking outside it and Esc are deliberately ignored.
document.getElementById('cancel-btn').addEventListener('click', () => {
  if (!saveBtn.disabled) dialog.close();
});
dialog.addEventListener('cancel', (e) => e.preventDefault());
document.getElementById('search').addEventListener('input', renderReleases);

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  clearError();
  dialogError.style.display = 'none';
  const data = new FormData(form);
  const file = data.get('file');
  const version = data.get('version').trim();
  const hasFile = file && file.size;

  if (!version) {
    dialogError.textContent = 'Enter the version of this build.';
    dialogError.style.display = 'block';
    return;
  }
  if (!editing && !hasFile) {
    dialogError.textContent = 'Choose the client build to publish.';
    dialogError.style.display = 'block';
    return;
  }

  saveBtn.disabled = true;
  let saved = null;
  try {
    const fields = { version, description: data.get('notes').trim() };
    saved = editing
      ? await fetchJson(`/api/apps/${editing.id}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(fields),
        })
      : await fetchJson('/api/apps', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ category: 'client', name: CLIENT_NAME, ...fields }),
        });
    if (hasFile) await uploadPackage(saved.id, file);
    form.reset();
    dialog.close();
  } catch (err) {
    dialogError.textContent = saved
      ? `Saved, but the upload failed: ${err.message}. Press ${editing ? 'Save' : 'Publish'} to retry the upload.`
      : `Failed to ${editing ? 'save' : 'publish'}: ${err.message}`;
    dialogError.style.display = 'block';
    if (saved && !editing) editing = saved; // a retry updates this release instead of creating a duplicate version
  } finally {
    saveBtn.disabled = false;
    await loadReleases();
  }
});

loadReleases();
