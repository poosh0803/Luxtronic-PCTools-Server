'use strict';

// PC specification sent by the client at session creation (sessions.system_info), and the one
// place that turns it into readable sections -- used by both the session page and the PDF report,
// so a customer reading either sees the same thing. Everything is optional: a client may only
// know some of it (no HWiNFO -> no GPU VRAM, a WMI timeout -> no memory modules...), and a missing
// field is simply left out rather than shown as "undefined".
//
// Shape the client sends (all keys optional):
//   cpu:         { name, cores, threads, base_clock_mhz }
//   gpu:         [ { name, vram_gb, driver_version } ]
//   memory:      { total_gb, modules: [ { slot, size_gb, type, speed_mhz, manufacturer, part_number } ] }
//   motherboard: { name, serial, bios_version, bios_date }
//   storage:     [ { model, serial, firmware, capacity_gb, bus, health_percent,
//                    power_on_hours, power_on_count, host_reads_gb, host_writes_gb } ]
//   os:          { name, version, architecture }

const MAX_SYSTEM_INFO_BYTES = 64 * 1024;

function isValidSystemInfo(value) {
  if (value === undefined || value === null) return true;
  if (typeof value !== 'object' || Array.isArray(value)) return false;
  return JSON.stringify(value).length <= MAX_SYSTEM_INFO_BYTES;
}

function has(v) {
  return v !== undefined && v !== null && v !== '';
}

function num(v) {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function fmtNum(n, digits = 0) {
  return n.toLocaleString('en-US', { maximumFractionDigits: digits });
}

function fmtGb(v) {
  const n = num(v);
  if (n === null) return null;
  // 1000 GB and over reads better as TB (a "1000 GB" drive is a 1 TB drive).
  return n >= 1000 ? `${fmtNum(n / 1000, 2)} TB` : `${fmtNum(n, n < 10 ? 1 : 0)} GB`;
}

function row(rows, label, value) {
  if (has(value)) rows.push([label, String(value)]);
}

/**
 * @param {object|null|undefined} info - sessions.system_info
 * @returns {Array<{title: string, rows: Array<[string, string]>}>} sections with at least one row
 */
function describeSystemInfo(info) {
  if (!info || typeof info !== 'object') return [];
  const sections = [];
  const add = (title, rows) => {
    if (rows.length > 0) sections.push({ title, rows });
  };

  const cpu = info.cpu;
  if (cpu && typeof cpu === 'object') {
    const rows = [];
    row(rows, 'Model', cpu.name);
    if (num(cpu.cores) !== null || num(cpu.threads) !== null) {
      row(rows, 'Cores / threads', `${num(cpu.cores) ?? '?'} cores / ${num(cpu.threads) ?? '?'} threads`);
    }
    if (num(cpu.base_clock_mhz) !== null) row(rows, 'Base clock', `${fmtNum(cpu.base_clock_mhz / 1000, 2)} GHz`);
    add('Processor', rows);
  }

  const gpus = Array.isArray(info.gpu) ? info.gpu : [];
  gpus.forEach((gpu, i) => {
    if (!gpu || typeof gpu !== 'object') return;
    const rows = [];
    row(rows, 'Model', gpu.name);
    row(rows, 'Video memory', fmtGb(gpu.vram_gb));
    row(rows, 'Driver version', gpu.driver_version);
    add(gpus.length > 1 ? `Graphics ${i + 1}` : 'Graphics', rows);
  });

  const memory = info.memory;
  if (memory && typeof memory === 'object') {
    const rows = [];
    row(rows, 'Total', fmtGb(memory.total_gb));
    const modules = Array.isArray(memory.modules) ? memory.modules : [];
    modules.forEach((m, i) => {
      if (!m || typeof m !== 'object') return;
      const parts = [
        fmtGb(m.size_gb),
        has(m.type) ? `${m.type}${num(m.speed_mhz) !== null ? `-${m.speed_mhz}` : ''}` : null,
        [m.manufacturer, m.part_number].filter(has).join(' '),
      ].filter(has);
      row(rows, has(m.slot) ? String(m.slot) : `Module ${i + 1}`, parts.join(' - '));
    });
    add('Memory', rows);
  }

  const board = info.motherboard;
  if (board && typeof board === 'object') {
    const rows = [];
    row(rows, 'Model', board.name);
    row(rows, 'Serial number', board.serial);
    if (has(board.bios_version)) {
      row(rows, 'BIOS', has(board.bios_date) ? `${board.bios_version} (${board.bios_date})` : board.bios_version);
    }
    add('Motherboard', rows);
  }

  const drives = Array.isArray(info.storage) ? info.storage : [];
  drives.forEach((d, i) => {
    if (!d || typeof d !== 'object') return;
    const rows = [];
    row(rows, 'Model', d.model);
    row(rows, 'Capacity', fmtGb(d.capacity_gb));
    row(rows, 'Interface', d.bus);
    row(rows, 'Serial number', d.serial);
    row(rows, 'Firmware', d.firmware);
    if (num(d.health_percent) !== null) row(rows, 'Health', `${fmtNum(d.health_percent)}%`);
    if (num(d.power_on_hours) !== null) row(rows, 'Power-on time', `${fmtNum(d.power_on_hours)} hours`);
    if (num(d.power_on_count) !== null) row(rows, 'Power cycles', fmtNum(d.power_on_count));
    if (num(d.host_reads_gb) !== null) row(rows, 'Total data read', fmtGb(d.host_reads_gb));
    if (num(d.host_writes_gb) !== null) row(rows, 'Total data written', fmtGb(d.host_writes_gb));
    add(drives.length > 1 ? `Storage ${i + 1}` : 'Storage', rows);
  });

  const os = info.os;
  if (os && typeof os === 'object') {
    const rows = [];
    row(rows, 'System', os.name);
    row(rows, 'Version', os.version);
    row(rows, 'Architecture', os.architecture);
    add('Operating system', rows);
  }

  return sections;
}

module.exports = { describeSystemInfo, isValidSystemInfo, MAX_SYSTEM_INFO_BYTES };
