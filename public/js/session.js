'use strict';

// Session detail page: renders session metadata + one panel per test_run, each with a chart.
// Completed test_runs get a static chart built from GET /api/sessions/:id/telemetry (historical).
// Active (still-running) test_runs get a live chart fed by /ws/live?session_id=... (CONTRACT.md
// section 5), updated in place as "telemetry" messages arrive, no polling.
//
// Chart.js is used without its date adapter (not vendored, to avoid an extra dependency for an
// internal tool) -- the x-axis is plotted as "seconds elapsed since test_run start" on a plain
// linear scale rather than wall-clock time.

const SERIES_COLORS = ['#e5484d', '#3b82f6', '#22c55e', '#a855f7', '#f59e0b', '#14b8a6', '#94a3b8'];

// Chart.js's own defaults (tick/legend text, gridlines) are a fixed dark gray with no idea this
// page has a dark-mode stylesheet -- without this, every chart would render near-illegible
// dark-on-dark text once dark mode is toggled on. Read the same CSS custom properties the rest
// of the page already uses, rather than hardcoding a second color scheme here that could drift
// from style.css's. Chart.defaults only affects charts created *after* it's set though -- any
// already-rendered chart baked its colors in at construction time, so theme.js's
// window.onThemeChange hook below also rebuilds them from scratch on an actual toggle.
function applyChartTheme() {
  const styles = getComputedStyle(document.documentElement);
  const muted = styles.getPropertyValue('--muted').trim();
  const border = styles.getPropertyValue('--border').trim();
  if (window.Chart) {
    Chart.defaults.color = muted;
    Chart.defaults.borderColor = border;
    Chart.defaults.font.family = getComputedStyle(document.body).fontFamily;
  }
}
applyChartTheme();

const sessionId = new URLSearchParams(location.search).get('id');
document.getElementById('pdf-link').href = `/api/sessions/${sessionId}/report.pdf`;

/** test_run_id -> { chart: Chart, datasetIndexBySensor: Map, startedAtMs: number } */
const chartState = new Map();
let liveSocket = null;
let currentSession = null;

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

function resultBadgeHtml(testRun) {
  if (!testRun.ended_at) return '<span class="badge running">running</span>';
  const cls = testRun.result || 'unknown';
  return `<span class="badge ${cls}">${testRun.result || 'unknown'}</span>`;
}

async function fetchJson(url) {
  const res = await fetch(url);
  if (!res.ok) {
    let detail = '';
    try {
      detail = (await res.json()).message || '';
    } catch {
      /* ignore */
    }
    throw new Error(`${res.status} ${res.statusText}${detail ? ` -- ${detail}` : ''}`);
  }
  return res.json();
}

function renderSessionMeta(session) {
  const el = document.getElementById('session-meta');
  const ssd = (session.ssd_serials || []).join(', ') || '-';
  const other = Object.entries(session.other_serials || {})
    .map(([k, v]) => `${k}: ${v}`)
    .join(', ') || '-';
  el.innerHTML = `
    <h2>Session ${session.id}</h2>
    <dl>
      <dt>PC serial</dt><dd>${session.mobo_serial}</dd>
      <dt>Customer</dt><dd>${session.customer_name || '-'}</dd>
      <dt>Type</dt><dd>${session.session_type}</dd>
      <dt>Technician</dt><dd>${session.technician_name}</dd>
      <dt>Started</dt><dd>${fmtDateTime(session.started_at)}</dd>
      <dt>Ended</dt><dd>${session.ended_at ? fmtDateTime(session.ended_at) : '<span class="badge running">in progress</span>'}</dd>
      <dt>Notes</dt><dd>${session.notes || '-'}</dd>
      <dt>SSD serials</dt><dd>${ssd}</dd>
      <dt>Other serials</dt><dd>${other}</dd>
    </dl>
  `;
}

function statTiles(summaryStats) {
  if (!summaryStats || Object.keys(summaryStats).length === 0) {
    return '<p class="muted">No summary stats yet.</p>';
  }
  return `<div class="stats-grid">${Object.entries(summaryStats)
    .map(([k, v]) => `<div class="stat-tile"><div class="label">${k}</div><div class="value">${v}</div></div>`)
    .join('')}</div>`;
}

function destroyAllCharts() {
  for (const state of chartState.values()) {
    state.chart.destroy();
  }
  chartState.clear();
}

// Each sensor gets its own Y-axis rather than sharing one. CPU sensors span wildly different
// scales (temp in the 40s-90s C, load as a 0-100 pct, fan speed in the thousands of RPM) -- on a
// shared axis, fan RPM's magnitude flattens temp and load into an invisible line near zero. Only
// the first two axes are actually drawn (left/right, colored to match their series) to keep the
// chart from getting cluttered as more sensors are added later (GPU/RAM/SSD); axes beyond that
// stay hidden but still scale their series independently, and the real value is still available
// via the tooltip on hover regardless of axis visibility.
function scaleIdForSensor(sensorName) {
  return `y-${sensorName}`;
}

function buildScaleConfig(sensorName, index, color) {
  return {
    type: 'linear',
    position: index === 0 ? 'left' : 'right',
    display: index < 2,
    grid: { display: index === 0, drawOnChartArea: index === 0 },
    ticks: { color, font: { size: 9 } },
    title: { display: true, text: sensorName, color, font: { size: 9 } },
  };
}

function addSensorScale(chart, sensorName, index) {
  const color = SERIES_COLORS[index % SERIES_COLORS.length];
  chart.options.scales[scaleIdForSensor(sensorName)] = buildScaleConfig(sensorName, index, color);
  return color;
}

function buildChart(canvas, seriesMap) {
  const names = [...seriesMap.keys()];
  const scales = {
    x: { type: 'linear', title: { display: true, text: 'Elapsed time (s)' } },
  };
  const datasets = names.map((name, i) => {
    const color = SERIES_COLORS[i % SERIES_COLORS.length];
    scales[scaleIdForSensor(name)] = buildScaleConfig(name, i, color);
    return {
      label: name,
      data: seriesMap.get(name),
      yAxisID: scaleIdForSensor(name),
      borderColor: color,
      backgroundColor: 'transparent',
      borderWidth: 1.5,
      pointRadius: 0,
      tension: 0.15,
    };
  });

  return new Chart(canvas.getContext('2d'), {
    type: 'line',
    data: { datasets },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: false,
      parsing: false,
      interaction: { mode: 'nearest', intersect: false },
      plugins: { legend: { position: 'bottom', labels: { boxWidth: 10, font: { size: 10 } } } },
      scales,
    },
  });
}

// One button for the whole session (not one per test-run panel). Calls POST /api/sessions/:id/end
// (CONTRACT.md §4) rather than looping over the per-test-run .../stop endpoint: a session can be
// stuck "in progress" two different ways -- (a) a test_run is still running because its owning
// client vanished, or (b) every test_run already finished normally but the client itself crashed
// before calling its own end-session PATCH, leaving zero running test_runs but the session still
// open. Looping over .../stop only ever covers (a), since it has nothing to act on in (b) -- the
// dedicated .../end endpoint handles both in one call by unconditionally closing the session
// (and anything still open in it) rather than only reacting to what's currently running.
async function stopSession() {
  if (!currentSession || currentSession.ended_at) return;

  const runningRuns = currentSession.test_runs.filter((tr) => !tr.ended_at);
  const message = runningRuns.length > 0
    ? `Stop the running ${runningRuns.map((tr) => tr.component.toUpperCase()).join(' + ')} test(s) ` +
      `and end this session? This marks them as aborted and cannot be undone. Only do this if the ` +
      `PC running them looks stuck or unreachable.`
    : `End this session? It has no running tests, but was never marked as ended -- this just closes ` +
      `it out (e.g. the client likely crashed right after finishing, before it could do that itself).`;
  if (!confirm(message)) return;

  try {
    const res = await fetch(`/api/sessions/${sessionId}/end`, { method: 'POST' });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.message || `${res.status} ${res.statusText}`);
    }
    await loadSession();
  } catch (err) {
    showError(`Failed to end session: ${err.message}`);
  }
}

function updateStopSessionButton(session) {
  const btn = document.getElementById('stop-session-btn');
  if (!btn) return;
  btn.style.display = session.ended_at ? 'none' : '';
  const anyRunning = (session.test_runs || []).some((tr) => !tr.ended_at);
  btn.textContent = anyRunning ? 'Stop running test(s)' : 'End session';
}

function renderTestRunPanel(testRun, historicalTelemetry) {
  const panel = document.createElement('div');
  panel.className = 'test-run';
  panel.dataset.testRunId = testRun.id;
  panel.innerHTML = `
    <div class="test-run-header">
      <h3>${testRun.component}</h3>
      ${resultBadgeHtml(testRun)}
    </div>
    <div class="muted" style="font-size:13px; margin-bottom:6px;">
      Started ${fmtDateTime(testRun.started_at)}${testRun.ended_at ? ` &middot; Ended ${fmtDateTime(testRun.ended_at)}` : ''}
      ${testRun.stop_reason ? ` &middot; Stopped: ${testRun.stop_reason}` : ''}
    </div>
    <div class="chart-wrap"><canvas></canvas></div>
    <div class="stats-container">${statTiles(testRun.summary_stats)}</div>
  `;

  const canvas = panel.querySelector('canvas');
  const startedAtMs = new Date(testRun.started_at).getTime();

  const seriesMap = new Map();
  for (const point of historicalTelemetry) {
    const elapsed = (new Date(point.ts).getTime() - startedAtMs) / 1000;
    if (!seriesMap.has(point.sensor_name)) seriesMap.set(point.sensor_name, []);
    seriesMap.get(point.sensor_name).push({ x: elapsed, y: point.value });
  }
  for (const points of seriesMap.values()) points.sort((a, b) => a.x - b.x);

  const chart = buildChart(canvas, seriesMap);
  chartState.set(testRun.id, { chart, seriesMap, startedAtMs, isActive: !testRun.ended_at });

  return panel;
}

async function renderAllTestRuns(session) {
  const container = document.getElementById('test-runs');
  container.innerHTML = '';
  destroyAllCharts();

  if (!session.test_runs || session.test_runs.length === 0) {
    container.innerHTML = '<div class="panel empty-state">No test runs in this session yet.</div>';
    return;
  }

  for (const testRun of session.test_runs) {
    let telemetry = [];
    try {
      telemetry = await fetchJson(`/api/sessions/${sessionId}/telemetry?test_run_id=${testRun.id}`);
    } catch (err) {
      console.error(`Failed to load telemetry for test_run ${testRun.id}:`, err);
    }
    const panelWrap = document.createElement('div');
    panelWrap.className = 'panel';
    panelWrap.appendChild(renderTestRunPanel(testRun, telemetry));
    container.appendChild(panelWrap);
  }
}

// Guards against overlapping calls stepping on each other. renderAllTestRuns() clears #test-runs
// and rebuilds it asynchronously (it awaits a telemetry fetch per panel) -- if two calls to
// loadSession() overlap, the second one's clear can land after the first has already started
// re-appending panels, leaving duplicates. This is easy to hit in practice: e.g. clicking the new
// Stop button (below) triggers a direct reload AND a /ws/live "test_run_status" push arrives back
// at the same tab a moment later triggering another. Coalescing into one in-flight call at a time
// fixes it for every caller, not just this one.
let loadSessionPromise = null;
function loadSession() {
  if (loadSessionPromise) return loadSessionPromise;
  loadSessionPromise = (async () => {
    clearError();
    try {
      const session = await fetchJson(`/api/sessions/${sessionId}`);
      currentSession = session;
      renderSessionMeta(session);
      updateStopSessionButton(session);
      await renderAllTestRuns(session);
    } catch (err) {
      showError(`Failed to load session: ${err.message}`);
    } finally {
      loadSessionPromise = null;
    }
  })();
  return loadSessionPromise;
}

function handleLiveMessage(msg) {
  if (msg.type === 'telemetry') {
    const state = chartState.get(msg.test_run_id);
    if (!state || !state.isActive) return; // not an active run we're charting live
    const elapsed = (new Date(msg.ts).getTime() - state.startedAtMs) / 1000;
    if (!state.seriesMap.has(msg.sensor_name)) {
      const idx = state.seriesMap.size;
      state.seriesMap.set(msg.sensor_name, []);
      const color = addSensorScale(state.chart, msg.sensor_name, idx);
      state.chart.data.datasets.push({
        label: msg.sensor_name,
        data: state.seriesMap.get(msg.sensor_name),
        yAxisID: scaleIdForSensor(msg.sensor_name),
        borderColor: color,
        backgroundColor: 'transparent',
        borderWidth: 1.5,
        pointRadius: 0,
        tension: 0.15,
      });
    }
    state.seriesMap.get(msg.sensor_name).push({ x: elapsed, y: msg.value });
    state.chart.update('none');
  } else if (msg.type === 'test_run_status') {
    // A test_run started, or finished -- re-fetch the full session so the panel list, badges,
    // and summary stats reflect the latest DB state. This also covers "cpu+gpu together" mode
    // starting a second panel mid-session.
    loadSession();
  }
}

function connectLive() {
  if (liveSocket) {
    liveSocket.close();
  }
  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  liveSocket = new WebSocket(`${protocol}//${location.host}/ws/live?session_id=${sessionId}`);
  liveSocket.addEventListener('message', (event) => {
    try {
      handleLiveMessage(JSON.parse(event.data));
    } catch (err) {
      console.error('Bad /ws/live message', err);
    }
  });
  liveSocket.addEventListener('close', () => {
    // Reconnect after a short delay unless the page is being torn down.
    setTimeout(() => {
      if (document.visibilityState !== 'hidden') connectLive();
    }, 3000);
  });
  liveSocket.addEventListener('error', () => {
    liveSocket.close();
  });
}

document.getElementById('refresh-btn').addEventListener('click', loadSession);
document.getElementById('stop-session-btn').addEventListener('click', stopSession);

// theme.js calls this on an actual toggle-button click (not on page load). Rebuilding from
// loadSession() rather than hand-patching each existing Chart.js instance's already-baked-in
// colors is deliberately the simple option here -- telemetry is persisted server-side as it
// streams in, so a fresh fetch loses nothing even for a still-running test_run, and it reuses
// machinery that already exists (destroyAllCharts + renderAllTestRuns) instead of adding a
// second, more fragile code path just for re-theming.
window.onThemeChange = () => {
  applyChartTheme();
  if (currentSession) loadSession();
};

loadSession();
connectLive();
