'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { describeSystemInfo, isValidSystemInfo } = require('../src/lib/systemInfo');

const FULL = {
  cpu: { name: 'Intel Core i5-11400F', cores: 6, threads: 12, base_clock_mhz: 4400 },
  gpu: [{ name: 'NVIDIA GeForce GTX 1080 Ti', vram_gb: 11, driver_version: '31.0.15.4601' }],
  memory: {
    total_gb: 32,
    modules: [
      { slot: 'DIMM A1', size_gb: 16, type: 'DDR4', speed_mhz: 3200, manufacturer: 'Corsair', part_number: 'CMK32' },
      { slot: 'DIMM B1', size_gb: 16, type: 'DDR4', speed_mhz: 3200 },
    ],
  },
  motherboard: { name: 'MSI MPG B560I', serial: 'ABC123', bios_version: 'E7D19IMS.A10', bios_date: '2023-05-01' },
  storage: [{ model: 'CT1000T500SSD5', capacity_gb: 1000, bus: 'NVMe', health_percent: 100, power_on_hours: 1669, host_writes_gb: 6331 }],
  os: { name: 'Microsoft Windows 11 Pro', version: '10.0.26300', architecture: '64-bit' },
};

const byTitle = (sections, title) => sections.find((s) => s.title === title);

test('describeSystemInfo: null / missing / junk -> no sections, never throws', () => {
  for (const v of [null, undefined, 5, 'x', []]) {
    assert.deepEqual(describeSystemInfo(v), []);
  }
  assert.deepEqual(describeSystemInfo({}), []);
});

test('describeSystemInfo: full spec produces every section in report order', () => {
  const titles = describeSystemInfo(FULL).map((s) => s.title);
  assert.deepEqual(titles, ['Processor', 'Graphics', 'Memory', 'Motherboard', 'Storage', 'Operating system']);
});

test('describeSystemInfo: formats cpu, memory modules and storage readably', () => {
  const sections = describeSystemInfo(FULL);
  assert.deepEqual(byTitle(sections, 'Processor').rows, [
    ['Model', 'Intel Core i5-11400F'],
    ['Cores / threads', '6 cores / 12 threads'],
    ['Base clock', '4.4 GHz'],
  ]);
  const memory = byTitle(sections, 'Memory').rows;
  assert.deepEqual(memory[0], ['Total', '32 GB']);
  assert.deepEqual(memory[1], ['DIMM A1', '16 GB - DDR4-3200 - Corsair CMK32']);
  assert.deepEqual(memory[2], ['DIMM B1', '16 GB - DDR4-3200']);
  const storage = byTitle(sections, 'Storage').rows;
  assert.ok(storage.some(([k, v]) => k === 'Capacity' && v === '1 TB'));
  assert.ok(storage.some(([k, v]) => k === 'Power-on time' && v === '1,669 hours'));
  assert.ok(storage.some(([k, v]) => k === 'Total data written' && v === '6.33 TB'));
});

test('describeSystemInfo: partial info only lists what is known, and numbers the sections when several', () => {
  const sections = describeSystemInfo({
    cpu: { name: 'Ryzen 5 5600' },
    storage: [{ model: 'A' }, { model: 'B', capacity_gb: 500 }],
  });
  assert.deepEqual(sections.map((s) => s.title), ['Processor', 'Storage 1', 'Storage 2']);
  assert.deepEqual(sections[0].rows, [['Model', 'Ryzen 5 5600']]);
});

test('describeSystemInfo: bios without a date, empty strings and non-numbers are skipped', () => {
  const s = describeSystemInfo({ motherboard: { name: '', serial: 'X', bios_version: 'F5' }, cpu: { cores: 'many' } });
  assert.deepEqual(byTitle(s, 'Motherboard').rows, [['Serial number', 'X'], ['BIOS', 'F5']]);
  assert.equal(byTitle(s, 'Processor'), undefined);
});

test('isValidSystemInfo: accepts absent/null/objects, rejects arrays, scalars and oversized payloads', () => {
  assert.equal(isValidSystemInfo(undefined), true);
  assert.equal(isValidSystemInfo(null), true);
  assert.equal(isValidSystemInfo(FULL), true);
  for (const v of [[], 'x', 5, true]) assert.equal(isValidSystemInfo(v), false);
  assert.equal(isValidSystemInfo({ blob: 'x'.repeat(70 * 1024) }), false);
});
