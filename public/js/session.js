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

// Live readout: current-value tiles under the chart, so reading "what's the temp/load/frequency
// right now" doesn't require hovering the chart with a mouse -- glanceable, and works on
// touch/mobile where hover doesn't really exist at all. Generic over whatever sensors a test_run
// actually has (not hardcoded to specific CPU sensor names) so it keeps working unchanged once
// GPU/RAM/SSD start sending their own telemetry. Color-matched to each series' chart line (same
// SERIES_COLORS index) so a tile and its line are visually tied together at a glance.
function formatSensorValue(v) {
  if (typeof v !== 'number') return String(v);
  return Number.isInteger(v) ? String(v) : v.toFixed(1);
}

function liveReadoutTileHtml(sensorName, value, index) {
  const color = SERIES_COLORS[index % SERIES_COLORS.length];
  return `<div class="stat-tile" style="border-left: 3px solid ${color}">
    <div class="label">${sensorName}</div>
    <div class="value live-readout-value" data-readout-sensor="${sensorName}">${formatSensorValue(value)}</div>
  </div>`;
}

function buildLiveReadout(seriesMap) {
  const names = [...seriesMap.keys()];
  if (names.length === 0) return '<p class="muted">No sensor data yet.</p>';
  const tiles = names
    .map((name, i) => {
      const points = seriesMap.get(name);
      const last = points.length ? points[points.length - 1].y : null;
      return liveReadoutTileHtml(name, last, i);
    })
    .join('');
  return `<div class="stats-grid live-readout">${tiles}</div>`;
}

/** Updates one sensor's tile in place, or adds a new tile if this sensor wasn't seen before
 * (mirrors how a new sensor mid-stream also gets a new chart axis in handleLiveMessage). */
function updateReadoutTile(readoutEl, sensorName, value, index) {
  if (!readoutEl) return;
  const valueEl = readoutEl.querySelector(`[data-readout-sensor="${sensorName}"]`);
  if (valueEl) {
    valueEl.textContent = formatSensorValue(value);
    return;
  }
  const grid = readoutEl.querySelector('.stats-grid');
  const tileHtml = liveReadoutTileHtml(sensorName, value, index);
  if (grid) {
    grid.insertAdjacentHTML('beforeend', tileHtml);
  } else {
    readoutEl.innerHTML = `<div class="stats-grid live-readout">${tileHtml}</div>`;
  }
}

// Friendlier label/unit for specific summary_stats keys -- everything else still renders as the
// raw key (uppercased via .label's CSS) with no unit. Requested directly by the client side
// (NOTE_FROM_CLIENT_SSD_BENCHMARK.md) after a real technician found "MIN_SEQ_READ_MB_S / 3131.72"
// hard to read at a glance on a real SSD benchmark run. Deliberately small and manual, not a
// general "pretty units for every stat" system -- just the two keys actually read at a glance to
// judge a benchmark. Keep in sync by hand with the identical map in src/lib/pdf.js -- no shared
// module between a browser script and server-side Node code without a build step, which this
// project deliberately doesn't have.
const STAT_DISPLAY = {
  min_seq_read_mb_s: { label: 'Sequential Read', unit: ' MB/s' },
  min_seq_write_mb_s: { label: 'Sequential Write', unit: ' MB/s' },
};

function statTiles(summaryStats) {
  if (!summaryStats || Object.keys(summaryStats).length === 0) {
    return '<p class="muted">No summary stats yet.</p>';
  }
  return `<div class="stats-grid">${Object.entries(summaryStats)
    .map(([k, v]) => {
      const display = STAT_DISPLAY[k];
      const label = display ? display.label : k;
      const value = display ? `${v}${display.unit}` : v;
      return `<div class="stat-tile"><div class="label">${label}</div><div class="value">${value}</div></div>`;
    })
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

// Fallback for a test_run with a completed benchmark result but zero streamed telemetry -- the
// SSD DiskSpd benchmark (NOTE_FROM_CLIENT_SSD_BENCHMARK.md) is the current example: it produces
// two single final MB/s numbers per pass (~20s each), not a continuous stream of readings like
// Prime95's temp/load, so there's genuinely no time-series data for buildChart() to plot -- an
// empty line chart with "No sensor data yet." isn't a bug, it's an accurate reflection of what
// was sent, but it's also not useful. This renders a small horizontal bar instead, using numbers
// already in summary_stats, so a completed benchmark still gets *some* visual rather than nothing.
// Keyed on the same two keys as STAT_DISPLAY above rather than on component === 'ssd', so this
// isn't SSD-specific by name -- if a future benchmark-style component populates the same
// min_seq_read_mb_s/min_seq_write_mb_s shape, this picks it up automatically. If a component ever
// starts streaming real interval telemetry instead (the natural next step for DiskSpd, since it
// does support periodic reporting), buildChart() takes over again on its own -- this fallback
// only applies when the telemetry series is empty.
function buildThroughputBarChart(canvas, summaryStats) {
  const labels = [];
  const values = [];
  const colors = [];
  if (typeof summaryStats.min_seq_read_mb_s === 'number') {
    labels.push('Sequential Read');
    values.push(summaryStats.min_seq_read_mb_s);
    colors.push(SERIES_COLORS[0]);
  }
  if (typeof summaryStats.min_seq_write_mb_s === 'number') {
    labels.push('Sequential Write');
    values.push(summaryStats.min_seq_write_mb_s);
    colors.push(SERIES_COLORS[1]);
  }

  return new Chart(canvas.getContext('2d'), {
    type: 'bar',
    data: { labels, datasets: [{ data: values, backgroundColor: colors, borderRadius: 4, maxBarThickness: 40 }] },
    options: {
      indexAxis: 'y',
      responsive: true,
      maintainAspectRatio: false,
      animation: false,
      plugins: {
        legend: { display: false },
        tooltip: { callbacks: { label: (ctx) => `${ctx.parsed.x} MB/s` } },
      },
      scales: {
        x: { title: { display: true, text: 'MB/s' }, beginAtZero: true },
      },
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
    <div class="readout-container"></div>
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

  const stats = testRun.summary_stats;
  const hasThroughputResult = stats && (
    typeof stats.min_seq_read_mb_s === 'number' || typeof stats.min_seq_write_mb_s === 'number'
  );
  const useThroughputFallback = seriesMap.size === 0 && hasThroughputResult;

  const chart = useThroughputFallback
    ? buildThroughputBarChart(canvas, stats)
    : buildChart(canvas, seriesMap);

  const readoutEl = panel.querySelector('.readout-container');
  // Skip the live-readout area entirely when the bar-chart fallback is showing: it would only
  // ever say "No sensor data yet." right below a chart that's visibly showing data, which reads
  // as a contradiction -- the same numbers are already in both the bar chart and the stat tiles
  // below, so there's nothing this row would add here.
  if (!useThroughputFallback) {
    readoutEl.innerHTML = buildLiveReadout(seriesMap);
  }
  chartState.set(testRun.id, { chart, seriesMap, startedAtMs, isActive: !testRun.ended_at, readoutEl });

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
    const isNewSensor = !state.seriesMap.has(msg.sensor_name);
    if (isNewSensor) {
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
    updateReadoutTile(state.readoutEl, msg.sensor_name, msg.value, state.seriesMap.size - 1);
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
