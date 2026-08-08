'use strict';

// Unit tests for the config loader (src/config.js, CONTRACT.md section 3). `loadConfig` /
// `configPath` read `process.env.CONFIG_PATH` (falling back to config/default.json relative to
// the module) and deliberately re-read from disk on every call rather than caching -- see the
// comment at the top of src/config.js. Each test writes its own fixture file under a fresh temp
// directory and points CONFIG_PATH at it, restoring the original env var afterward so nothing
// leaks into other test files.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { loadConfig, configPath } = require('../src/config');

const VALID_CONFIG = {
  cpu: { tool: 'prime95', mode: 'blend', duration_minutes: 60, max_temp_c: 95 },
  gpu: { tool: 'furmark', duration_minutes: 20, max_temp_c: 90 },
  ram: { tool: 'tm5', config_profile: 'anta777-extreme', duration_minutes: 60, max_errors: 0 },
  ssd: {
    tool: 'crystaldiskmark',
    min_seq_read_mb_s: 400,
    min_seq_write_mb_s: 300,
    smart_reallocated_sectors_max: 0,
  },
  concurrency: { cpu_gpu_together_allowed: true, exclusive_components: ['ram', 'ssd'] },
};

function withTempDir(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'luxtronic-config-test-'));
  try {
    return fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function withConfigPath(filePath, fn) {
  const original = process.env.CONFIG_PATH;
  process.env.CONFIG_PATH = filePath;
  try {
    return fn();
  } finally {
    if (original === undefined) {
      delete process.env.CONFIG_PATH;
    } else {
      process.env.CONFIG_PATH = original;
    }
  }
}

test('loadConfig loads a well-formed config with all required sections', () => {
  withTempDir((dir) => {
    const filePath = path.join(dir, 'good.json');
    fs.writeFileSync(filePath, JSON.stringify(VALID_CONFIG));
    withConfigPath(filePath, () => {
      const loaded = loadConfig();
      assert.deepEqual(loaded, VALID_CONFIG);
    });
  });
});

test('loadConfig throws a clear error if a required component section is missing', () => {
  withTempDir((dir) => {
    const filePath = path.join(dir, 'missing-gpu.json');
    const { gpu, ...rest } = VALID_CONFIG;
    fs.writeFileSync(filePath, JSON.stringify(rest));
    withConfigPath(filePath, () => {
      assert.throws(() => loadConfig(), /missing required section "gpu"/);
    });
  });
});

test('loadConfig throws a clear error if the concurrency section is missing', () => {
  withTempDir((dir) => {
    const filePath = path.join(dir, 'missing-concurrency.json');
    const { concurrency, ...rest } = VALID_CONFIG;
    fs.writeFileSync(filePath, JSON.stringify(rest));
    withConfigPath(filePath, () => {
      assert.throws(() => loadConfig(), /missing required section "concurrency"/);
    });
  });
});

test('loadConfig throws a clear error if the file is not valid JSON', () => {
  withTempDir((dir) => {
    const filePath = path.join(dir, 'invalid.json');
    fs.writeFileSync(filePath, '{ this is not valid json ');
    withConfigPath(filePath, () => {
      assert.throws(() => loadConfig(), /is not valid JSON/);
    });
  });
});

test('loadConfig throws a clear error if the file does not exist', () => {
  withTempDir((dir) => {
    const filePath = path.join(dir, 'does-not-exist.json');
    withConfigPath(filePath, () => {
      assert.throws(() => loadConfig(), /Failed to read config file/);
    });
  });
});

test('loadConfig re-reads from disk every call: no stale caching between calls', () => {
  withTempDir((dir) => {
    const filePath = path.join(dir, 'mutable.json');
    fs.writeFileSync(filePath, JSON.stringify(VALID_CONFIG));
    withConfigPath(filePath, () => {
      const first = loadConfig();
      assert.equal(first.cpu.max_temp_c, 95);

      const updated = { ...VALID_CONFIG, cpu: { ...VALID_CONFIG.cpu, max_temp_c: 80 } };
      fs.writeFileSync(filePath, JSON.stringify(updated));

      const second = loadConfig();
      assert.equal(second.cpu.max_temp_c, 80);
    });
  });
});

test('configPath returns the absolute CONFIG_PATH when it is already absolute', () => {
  withTempDir((dir) => {
    const filePath = path.join(dir, 'abs.json');
    withConfigPath(filePath, () => {
      assert.equal(configPath(), filePath);
    });
  });
});

test('configPath falls back to config/default.json relative to the module when unset', () => {
  const original = process.env.CONFIG_PATH;
  delete process.env.CONFIG_PATH;
  try {
    const resolved = configPath();
    assert.ok(path.isAbsolute(resolved));
    assert.match(resolved, /config[\\/]default\.json$/);
  } finally {
    if (original === undefined) {
      delete process.env.CONFIG_PATH;
    } else {
      process.env.CONFIG_PATH = original;
    }
  }
});
