'use strict';

function showError(message) {
  const box = document.getElementById('error');
  box.textContent = message;
  box.style.display = 'block';
}

function clearError() {
  document.getElementById('error').style.display = 'none';
}

function fmtDateTime(iso) {
  if (!iso) return '-';
  return new Date(iso).toLocaleString();
}

function statusBadge(active) {
  return active
    ? '<span class="badge pass">active</span>'
    : '<span class="badge aborted">inactive</span>';
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
  if (res.status === 204) return null; // DELETE /api/technicians/:id has no body
  return res.json();
}

async function loadTechnicians() {
  const body = document.getElementById('technicians-body');
  try {
    const techs = await fetchJson('/api/technicians');
    if (techs.length === 0) {
      body.innerHTML = '<tr><td colspan="4" class="empty-state">No technicians yet.</td></tr>';
      return;
    }
    body.innerHTML = techs
      .map(
        (t) => `
        <tr>
          <td>${t.name}</td>
          <td>${statusBadge(t.active)}</td>
          <td>${fmtDateTime(t.created_at)}</td>
          <td class="row-actions">
            <button type="button" class="secondary toggle-active-btn" data-id="${t.id}" data-name="${t.name}" data-active="${t.active}">${t.active ? 'Deactivate' : 'Reactivate'}</button>
            <button type="button" class="stop-btn delete-btn" data-id="${t.id}" data-name="${t.name}">Delete</button>
          </td>
        </tr>`
      )
      .join('');
    body.querySelectorAll('.toggle-active-btn').forEach((btn) => {
      btn.addEventListener('click', () =>
        toggleActive(btn.dataset.id, btn.dataset.name, btn.dataset.active !== 'true')
      );
    });
    body.querySelectorAll('.delete-btn').forEach((btn) => {
      btn.addEventListener('click', () => deleteTechnician(btn.dataset.id, btn.dataset.name));
    });
  } catch (err) {
    body.innerHTML = '<tr><td colspan="4" class="empty-state">-</td></tr>';
    showError(`Failed to load technicians: ${err.message}`);
  }
}

async function toggleActive(id, name, nextActive) {
  const message = nextActive
    ? `Reactivate ${name}? Their existing API key will start working again immediately.`
    : `Deactivate ${name}? Their API key stops working immediately -- any test they're mid-run ` +
      `on the client side will start failing its next request. This doesn't delete their past ` +
      `sessions.`;
  if (!confirm(message)) return;
  clearError();

  try {
    await fetchJson(`/api/technicians/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ active: nextActive }),
    });
    await loadTechnicians();
  } catch (err) {
    showError(`Failed to update ${name}: ${err.message}`);
  }
}

async function deleteTechnician(id, name) {
  // Distinct from Deactivate: this is permanent, and the server itself refuses if this
  // technician has any session history (see dashboard.js's DELETE /api/technicians/:id) --
  // this confirm is only guarding the case where it *would* succeed, i.e. a brand new/typo'd
  // entry with nothing attached to it yet.
  if (!confirm(`Permanently delete ${name}? This cannot be undone. If they have any session ` +
    `history, the server will refuse and tell you to deactivate instead.`)) return;
  clearError();

  try {
    await fetchJson(`/api/technicians/${id}`, { method: 'DELETE' });
    await loadTechnicians();
  } catch (err) {
    showError(`Failed to delete ${name}: ${err.message}`);
  }
}

document.getElementById('create-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  clearError();
  const name = new FormData(e.target).get('name').trim();
  if (!name) return;

  try {
    const result = await fetchJson('/api/technicians', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name }),
    });
    document.getElementById('new-key-value').value = result.api_key;
    document.getElementById('new-key-path').textContent = result.key_file_path;
    document.getElementById('new-key-panel').style.display = '';
    document.getElementById('new-key-panel').scrollIntoView({ behavior: 'smooth', block: 'start' });
    e.target.reset();
    await loadTechnicians();
  } catch (err) {
    showError(`Failed to create technician: ${err.message}`);
  }
});

document.getElementById('copy-key-btn').addEventListener('click', () => {
  const input = document.getElementById('new-key-value');
  input.select();
  input.setSelectionRange(0, 99999); // mobile Safari needs an explicit range, not just select()

  // navigator.clipboard requires a secure context (HTTPS/localhost) -- this dashboard runs over
  // plain HTTP on the LAN, so that API is unavailable in most browsers here. execCommand('copy')
  // is deprecated but still broadly supported and works without a secure context, which is
  // exactly what's needed for this specific deployment. If even that fails, the key is already
  // selected, so a manual Ctrl+C still works -- not a hard failure either way.
  const btn = document.getElementById('copy-key-btn');
  try {
    const copied = document.execCommand('copy');
    if (copied) {
      const original = btn.textContent;
      btn.textContent = 'Copied!';
      setTimeout(() => {
        btn.textContent = original;
      }, 1500);
    }
  } catch {
    /* Key text is already selected -- Ctrl+C still works even if this failed. */
  }
});

document.getElementById('dismiss-key-btn').addEventListener('click', () => {
  document.getElementById('new-key-panel').style.display = 'none';
});

loadTechnicians();
