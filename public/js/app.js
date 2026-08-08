'use strict';

// Session list page: fetch + render, with client-side-submitted filters passed straight through
// as query params to GET /api/sessions (CONTRACT.md section 4).

function resultBadge(result, isRunning) {
  if (isRunning) return `<span class="badge running">running</span>`;
  const cls = result || 'unknown';
  return `<span class="badge ${cls}">${result || 'unknown'}</span>`;
}

function fmtDateTime(iso) {
  if (!iso) return '-';
  const d = new Date(iso);
  return d.toLocaleString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function renderTestRuns(testRuns) {
  if (!testRuns || testRuns.length === 0) return '<span class="muted">none</span>';
  return testRuns
    .map((tr) => {
      const running = !tr.ended_at;
      return `<div>${tr.component} ${resultBadge(tr.result, running)}</div>`;
    })
    .join('');
}

function sessionStatus(session) {
  if (!session.ended_at) return '<span class="badge running">active</span>';
  const anyFail = session.test_runs.some((tr) => tr.result === 'fail');
  const anyFlagged = session.test_runs.some((tr) => tr.result === 'flagged');
  if (anyFail) return '<span class="badge fail">fail</span>';
  if (anyFlagged) return '<span class="badge flagged">flagged</span>';
  return '<span class="badge pass">done</span>';
}

async function loadSessions(params) {
  const body = document.getElementById('sessions-body');
  const errorBox = document.getElementById('error');
  errorBox.style.display = 'none';
  body.innerHTML = '<tr><td colspan="7" class="empty-state">Loading...</td></tr>';

  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v) qs.set(k, v);
  }

  try {
    const res = await fetch(`/api/sessions?${qs.toString()}`);
    if (!res.ok) throw new Error(`Server returned ${res.status}`);
    const sessions = await res.json();

    if (sessions.length === 0) {
      body.innerHTML = '<tr><td colspan="7" class="empty-state">No sessions found.</td></tr>';
      return;
    }

    body.innerHTML = sessions
      .map(
        (s) => `
        <tr class="session-row" data-id="${s.id}">
          <td>${fmtDateTime(s.started_at)}</td>
          <td>${s.mobo_serial}</td>
          <td>${s.customer_name || '<span class="muted">-</span>'}</td>
          <td>${s.session_type}</td>
          <td>${s.technician_name}</td>
          <td>${renderTestRuns(s.test_runs)}</td>
          <td>${sessionStatus(s)}</td>
        </tr>`
      )
      .join('');

    body.querySelectorAll('tr.session-row').forEach((row) => {
      row.addEventListener('click', () => {
        window.location.href = `/session.html?id=${row.dataset.id}`;
      });
    });
  } catch (err) {
    errorBox.textContent = `Failed to load sessions: ${err.message}`;
    errorBox.style.display = 'block';
    body.innerHTML = '<tr><td colspan="7" class="empty-state">-</td></tr>';
  }
}

const form = document.getElementById('filter-form');
form.addEventListener('submit', (e) => {
  e.preventDefault();
  const data = Object.fromEntries(new FormData(form).entries());
  loadSessions(data);
});

document.getElementById('clear-filters').addEventListener('click', () => {
  form.reset();
  loadSessions({});
});

loadSessions({});
