'use strict';

// PDF report generation (CONTRACT.md section 4 GET /api/sessions/:id/report.pdf; PROJECT_PLAN.md
// section 5: "charts (temp/load over time) + summary tables, styled similarly to your existing
// GPU-bench reports").
//
// Uses pdfkit with hand-drawn vector line charts rather than a headless-browser/HTML-to-PDF
// approach (e.g. Puppeteer) -- pdfkit is a pure-JS dependency with no bundled browser download,
// which keeps this deployable on the LAN box without extra runtime downloads. Chart quality is
// "internal tool" level (per the task's framing), not pixel-identical to the live dashboard's
// Chart.js rendering.

const PDFDocument = require('pdfkit');

const PAGE_MARGIN = 40;
const CHART_HEIGHT = 160;
const SERIES_COLORS = ['#c0392b', '#2980b9', '#27ae60', '#8e44ad', '#d35400', '#16a085'];

// Friendlier label/unit for specific summary_stats keys -- everything else still renders as the
// raw key with no unit (see summaryRows below). Requested directly by the client side
// (NOTE_FROM_CLIENT_SSD_BENCHMARK.md) after a real technician found "MIN_SEQ_READ_MB_S / 3131.72"
// hard to read at a glance on a real SSD benchmark run. Deliberately small and manual, not a
// general "pretty units for every stat" system -- just the two keys actually read at a glance to
// judge a benchmark. No shared module with public/js/session.js's identical map: this file runs
// server-side (Node), that one runs in the browser with no build step, so there's no way to
// import one from the other -- keep the two in sync by hand if this list grows.
const STAT_DISPLAY = {
  min_seq_read_mb_s: { label: 'Sequential Read', unit: ' MB/s' },
  min_seq_write_mb_s: { label: 'Sequential Write', unit: ' MB/s' },
};

function fmtDate(d) {
  if (!d) return '-';
  return new Date(d).toLocaleString();
}

function fmtDuration(startedAt, endedAt) {
  if (!startedAt || !endedAt) return '-';
  const ms = new Date(endedAt) - new Date(startedAt);
  if (ms < 0) return '-';
  const totalSec = Math.round(ms / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  return `${h}h ${m}m ${s}s`;
}

/**
 * Draws a simple multi-series line chart of telemetry (grouped by sensor_name) inside the box
 * (x, y, width, height). Downsamples each series to at most ~400 points so very long runs don't
 * produce enormous vector paths.
 */
function drawTelemetryChart(doc, telemetry, x, y, width, height, title, summaryStats) {
  doc.save();
  doc.font('Helvetica-Bold').fontSize(10).fillColor('#000').text(title, x, y);
  const chartTop = y + 16;
  const chartHeight = height - 16;

  if (!telemetry || telemetry.length === 0) {
    // A completed benchmark-style test_run (SSD's DiskSpd, NOTE_FROM_CLIENT_SSD_BENCHMARK.md) has
    // no time-series telemetry at all -- it reports two single final MB/s numbers, not a stream of
    // readings -- so "no telemetry" isn't a bug, it's accurate. Draw those two numbers as bars
    // instead of just saying nothing was recorded, mirroring the dashboard's same fallback
    // (public/js/session.js's buildThroughputBarChart). Same trigger (these two specific keys, not
    // component === 'ssd') so this also picks up automatically if another benchmark-style test
    // reuses the same summary_stats shape later.
    const read = summaryStats && summaryStats.min_seq_read_mb_s;
    const write = summaryStats && summaryStats.min_seq_write_mb_s;
    if (typeof read === 'number' || typeof write === 'number') {
      drawThroughputBars(doc, { read, write }, x, chartTop, width, chartHeight);
      doc.restore();
      return;
    }
    doc
      .font('Helvetica')
      .fontSize(9)
      .fillColor('#888')
      .text('No telemetry recorded.', x, chartTop + chartHeight / 2 - 5);
    doc.restore();
    return;
  }

  const bySensor = new Map();
  for (const point of telemetry) {
    if (!bySensor.has(point.sensor_name)) bySensor.set(point.sensor_name, []);
    bySensor.get(point.sensor_name).push(point);
  }

  const allTs = telemetry.map((p) => new Date(p.ts).getTime());
  const minTs = Math.min(...allTs);
  const maxTs = Math.max(...allTs);

  const plotX = x + 4;
  const plotWidth = width - 8;
  const plotY = chartTop;
  // Legend is one row per series (see below) rather than one wrapped line -- the chart column is
  // narrow (it shares the page with the summary table) and each row now carries a value range
  // annotation, so a single-line legend would overflow the column width. Reserve height for it
  // up front based on how many series there are.
  const legendRowHeight = 9;
  const legendHeight = Math.max(14, bySensor.size * legendRowHeight + 4);
  const plotHeight = chartHeight - legendHeight;

  // Axes
  doc
    .strokeColor('#ccc')
    .lineWidth(0.5)
    .moveTo(plotX, plotY)
    .lineTo(plotX, plotY + plotHeight)
    .lineTo(plotX + plotWidth, plotY + plotHeight)
    .stroke();

  const tsToX = (ts) =>
    maxTs === minTs ? plotX : plotX + ((ts - minTs) / (maxTs - minTs)) * plotWidth;

  // Each sensor gets its own value range, normalized independently to the same plot height.
  // Sensors on this system have wildly different scales (a CPU temp in the 40s-90s C, load as a
  // 0-100 pct, fan speed in the thousands of RPM) -- sharing one axis across all of them makes the
  // smaller-magnitude series flatten to an invisible line at the bottom. Since this is a vector
  // chart with no rendered per-axis tick labels (unlike the live dashboard's Chart.js chart), the
  // legend below carries each series' actual observed min-max range so the normalization doesn't
  // lose that information.
  let colorIdx = 0;
  const legendItems = [];
  for (const [sensorName, points] of bySensor) {
    const color = SERIES_COLORS[colorIdx % SERIES_COLORS.length];
    colorIdx += 1;

    const sorted = [...points].sort((a, b) => new Date(a.ts) - new Date(b.ts));
    const step = Math.max(1, Math.floor(sorted.length / 400));
    const sampled = sorted.filter((_, i) => i % step === 0);

    const seriesValues = sampled.map((p) => p.value);
    const seriesMin = Math.min(0, Math.min(...seriesValues));
    const seriesMax = Math.max(...seriesValues) * 1.05 || 1;
    legendItems.push({
      sensorName,
      color,
      range: `${Math.min(...seriesValues).toFixed(1)}-${Math.max(...seriesValues).toFixed(1)}`,
    });

    const valToY = (v) =>
      seriesMax === seriesMin
        ? plotY + plotHeight
        : plotY + plotHeight - ((v - seriesMin) / (seriesMax - seriesMin)) * plotHeight;

    doc.strokeColor(color).lineWidth(1);
    sampled.forEach((p, i) => {
      const px = tsToX(new Date(p.ts).getTime());
      const py = valToY(p.value);
      if (i === 0) doc.moveTo(px, py);
      else doc.lineTo(px, py);
    });
    doc.stroke();
  }

  // Legend: one row per series (not flowed horizontally) -- each entry is annotated with that
  // series' own value range, since the plot normalizes every series independently rather than
  // sharing one axis (see comment above), and this column is too narrow for that plus 2-3 sensor
  // names to fit on a single line without pdfkit's auto-wrap mangling it character-by-character.
  let legendY = plotY + plotHeight + 4;
  doc.fontSize(7).font('Helvetica');
  for (const item of legendItems) {
    const label = `${item.sensorName} (${item.range})`;
    doc.rect(plotX, legendY + 1, 6, 6).fill(item.color);
    doc.fillColor('#333').text(label, plotX + 9, legendY, { width: plotWidth - 9, continued: false });
    legendY += legendRowHeight;
  }

  doc.restore();
}

/** Two horizontal bars (read/write MB/s) for a completed benchmark test_run with no time-series
 * telemetry -- see drawTelemetryChart's comment for why this exists. `values` may have only one
 * of read/write set (a pass stopped early) -- that bar is simply skipped. */
function drawThroughputBars(doc, values, x, y, width, height) {
  const bars = [
    { label: 'Sequential Read', value: values.read, color: SERIES_COLORS[0] },
    { label: 'Sequential Write', value: values.write, color: SERIES_COLORS[1] },
  ].filter((b) => typeof b.value === 'number');

  const maxVal = Math.max(...bars.map((b) => b.value)) * 1.05 || 1;
  const rowHeight = 22;
  const barHeight = 10;
  const labelWidth = 90;
  const barMaxWidth = width - labelWidth - 55; // leaves room for the "N MB/s" figure after the bar

  let curY = y + (height - bars.length * rowHeight) / 2;
  for (const bar of bars) {
    doc.font('Helvetica').fontSize(8).fillColor('#333').text(bar.label, x, curY + 1, { width: labelWidth });

    const barWidth = Math.max(2, (bar.value / maxVal) * barMaxWidth);
    doc.rect(x + labelWidth, curY, barWidth, barHeight).fill(bar.color);

    doc
      .font('Helvetica-Bold')
      .fontSize(8)
      .fillColor('#000')
      .text(`${bar.value} MB/s`, x + labelWidth + barMaxWidth + 6, curY + 1);

    curY += rowHeight;
  }
}

function drawSummaryTable(doc, x, y, width, rows) {
  const rowHeight = 14;
  doc.font('Helvetica').fontSize(8);
  let curY = y;
  for (const [label, value] of rows) {
    doc.fillColor('#555').text(label, x, curY, { width: width * 0.4 });
    doc.fillColor('#000').text(String(value), x + width * 0.4, curY, { width: width * 0.6 });
    curY += rowHeight;
  }
  return curY;
}

function resultLabel(run) {
  if (!run.result) return run.ended_at ? 'unknown' : 'in progress';
  return run.result;
}

/**
 * @returns {import('pdfkit')} a PDFDocument already streaming -- caller pipes it to the response.
 */
function generateSessionReportPdf({ session, testRuns, telemetryByRun }) {
  const doc = new PDFDocument({ margin: PAGE_MARGIN, size: 'A4', bufferPages: true });

  doc.font('Helvetica-Bold').fontSize(18).text('Luxtronic PCTools -- Session Report', {
    align: 'left',
  });
  doc.moveDown(0.5);

  doc.font('Helvetica').fontSize(10).fillColor('#000');
  const infoRows = [
    ['Session ID', session.id],
    ['PC (mobo serial)', session.mobo_serial],
    ['Customer', session.customer_name || '-'],
    ['Session type', session.session_type],
    ['Technician', session.technician_name],
    ['Started', fmtDate(session.started_at)],
    ['Ended', fmtDate(session.ended_at)],
    ['Notes', session.notes || '-'],
    ['SSD serials', (session.ssd_serials || []).join(', ') || '-'],
    [
      'Other serials',
      Object.entries(session.other_serials || {})
        .map(([k, v]) => `${k}: ${v}`)
        .join(', ') || '-',
    ],
  ];
  for (const [label, value] of infoRows) {
    doc.font('Helvetica-Bold').text(`${label}: `, { continued: true }).font('Helvetica').text(String(value));
  }

  doc.moveDown(1);

  if (testRuns.length === 0) {
    doc.font('Helvetica-Oblique').fontSize(10).fillColor('#888').text('No test runs recorded in this session.');
  }

  for (const run of testRuns) {
    if (doc.y > doc.page.height - PAGE_MARGIN - 260) {
      doc.addPage();
    }

    doc.moveDown(0.5);
    doc
      .font('Helvetica-Bold')
      .fontSize(13)
      .fillColor('#000')
      .text(`${run.component.toUpperCase()} test run`);

    const summaryStats = run.summary_stats || {};
    const summaryRows = [
      ['Result', resultLabel(run)],
      ['Started', fmtDate(run.started_at)],
      ['Ended', fmtDate(run.ended_at)],
      ['Duration', fmtDuration(run.started_at, run.ended_at)],
      ['Stop reason', run.stop_reason || '-'],
      ['Tool exit code', run.tool_exit_code ?? '-'],
      ...Object.entries(summaryStats).map(([k, v]) => {
        const display = STAT_DISPLAY[k];
        return display ? [display.label, `${v}${display.unit}`] : [k, v];
      }),
    ];

    const startY = doc.y + 4;
    drawSummaryTable(doc, PAGE_MARGIN, startY, 260, summaryRows);
    drawTelemetryChart(
      doc,
      telemetryByRun[run.id],
      PAGE_MARGIN + 270,
      startY,
      doc.page.width - PAGE_MARGIN * 2 - 270,
      CHART_HEIGHT,
      'Telemetry over time',
      summaryStats
    );

    doc.y = startY + Math.max(summaryRows.length * 14, CHART_HEIGHT) + 12;
  }

  doc.end();
  return doc;
}

module.exports = { generateSessionReportPdf };
