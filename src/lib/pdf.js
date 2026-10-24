'use strict';

// PDF report generation (CONTRACT.md section 4 GET /api/sessions/:id/report.pdf; PROJECT_PLAN.md
// section 5: "charts (temp/load over time) + summary tables").
//
// Uses pdfkit with hand-drawn vector line charts rather than a headless-browser/HTML-to-PDF
// approach (e.g. Puppeteer) -- pdfkit is a pure-JS dependency with no bundled browser download,
// which keeps this deployable on the LAN box without extra runtime downloads.
//
// The report is meant to be read by the customer as well as the technician, so it is laid out like
// a proper document: a branded header band, an overall verdict with headline figures, a results
// summary table (each result next to its pass limit), the machine's specification, then one detail
// card per test with a chart. Colours follow LUXTRONIC-DESIGN-GUIDELINES.md (amber brand, cream
// cards, the same pass/fail/flagged pastel pairs as the dashboard badges).

const fs = require('fs');
const path = require('path');
const PDFDocument = require('pdfkit');
const { describeSystemInfo } = require('./systemInfo');

const PAGE_MARGIN = 40;
const FOOTER_SPACE = 30;
const CONTINUATION_TOP = 62; // content start on pages after the first (below the running header)
const SERIES_COLORS = ['#c0392b', '#2980b9', '#27ae60', '#8e44ad', '#d35400', '#16a085'];

const BRAND = '#dda84b';
const BRAND_DARK = '#b8860b';
const TEXT = '#222222';
const MUTED = '#666666';
const BORDER = '#e8e2d2';
const CARD_BG = '#faf8f2';

// pastel background + saturated text pairs, same as the dashboard badges
const STATUS = {
  pass: { bg: '#e8f5e9', fg: '#388e3c' },
  fail: { bg: '#ffebee', fg: '#d32f2f' },
  flagged: { bg: '#fff8e1', fg: '#e69500' },
  aborted: { bg: '#eceff1', fg: '#607d8b' },
  running: { bg: '#e3f2fd', fg: '#1976d2' },
  unknown: { bg: '#eceff1', fg: '#607d8b' },
};

const LOGO_PATH = path.join(__dirname, '..', '..', 'public', 'img', 'logo.png');

// Friendlier label/unit for summary_stats keys; anything not listed falls back to the raw key.
// (No shared module with public/js/session.js: that runs in the browser with no build step.)
const STAT_LABELS = {
  max_temp_c: ['Peak temperature', ' °C'],
  error_count: ['Errors found', ''],
  avg_load_pct: ['Average load', ' %'],
  min_seq_read_mb_s: ['Sequential read', ' MB/s'],
  min_seq_write_mb_s: ['Sequential write', ' MB/s'],
  max_smart_temp_c: ['Drive temperature', ' °C'],
  max_smart_reallocated_sectors: ['Reallocated sectors', ''],
  max_smart_percentage_used: ['Wear used', ' %'],
  min_smart_available_spare_percent: ['Available spare', ' %'],
  max_smart_media_errors: ['Media errors', ''],
};

// name, what it is, tool shown to the reader (the server config's "tool" can be stale, so it is
// not used here)
const COMPONENTS = {
  cpu: ['CPU', 'Processor stress test', 'Prime95'],
  gpu: ['GPU', 'Graphics stress test', 'FurMark'],
  vram: ['VRAM', 'Video memory test', 'memtest_vulkan'],
  ram: ['RAM', 'System memory test', 'TestMem5'],
  ssd: ['SSD', 'Drive speed and health', 'DiskSpd'],
};

// ---------------------------------------------------------------- formatting

function fmtDate(d) {
  if (!d) return '-';
  const date = new Date(d);
  try {
    return date.toLocaleString('en-AU', { day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit' });
  } catch (e) {
    return date.toLocaleString();
  }
}

function fmtDuration(startedAt, endedAt) {
  if (!startedAt || !endedAt) return '-';
  const ms = new Date(endedAt) - new Date(startedAt);
  if (ms < 0) return '-';
  return fmtSeconds(Math.round(ms / 1000));
}

function fmtSeconds(totalSec) {
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

function fmtValue(v) {
  if (typeof v === 'number') return Number.isInteger(v) ? v.toLocaleString('en-US') : v.toLocaleString('en-US', { maximumFractionDigits: 1 });
  return String(v);
}

function resultKey(run) {
  if (!run.ended_at) return 'running';
  return run.result || 'unknown';
}

function resultLabel(run) {
  if (!run.ended_at) return 'in progress';
  return run.result || 'unknown';
}

/** "cpu_package_temp_c" -> { label: "cpu package temp", unit: " °C" } */
function prettySensor(name) {
  const units = [
    ['_c', ' °C'],
    ['_pct', ' %'],
    ['_rpm', ' RPM'],
    ['_mhz', ' MHz'],
    ['_mb_s', ' MB/s'],
    ['_w', ' W'],
    ['_mb', ' MB'],
  ];
  for (const [suffix, unit] of units) {
    if (name.endsWith(suffix)) return { label: name.slice(0, -suffix.length).replace(/_/g, ' '), unit };
  }
  return { label: name.replace(/_/g, ' '), unit: '' };
}

/** Run settings the client reported (duration / mode / ...), as one readable phrase. */
function runSettingsText(snapshot) {
  if (!snapshot) return '';
  const parts = [];
  if (typeof snapshot.duration_minutes === 'number') parts.push(`${snapshot.duration_minutes} min test`);
  if (snapshot.mode) parts.push(`${snapshot.mode} mode`);
  if (snapshot.avx_disabled === true) parts.push('AVX off');
  if (typeof snapshot.device_index === 'number') parts.push(`GPU #${snapshot.device_index}`);
  return parts.join(', ');
}

/** The pass limit the server judged a stat against (it is kept in the run's config snapshot). */
function limitText(key, snapshot) {
  const limit = snapshot && snapshot[key];
  if (typeof limit !== 'number') return '';
  const unit = (STAT_LABELS[key] || [])[1] || '';
  if (key.startsWith('max_')) return `max ${fmtValue(limit)}${unit}`;
  if (key.startsWith('min_')) return `min ${fmtValue(limit)}${unit}`;
  return '';
}

// ---------------------------------------------------------------- primitives

function pillWidth(doc, text) {
  doc.font('Helvetica-Bold').fontSize(7.5);
  return doc.widthOfString(text.toUpperCase()) + 16;
}

/** Pastel status pill with its left edge at x. */
function drawPill(doc, text, status, x, y) {
  const colors = STATUS[status] || STATUS.unknown;
  const w = pillWidth(doc, text);
  doc.roundedRect(x, y, w, 14, 7).fill(colors.bg);
  doc.fillColor(colors.fg).text(text.toUpperCase(), x, y + 3.8, { width: w, align: 'center', lineBreak: false });
  return w;
}

function ensureSpace(doc, height) {
  if (doc.y + height > doc.page.height - PAGE_MARGIN - FOOTER_SPACE) {
    doc.addPage();
    doc.y = CONTINUATION_TOP;
  }
}

function sectionHeading(doc, text) {
  doc.font('Helvetica-Bold').fontSize(13).fillColor(TEXT).text(text, PAGE_MARGIN, doc.y, { lineBreak: false });
  const lineY = doc.y + 17;
  doc.moveTo(PAGE_MARGIN, lineY).lineTo(PAGE_MARGIN + 36, lineY).lineWidth(2).strokeColor(BRAND).stroke();
  doc.lineWidth(0.7);
  doc.y = lineY + 9;
}

// ---------------------------------------------------------------- charts

const PLOT_HEIGHT = 78;
const LEGEND_ROW = 9;

function chartHeightFor(telemetry, summaryStats) {
  if (telemetry && telemetry.length > 0) {
    const sensors = new Set(telemetry.map((p) => p.sensor_name));
    return 16 + PLOT_HEIGHT + 14 + sensors.size * LEGEND_ROW + 4;
  }
  const hasBars = summaryStats && (typeof summaryStats.min_seq_read_mb_s === 'number' || typeof summaryStats.min_seq_write_mb_s === 'number');
  return hasBars ? 90 : 60;
}

/**
 * Multi-series line chart of telemetry inside the box (x, y, width): framed plot with light grid,
 * elapsed-time labels, and a legend row per series carrying that series' own value range. Every
 * series is normalised to the same plot height on its own scale (a temperature in the 40s-90s, a
 * load in 0-100 %, a fan in the thousands of RPM would otherwise flatten each other), so the
 * legend's range is what keeps the real values readable. Downsampled to ~400 points per series.
 */
function drawTelemetryChart(doc, telemetry, x, y, width, summaryStats) {
  doc.save();
  const hasBars = !(telemetry && telemetry.length > 0) && summaryStats &&
    (typeof summaryStats.min_seq_read_mb_s === 'number' || typeof summaryStats.min_seq_write_mb_s === 'number');
  doc.font('Helvetica-Bold').fontSize(8).fillColor(MUTED).text(hasBars ? 'DRIVE SPEED' : 'TELEMETRY OVER TIME', x, y, { lineBreak: false, characterSpacing: 0.6 });
  const plotY = y + 16;

  if (!telemetry || telemetry.length === 0) {
    // Benchmark-style runs (SSD speed test) may have no time series -- just two final numbers.
    const read = summaryStats && summaryStats.min_seq_read_mb_s;
    const write = summaryStats && summaryStats.min_seq_write_mb_s;
    if (typeof read === 'number' || typeof write === 'number') {
      drawThroughputBars(doc, { read, write }, x, plotY, width);
    } else {
      doc.font('Helvetica-Oblique').fontSize(9).fillColor('#999').text('No telemetry recorded.', x, plotY + 14, { lineBreak: false });
    }
    doc.restore();
    return;
  }

  const bySensor = new Map();
  for (const point of telemetry) {
    if (!bySensor.has(point.sensor_name)) bySensor.set(point.sensor_name, []);
    bySensor.get(point.sensor_name).push(point);
  }

  let minTs = Infinity;
  let maxTs = -Infinity;
  for (const p of telemetry) {
    const t = new Date(p.ts).getTime();
    if (t < minTs) minTs = t;
    if (t > maxTs) maxTs = t;
  }

  // plot frame + horizontal grid
  doc.roundedRect(x, plotY, width, PLOT_HEIGHT, 3).fill('#ffffff');
  doc.lineWidth(0.4).strokeColor('#e3e0d6');
  for (let i = 1; i < 4; i++) {
    const gy = plotY + (PLOT_HEIGHT * i) / 4;
    doc.moveTo(x, gy).lineTo(x + width, gy).stroke();
  }
  doc.roundedRect(x, plotY, width, PLOT_HEIGHT, 3).lineWidth(0.6).strokeColor('#cfc9b8').stroke();

  const inset = 4;
  const tsToX = (ts) => (maxTs === minTs ? x + inset : x + inset + ((ts - minTs) / (maxTs - minTs)) * (width - inset * 2));

  const legendItems = [];
  let colorIdx = 0;
  for (const [sensorName, points] of bySensor) {
    const color = SERIES_COLORS[colorIdx % SERIES_COLORS.length];
    colorIdx += 1;

    const sorted = [...points].sort((a, b) => new Date(a.ts) - new Date(b.ts));
    const step = Math.max(1, Math.floor(sorted.length / 400));
    const sampled = sorted.filter((_, i) => i % step === 0);

    let lo = Infinity;
    let hi = -Infinity;
    for (const p of sampled) {
      if (p.value < lo) lo = p.value;
      if (p.value > hi) hi = p.value;
    }
    const scaleMin = Math.min(0, lo);
    const scaleMax = hi * 1.05 || 1;
    const { label, unit } = prettySensor(sensorName);
    legendItems.push({ label, color, range: `${lo.toFixed(1)} - ${hi.toFixed(1)}${unit}` });

    const valToY = (v) =>
      scaleMax === scaleMin ? plotY + PLOT_HEIGHT - inset : plotY + PLOT_HEIGHT - inset - ((v - scaleMin) / (scaleMax - scaleMin)) * (PLOT_HEIGHT - inset * 2);

    doc.strokeColor(color).lineWidth(1.1).lineJoin('round');
    sampled.forEach((p, i) => {
      const px = tsToX(new Date(p.ts).getTime());
      const py = valToY(p.value);
      if (i === 0) doc.moveTo(px, py);
      else doc.lineTo(px, py);
    });
    doc.stroke();
  }

  // elapsed-time labels under the plot (0 s is the first sample)
  const labelY = plotY + PLOT_HEIGHT + 3;
  doc.font('Helvetica').fontSize(7).fillColor(MUTED);
  doc.text('0 s', x, labelY, { lineBreak: false });
  const spanText = fmtSeconds(Math.round((maxTs - minTs) / 1000));
  doc.text(spanText, x + width - doc.widthOfString(spanText), labelY, { lineBreak: false });
  doc.text('elapsed', x, labelY, { width, align: 'center', lineBreak: false });

  let legendY = labelY + 14;
  for (const item of legendItems) {
    doc.roundedRect(x, legendY + 1, 8, 5, 1).fill(item.color);
    doc.font('Helvetica').fontSize(7).fillColor(TEXT).text(item.label, x + 12, legendY, { lineBreak: false });
    doc.font('Helvetica-Bold').fontSize(7).fillColor(MUTED).text(item.range, x + 12, legendY, { width: width - 12, align: 'right', lineBreak: false });
    legendY += LEGEND_ROW;
  }

  doc.restore();
}

/** Two horizontal bars (read/write MB/s) for a benchmark run with no time-series telemetry. */
function drawThroughputBars(doc, values, x, y, width) {
  const bars = [
    { label: 'Sequential read', value: values.read, color: SERIES_COLORS[0] },
    { label: 'Sequential write', value: values.write, color: SERIES_COLORS[1] },
  ].filter((b) => typeof b.value === 'number');

  const maxVal = Math.max(...bars.map((b) => b.value)) * 1.05 || 1;
  const labelWidth = 82;
  const barMaxWidth = width - labelWidth - 62;
  let curY = y + 12;
  for (const bar of bars) {
    doc.font('Helvetica').fontSize(8).fillColor(TEXT).text(bar.label, x, curY + 1, { width: labelWidth, lineBreak: false });
    const barWidth = Math.max(2, (bar.value / maxVal) * barMaxWidth);
    doc.roundedRect(x + labelWidth, curY, barWidth, 11, 2).fill(bar.color);
    doc.font('Helvetica-Bold').fontSize(8).fillColor(TEXT).text(`${fmtValue(bar.value)} MB/s`, x + labelWidth + barWidth + 6, curY + 1, { lineBreak: false });
    curY += 24;
  }
}

// ---------------------------------------------------------------- first page

const BAND_HEIGHT = 58;

function drawHeaderBand(doc, session) {
  const w = doc.page.width;
  doc.rect(0, 0, w, BAND_HEIGHT).fill(BRAND);
  doc.rect(0, BAND_HEIGHT, w, 2).fill(BRAND_DARK);

  doc.font('Helvetica-Bold').fontSize(18).fillColor('#ffffff').text('Hardware Test Report', PAGE_MARGIN, 11, { lineBreak: false });
  doc.font('Helvetica').fontSize(9).fillColor('#ffffff').text('Luxtronic Digital Services', PAGE_MARGIN, 33, { lineBreak: false });
  doc.font('Helvetica').fontSize(7).fillColor('#fff3d6').text(`Session ${session.id}`, PAGE_MARGIN, 45, { lineBreak: false });

  // logo on a small white tile so it reads on the amber band
  const tileW = 84;
  const tileH = 44;
  const tileX = w - PAGE_MARGIN - tileW;
  doc.roundedRect(tileX, 7, tileW, tileH, 6).fill('#ffffff');
  if (fs.existsSync(LOGO_PATH)) {
    // skipped silently if the file is missing so a bad deploy can never break report generation
    doc.image(LOGO_PATH, tileX + 6, 10, { fit: [tileW - 12, tileH - 6], align: 'center', valign: 'center' });
  }
}

function drawSessionCard(doc, session, y) {
  const contentWidth = doc.page.width - PAGE_MARGIN * 2;
  const hasSpec = describeSystemInfo(session.system_info).length > 0;
  const facts = [
    ['Customer', session.customer_name || '-'],
    ['Session type', String(session.session_type || '-').replace('_', ' ')],
    ['Technician', session.technician_name || '-'],
    ['Tested on', `${fmtDate(session.started_at)}${session.ended_at ? `  (${fmtDuration(session.started_at, session.ended_at)})` : ''}`],
    // The serials are listed in the System specification section when the client sent one; only
    // sessions without it (older clients) still need them here to identify the PC.
    ...(hasSpec
      ? []
      : [
          ['PC (mobo serial)', session.mobo_serial],
          ['SSD serials', (session.ssd_serials || []).join(', ') || '-'],
        ]),
  ];
  const colWidth = (contentWidth - 24) / 2;
  const rows = Math.ceil(facts.length / 2);
  const notesText = session.notes || '';
  doc.font('Helvetica').fontSize(9.5);
  const notesHeight = notesText ? doc.heightOfString(notesText, { width: contentWidth - 28 }) + 16 : 0;
  const cardHeight = 12 + rows * 30 + notesHeight + 2;

  doc.lineWidth(0.7);
  doc.roundedRect(PAGE_MARGIN, y, contentWidth, cardHeight, 7).fillAndStroke(CARD_BG, BORDER);
  facts.forEach(([label, value], i) => {
    const fx = PAGE_MARGIN + 14 + (i % 2) * (colWidth + 24);
    const fy = y + 12 + Math.floor(i / 2) * 30;
    doc.font('Helvetica-Bold').fontSize(7.5).fillColor(MUTED).text(label.toUpperCase(), fx, fy, { lineBreak: false, characterSpacing: 0.5 });
    doc.font('Helvetica-Bold').fontSize(10).fillColor(TEXT).text(String(value), fx, fy + 11, { width: colWidth, lineBreak: false, ellipsis: true });
  });
  if (notesText) {
    const ny = y + 12 + rows * 30;
    doc.font('Helvetica-Bold').fontSize(7.5).fillColor(MUTED).text('NOTES', PAGE_MARGIN + 14, ny, { lineBreak: false, characterSpacing: 0.5 });
    doc.font('Helvetica').fontSize(9.5).fillColor(TEXT).text(notesText, PAGE_MARGIN + 14, ny + 11, { width: contentWidth - 28 });
  }
  return y + cardHeight;
}

/** What to show for a run in the summary table: headline measurement(s) and the limit(s) it was judged against. */
function runHeadline(run) {
  const s = run.summary_stats || {};
  const snap = run.config_snapshot || {};
  const measure = [];
  const limit = [];

  if (typeof s.min_seq_read_mb_s === 'number' || typeof s.min_seq_write_mb_s === 'number') {
    const n0 = (v) => (typeof v === 'number' ? Math.round(v).toLocaleString('en-US') : '-');
    measure.push(`Read ${n0(s.min_seq_read_mb_s)} / Write ${n0(s.min_seq_write_mb_s)} MB/s`);
    if (typeof snap.min_seq_read_mb_s === 'number') limit.push(`min ${snap.min_seq_read_mb_s} / ${snap.min_seq_write_mb_s ?? '-'} MB/s`);
  } else if (typeof s.max_temp_c === 'number') {
    measure.push(`Peak ${fmtValue(s.max_temp_c)} °C`);
    if (typeof snap.max_temp_c === 'number') limit.push(`max ${snap.max_temp_c} °C`);
  }
  if (typeof s.error_count === 'number' && measure.length < 2 && !measure.some((m) => m.startsWith('Read'))) measure.push(s.error_count === 0 ? 'no errors' : `${s.error_count} error${s.error_count > 1 ? 's' : ''}`);
  return { measure: measure.join(', ') || '-', limit: limit.join(', ') || '-' };
}

function drawSummaryTable(doc, testRuns) {
  if (testRuns.length === 0) return;
  const contentWidth = doc.page.width - PAGE_MARGIN * 2;
  const cols = [
    { title: 'TEST', x: 12, w: 96 },
    { title: 'RESULT', x: 112, w: 70 },
    { title: 'DURATION', x: 186, w: 50 },
    { title: 'MEASURED', x: 242, w: 168 },
    { title: 'PASS LIMIT', x: 414, w: contentWidth - 414 - 8 },
  ];
  const rowH = 25;
  const headH = 21;
  ensureSpace(doc, 40 + headH + rowH * Math.min(testRuns.length, 3));
  sectionHeading(doc, 'Results summary');

  const y0 = doc.y;
  const totalH = headH + rowH * testRuns.length;
  doc.lineWidth(0.7);
  doc.roundedRect(PAGE_MARGIN, y0, contentWidth, totalH, 7).fillAndStroke('#ffffff', BORDER);
  doc.save().roundedRect(PAGE_MARGIN, y0, contentWidth, headH, 7).clip();
  doc.rect(PAGE_MARGIN, y0, contentWidth, headH).fill(CARD_BG);
  doc.restore();
  doc.roundedRect(PAGE_MARGIN, y0, contentWidth, totalH, 7).lineWidth(0.7).strokeColor(BORDER).stroke();
  cols.forEach((c) => {
    doc.font('Helvetica-Bold').fontSize(7).fillColor(MUTED).text(c.title, PAGE_MARGIN + c.x, y0 + 7, { lineBreak: false, characterSpacing: 0.6 });
  });

  testRuns.forEach((run, i) => {
    const ry = y0 + headH + i * rowH;
    if (i > 0) doc.moveTo(PAGE_MARGIN + 1, ry).lineTo(PAGE_MARGIN + contentWidth - 1, ry).lineWidth(0.4).strokeColor(BORDER).stroke();
    const [name, , tool] = COMPONENTS[run.component] || [run.component.toUpperCase(), '', ''];
    const head = runHeadline(run);

    doc.font('Helvetica-Bold').fontSize(9.5).fillColor(TEXT).text(name, PAGE_MARGIN + cols[0].x, ry + 5, { lineBreak: false });
    doc.font('Helvetica').fontSize(7).fillColor(MUTED).text(tool, PAGE_MARGIN + cols[0].x, ry + 16, { lineBreak: false });
    drawPill(doc, resultLabel(run), resultKey(run), PAGE_MARGIN + cols[1].x, ry + 5.5);
    doc.font('Helvetica').fontSize(8.5).fillColor(TEXT).text(fmtDuration(run.started_at, run.ended_at), PAGE_MARGIN + cols[2].x, ry + 8, { width: cols[2].w, lineBreak: false });
    doc.font('Helvetica-Bold').fontSize(8.5).fillColor(TEXT).text(head.measure, PAGE_MARGIN + cols[3].x, ry + 8, { width: cols[3].w, lineBreak: false, ellipsis: true });
    doc.font('Helvetica').fontSize(8.5).fillColor(MUTED).text(head.limit, PAGE_MARGIN + cols[4].x, ry + 8, { width: cols[4].w, lineBreak: false, ellipsis: true });
  });

  doc.y = y0 + totalH + 20;
  doc.x = PAGE_MARGIN;
}

/**
 * "System specification": what machine this report is about, as small boxes (CPU, graphics, memory,
 * motherboard, drives, OS) flowing into two columns so a tall box (a drive lists ten rows) doesn't
 * leave a gap next to a short one. Nothing is drawn for a session without a spec.
 */
function drawSystemSpec(doc, systemInfo) {
  const sections = describeSystemInfo(systemInfo);
  if (sections.length === 0) return;

  ensureSpace(doc, 120);
  sectionHeading(doc, 'System specification');

  const contentWidth = doc.page.width - PAGE_MARGIN * 2;
  const gap = 12;
  const colWidth = (contentWidth - gap) / 2;
  const labelWidth = 62;
  const pad = 10;
  const valueWidth = colWidth - pad * 2 - labelWidth;
  const bottomLimit = doc.page.height - PAGE_MARGIN - FOOTER_SPACE;

  const measure = (section) => {
    let h = pad + 12;
    const rowHeights = section.rows.map(([, value]) => {
      doc.font('Helvetica-Bold').fontSize(8);
      return Math.max(11, doc.heightOfString(String(value), { width: valueWidth })) + 3;
    });
    h += rowHeights.reduce((a, b) => a + b, 0) + pad - 2;
    return { height: h, rowHeights };
  };

  let colY = [doc.y, doc.y];
  for (const section of sections) {
    const { height, rowHeights } = measure(section);
    let col = colY[0] <= colY[1] ? 0 : 1;
    if (colY[col] + height > bottomLimit) {
      doc.addPage();
      colY = [CONTINUATION_TOP, CONTINUATION_TOP];
      col = 0;
    }
    const cx = PAGE_MARGIN + col * (colWidth + gap);
    const cy = colY[col];

    doc.lineWidth(0.7);
    doc.roundedRect(cx, cy, colWidth, height, 5).fillAndStroke(CARD_BG, BORDER);
    doc.rect(cx + 8, cy, 28, 2).fill(BRAND);
    doc.font('Helvetica-Bold').fontSize(7.5).fillColor(BRAND_DARK).text(section.title.toUpperCase(), cx + pad, cy + pad, { lineBreak: false, characterSpacing: 0.7 });

    let ry = cy + pad + 14;
    section.rows.forEach(([label, value], i) => {
      doc.font('Helvetica').fontSize(8).fillColor(MUTED).text(label, cx + pad, ry, { width: labelWidth - 4, lineBreak: false, ellipsis: true });
      doc.font('Helvetica-Bold').fontSize(8).fillColor(TEXT).text(String(value), cx + pad + labelWidth, ry, { width: valueWidth });
      ry += rowHeights[i];
    });

    colY[col] = cy + height + 10;
  }

  doc.y = Math.max(colY[0], colY[1]) + 10;
  doc.x = PAGE_MARGIN;
}

// ---------------------------------------------------------------- test-run cards

const CARD_HEADER_HEIGHT = 52;
const ROW_HEIGHT = 17;

function runRows(run) {
  const summaryStats = run.summary_stats || {};
  const snap = run.config_snapshot || {};
  const rows = [{ label: 'Duration', value: fmtDuration(run.started_at, run.ended_at), limit: '' }];
  for (const [k, v] of Object.entries(summaryStats)) {
    const display = STAT_LABELS[k];
    rows.push({
      key: k,
      label: display ? display[0] : k.replace(/_/g, ' '),
      value: `${fmtValue(v)}${display ? display[1] : ''}`,
      raw: v,
      limit: limitText(k, snap),
    });
  }
  if (run.stop_reason) rows.push({ label: 'Stopped', value: String(run.stop_reason).replace(/_/g, ' '), limit: '' });
  return rows;
}

function hasMarginBar(r, snap) {
  return !!(r.key && r.key.startsWith('max_') && r.key.endsWith('temp_c') && typeof r.raw === 'number' && typeof snap[r.key] === 'number');
}

function rowHeightFor(r, snap) {
  return hasMarginBar(r, snap) ? ROW_HEIGHT + 8 : ROW_HEIGHT;
}

function runCardHeight(run, telemetry) {
  const snap = run.config_snapshot || {};
  const tableHeight = runRows(run).reduce((sum, r) => sum + rowHeightFor(r, snap), 0);
  const bodyHeight = Math.max(tableHeight, chartHeightFor(telemetry, run.summary_stats || {}));
  return CARD_HEADER_HEIGHT + bodyHeight + 14;
}

/** Small bar showing how close a "max" reading came to its limit: green, amber past 85 %, red over. */
function drawMargin(doc, value, limit, x, y, width) {
  const ratio = limit > 0 ? value / limit : 0;
  const color = ratio > 1 ? STATUS.fail.fg : ratio >= 0.85 ? STATUS.flagged.fg : STATUS.pass.fg;
  doc.roundedRect(x, y, width, 4, 2).fill('#ece8da');
  doc.roundedRect(x, y, Math.max(2, Math.min(1, ratio) * width), 4, 2).fill(color);
}

function drawRunCard(doc, run, telemetry) {
  const contentWidth = doc.page.width - PAGE_MARGIN * 2;
  const summaryStats = run.summary_stats || {};
  const snap = run.config_snapshot || {};
  const [name, subtitle, tool] = COMPONENTS[run.component] || [run.component.toUpperCase(), 'Test', ''];
  const status = resultKey(run);
  const colors = STATUS[status] || STATUS.unknown;

  const rows = runRows(run);
  const tableWidth = 218;
  const chartX = PAGE_MARGIN + 16 + tableWidth + 16;
  const chartWidth = PAGE_MARGIN + contentWidth - 14 - chartX;
  const cardHeight = runCardHeight(run, telemetry);

  ensureSpace(doc, cardHeight + 6);
  const y = doc.y;

  doc.lineWidth(0.7);
  doc.roundedRect(PAGE_MARGIN, y, contentWidth, cardHeight, 7).fillAndStroke('#ffffff', BORDER);
  doc.save().roundedRect(PAGE_MARGIN, y, contentWidth, cardHeight, 7).clip();
  doc.rect(PAGE_MARGIN, y, 5, cardHeight).fill(colors.fg);
  doc.rect(PAGE_MARGIN + 5, y, contentWidth - 5, CARD_HEADER_HEIGHT - 6).fill(CARD_BG);
  doc.restore();
  doc.roundedRect(PAGE_MARGIN, y, contentWidth, cardHeight, 7).lineWidth(0.7).strokeColor(BORDER).stroke();

  doc.font('Helvetica-Bold').fontSize(14).fillColor(TEXT).text(name, PAGE_MARGIN + 18, y + 10, { lineBreak: false });
  const titleW = doc.widthOfString(name);
  doc.font('Helvetica').fontSize(9).fillColor(MUTED).text(`${subtitle}  -  ${tool}`, PAGE_MARGIN + 18 + titleW + 12, y + 13.5, { lineBreak: false });
  const pw = pillWidth(doc, resultLabel(run));
  drawPill(doc, resultLabel(run), status, PAGE_MARGIN + contentWidth - 14 - pw, y + 10);

  const settings = runSettingsText({ ...snap });
  const meta = [`Started ${fmtDate(run.started_at)}`, settings].filter(Boolean).join('   |   ');
  doc.font('Helvetica').fontSize(8).fillColor(MUTED).text(meta, PAGE_MARGIN + 18, y + 32, { width: contentWidth - 36, lineBreak: false, ellipsis: true });

  // key figures: label | value | pass limit (+ a margin bar for temperatures)
  let ry = y + CARD_HEADER_HEIGHT + 2;
  rows.forEach((r) => {
    doc.font('Helvetica').fontSize(8.5).fillColor(MUTED).text(r.label, PAGE_MARGIN + 18, ry, { width: 92, lineBreak: false, ellipsis: true });
    doc.font('Helvetica-Bold').fontSize(8.5).fillColor(TEXT).text(r.value, PAGE_MARGIN + 18 + 94, ry, { width: 64, lineBreak: false, ellipsis: true });
    if (r.limit) {
      doc.font('Helvetica').fontSize(7.5).fillColor(MUTED).text(r.limit, PAGE_MARGIN + 18 + 94 + 66, ry + 0.5, { width: 56, lineBreak: false, ellipsis: true });
    }
    if (hasMarginBar(r, snap)) {
      drawMargin(doc, r.raw, snap[r.key], PAGE_MARGIN + 18 + 94, ry + 13, 120);
    }
    ry += rowHeightFor(r, snap);
  });

  drawTelemetryChart(doc, telemetry, chartX, y + CARD_HEADER_HEIGHT + 2, chartWidth, summaryStats);

  doc.y = y + cardHeight + 12;
  doc.x = PAGE_MARGIN;
}

// ---------------------------------------------------------------- closing note + page furniture

function drawClosingNote(doc, session) {
  const contentWidth = doc.page.width - PAGE_MARGIN * 2;
  ensureSpace(doc, 70);
  const y = doc.y + 4;
  doc.lineWidth(0.7);
  doc.roundedRect(PAGE_MARGIN, y, contentWidth, 56, 7).fillAndStroke(CARD_BG, BORDER);
  doc.font('Helvetica-Bold').fontSize(7.5).fillColor(MUTED).text('ABOUT THIS REPORT', PAGE_MARGIN + 14, y + 10, { lineBreak: false, characterSpacing: 0.6 });
  doc.font('Helvetica').fontSize(8).fillColor(TEXT).text(
    'These tests were run with Luxtronic PCTools. "Pass limit" is the threshold the result is judged against; a result near its limit ' +
      'is marked "flagged" so a technician can take a closer look. Results describe the machine on the date shown only.',
    PAGE_MARGIN + 14, y + 22, { width: contentWidth - 28 }
  );
  doc.y = y + 64;
}

function drawPageFurniture(doc, session) {
  const range = doc.bufferedPageRange();
  for (let i = range.start; i < range.start + range.count; i++) {
    doc.switchToPage(i);
    const w = doc.page.width;
    const h = doc.page.height;

    if (i > range.start) {
      // running header on continuation pages (the first page has the full header band)
      doc.rect(0, 0, w, 6).fill(BRAND);
      doc.page.margins.bottom = 0;
      doc.font('Helvetica-Bold').fontSize(8.5).fillColor(TEXT).text('Hardware Test Report', PAGE_MARGIN, 22, { lineBreak: false });
      const who = [session.customer_name, `Session ${String(session.id).slice(0, 8)}`].filter(Boolean).join('  |  ');
      doc.font('Helvetica').fontSize(8).fillColor(MUTED).text(who, PAGE_MARGIN, 22, { width: w - PAGE_MARGIN * 2, align: 'right', lineBreak: false });
      doc.moveTo(PAGE_MARGIN, 40).lineTo(w - PAGE_MARGIN, 40).lineWidth(0.5).strokeColor(BORDER).stroke();
    }

    // writing below the bottom margin would make pdfkit add a page, so drop the margin first
    doc.page.margins.bottom = 0;
    doc.moveTo(PAGE_MARGIN, h - 34).lineTo(w - PAGE_MARGIN, h - 34).lineWidth(0.5).strokeColor(BORDER).stroke();
    doc.font('Helvetica').fontSize(7.5).fillColor('#999');
    doc.text(`Luxtronic Digital Services  |  Generated ${fmtDate(new Date())}`, PAGE_MARGIN, h - 26, { lineBreak: false });
    const pageText = `Page ${i - range.start + 1} of ${range.count}`;
    doc.text(pageText, w - PAGE_MARGIN - doc.widthOfString(pageText), h - 26, { lineBreak: false });
  }
}

/**
 * @returns {import('pdfkit')} a PDFDocument already streaming -- caller pipes it to the response.
 */
function generateSessionReportPdf({ session, testRuns, telemetryByRun }) {
  const doc = new PDFDocument({ margin: PAGE_MARGIN, size: 'A4', bufferPages: true });

  drawHeaderBand(doc, session);
  const y = drawSessionCard(doc, session, BAND_HEIGHT + 2 + 14);
  doc.y = y + 18;
  doc.x = PAGE_MARGIN;

  drawSystemSpec(doc, session.system_info);
  drawSummaryTable(doc, testRuns);

  if (testRuns.length === 0) {
    doc.font('Helvetica-Oblique').fontSize(10).fillColor('#888').text('No test runs recorded in this session.', PAGE_MARGIN, doc.y);
  } else {
    ensureSpace(doc, 40 + runCardHeight(testRuns[0], telemetryByRun[testRuns[0].id]));
    sectionHeading(doc, 'Detailed results');
    for (const run of testRuns) {
      drawRunCard(doc, run, telemetryByRun[run.id]);
    }
    drawClosingNote(doc, session);
  }

  drawPageFurniture(doc, session);
  doc.end();
  return doc;
}

module.exports = { generateSessionReportPdf };
