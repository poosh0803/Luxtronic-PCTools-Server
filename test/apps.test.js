'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Readable } = require('stream');
const { sanitizeDownloadName, saveStream } = require('../src/lib/apps');

test('sanitizeDownloadName strips path parts and unsafe characters', () => {
  assert.strictEqual(sanitizeDownloadName('C:\\Users\\x\\Setup.exe'), 'Setup.exe');
  assert.strictEqual(sanitizeDownloadName('../../etc/passwd'), 'passwd');
  assert.strictEqual(sanitizeDownloadName('a<b>:c.exe'), 'a_b__c.exe');
  assert.strictEqual(sanitizeDownloadName(''), 'download');
  assert.strictEqual(sanitizeDownloadName(undefined), 'download');
});

test('saveStream writes the file and reports size and sha256', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'apps-test-'));
  const dest = path.join(dir, 'sub', 'package');
  const result = await saveStream(Readable.from([Buffer.from('hello '), Buffer.from('world')]), dest, 1024);
  assert.strictEqual(result.size, 11);
  assert.strictEqual(result.sha256, 'b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9');
  assert.strictEqual(fs.readFileSync(dest, 'utf8'), 'hello world');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('saveStream rejects oversize uploads and leaves no file behind', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'apps-test-'));
  const dest = path.join(dir, 'package');
  await assert.rejects(saveStream(Readable.from([Buffer.alloc(100)]), dest, 50), { code: 'too_large' });
  assert.deepStrictEqual(fs.readdirSync(dir), []);
  fs.rmSync(dir, { recursive: true, force: true });
});
