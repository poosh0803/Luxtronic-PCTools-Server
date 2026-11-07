'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { extractIcoFromExe, extractBestIconFromExe, buildIco } = require('../src/lib/exeIcon');

/**
 * A minimal PE32+ file whose only content is a resource tree with one icon group (one 32x32 image)
 * and that image: DOS header -> PE headers -> one .rsrc section holding the resource directories.
 */
function buildFakeExe(iconBlob) {
  const RVA = 0x1000;
  const RAW = 0x200;
  const rsrc = Buffer.alloc(0x100 + iconBlob.length);

  const dir = (at, entries) => {
    rsrc.writeUInt16LE(entries.length, at + 14); // number of ID entries
    entries.forEach((e, i) => {
      rsrc.writeUInt32LE(e.id, at + 16 + i * 8);
      rsrc.writeUInt32LE(e.isDir ? (0x80000000 | e.target) >>> 0 : e.target, at + 20 + i * 8);
    });
  };
  const dataEntry = (at, offset, size) => {
    rsrc.writeUInt32LE(RVA + offset, at);
    rsrc.writeUInt32LE(size, at + 4);
  };

  dir(0x00, [{ id: 3, isDir: true, target: 0x20 }, { id: 14, isDir: true, target: 0x40 }]); // RT_ICON, RT_GROUP_ICON
  dir(0x20, [{ id: 1, isDir: true, target: 0x60 }]);
  dir(0x40, [{ id: 1, isDir: true, target: 0x80 }]);
  dir(0x60, [{ id: 1033, isDir: false, target: 0xa0 }]);
  dir(0x80, [{ id: 1033, isDir: false, target: 0xb0 }]);
  dataEntry(0xa0, 0xe0, iconBlob.length);
  dataEntry(0xb0, 0xc0, 20);

  // GRPICONDIR: reserved, type 1, count 1, then one GRPICONDIRENTRY pointing at icon id 1.
  rsrc.writeUInt16LE(1, 0xc0 + 2);
  rsrc.writeUInt16LE(1, 0xc0 + 4);
  rsrc.writeUInt8(32, 0xc0 + 6); // width
  rsrc.writeUInt8(32, 0xc0 + 7); // height
  rsrc.writeUInt16LE(1, 0xc0 + 10); // planes
  rsrc.writeUInt16LE(32, 0xc0 + 12); // bit count
  rsrc.writeUInt32LE(iconBlob.length, 0xc0 + 14);
  rsrc.writeUInt16LE(1, 0xc0 + 18); // icon id
  iconBlob.copy(rsrc, 0xe0);

  const file = Buffer.alloc(RAW + rsrc.length);
  file.write('MZ', 0, 'latin1');
  file.writeUInt32LE(0x40, 0x3c);
  file.write('PE\0\0', 0x40, 'latin1');
  file.writeUInt16LE(1, 0x40 + 6); // one section
  file.writeUInt16LE(240, 0x40 + 20); // PE32+ optional header size
  const optional = 0x40 + 24;
  file.writeUInt16LE(0x20b, optional);
  file.writeUInt32LE(RVA, optional + 112 + 16); // resource directory RVA
  file.writeUInt32LE(rsrc.length, optional + 112 + 20);
  const section = optional + 240;
  file.write('.rsrc', section, 'latin1');
  file.writeUInt32LE(rsrc.length, section + 8); // virtual size
  file.writeUInt32LE(RVA, section + 12);
  file.writeUInt32LE(rsrc.length, section + 16); // raw size
  file.writeUInt32LE(RAW, section + 20);
  rsrc.copy(file, RAW);
  return file;
}

function withTempFile(contents, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'exeicon-test-'));
  const file = path.join(dir, 'fake.exe');
  fs.writeFileSync(file, contents);
  try {
    return fn(file);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('extractIcoFromExe reads the icon group and image out of the PE resources', () => {
  const image = Buffer.from('fake-icon-image-bytes');
  const ico = withTempFile(buildFakeExe(image), extractIcoFromExe);
  assert.ok(ico, 'an icon was found');
  assert.strictEqual(ico.readUInt16LE(2), 1, 'ICO type');
  assert.strictEqual(ico.readUInt16LE(4), 1, 'one image');
  assert.strictEqual(ico.readUInt8(6), 32, 'width');
  assert.strictEqual(ico.readUInt32LE(6 + 8), image.length, 'image size');
  const offset = ico.readUInt32LE(6 + 12);
  assert.deepStrictEqual(ico.subarray(offset, offset + image.length), image);
});

test('extractIcoFromExe returns null for files that are not PE executables with icons', () => {
  assert.strictEqual(withTempFile(Buffer.from('just some text'), extractIcoFromExe), null);
  assert.strictEqual(withTempFile(Buffer.alloc(0), extractIcoFromExe), null);
  const noResources = buildFakeExe(Buffer.from('x'));
  noResources.writeUInt32LE(0, 0x40 + 24 + 112 + 16); // resource directory RVA = 0
  assert.strictEqual(withTempFile(noResources, extractIcoFromExe), null);
  assert.strictEqual(extractIcoFromExe(path.join(os.tmpdir(), 'does-not-exist.exe')), null);
});

test('buildIco puts the largest image first and skips entries whose image is missing', () => {
  const entry = (id, size, bitCount) => ({ id, width: size, height: size, colorCount: 0, planes: 1, bitCount });
  const blobs = new Map([[1, Buffer.from('small')], [2, Buffer.from('large-image')]]);
  const ico = buildIco([entry(1, 16, 32), entry(2, 256, 32), entry(3, 48, 32)], blobs);
  assert.strictEqual(ico.readUInt16LE(4), 2, 'entry 3 has no image so it is dropped');
  assert.strictEqual(ico.readUInt8(6), 0, '256 is stored as 0');
  assert.strictEqual(ico.readUInt8(6 + 16), 16);
  assert.strictEqual(buildIco([entry(9, 16, 32)], new Map()), null);
});

test('extractBestIconFromExe returns a PNG image as-is and a bitmap icon as an .ico', () => {
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('png-body')]);
  const fromPng = withTempFile(buildFakeExe(png), extractBestIconFromExe);
  assert.strictEqual(fromPng.mime, 'image/png');
  assert.deepStrictEqual(fromPng.data, png);

  const fromBitmap = withTempFile(buildFakeExe(Buffer.from('bitmap-dib-bytes')), extractBestIconFromExe);
  assert.strictEqual(fromBitmap.mime, 'image/x-icon');
  assert.strictEqual(fromBitmap.data.readUInt16LE(2), 1);

  assert.strictEqual(withTempFile(Buffer.from('not an exe'), extractBestIconFromExe), null);
});
