'use strict';

// Pulls the application icon out of a Windows .exe on any OS (the LAN box runs Linux, where the
// PowerShell/System.Drawing route in lib/apps.js can't work). A PE file keeps its icons as
// resources: RT_GROUP_ICON lists a set of images, RT_ICON holds each image. An .ico file is just
// that directory plus the images, so no image decoding is needed -- the images are copied as they
// are (BMP or PNG inside) and the browsers and WPF read the result as a normal icon.
//
// Only the headers and the icon blobs are read (positional reads), never the whole file: installers
// here can be close to 1 GB.

const fs = require('fs');

const RT_ICON = 3;
const RT_GROUP_ICON = 14;
const MAX_ICON_BYTES = 4 * 1024 * 1024; // sanity cap on one image / the group directory
const MAX_DIR_ENTRIES = 512;

class Reader {
  constructor(fd, size) {
    this.fd = fd;
    this.size = size;
  }

  read(offset, length) {
    if (offset < 0 || length < 0 || offset + length > this.size) throw new Error('read outside the file');
    const buf = Buffer.alloc(length);
    const got = fs.readSync(this.fd, buf, 0, length, offset);
    if (got !== length) throw new Error('short read');
    return buf;
  }
}

/** Maps a relative virtual address to a file offset using the section table. */
function makeRvaToOffset(sections) {
  return (rva) => {
    for (const s of sections) {
      const span = Math.max(s.virtualSize, s.rawSize);
      if (rva >= s.virtualAddress && rva < s.virtualAddress + span) return s.rawPointer + (rva - s.virtualAddress);
    }
    throw new Error('RVA not in any section');
  };
}

/** Reads one resource directory: its entries as { id, named, target, isDir }. */
function readDirectory(reader, resBase, dirOffset) {
  const header = reader.read(resBase + dirOffset, 16);
  const count = header.readUInt16LE(12) + header.readUInt16LE(14);
  if (count > MAX_DIR_ENTRIES) throw new Error('implausible resource directory');
  const entries = [];
  const raw = reader.read(resBase + dirOffset + 16, count * 8);
  for (let i = 0; i < count; i++) {
    const nameOrId = raw.readUInt32LE(i * 8);
    const offset = raw.readUInt32LE(i * 8 + 4);
    entries.push({
      named: (nameOrId & 0x80000000) !== 0,
      id: nameOrId & 0x7fffffff,
      isDir: (offset & 0x80000000) !== 0,
      target: offset & 0x7fffffff,
    });
  }
  return entries;
}

/** Follows name -> language levels down to the first data entry; returns { fileOffset, size }. */
function firstData(reader, resBase, entry, rvaToOffset) {
  let current = entry;
  for (let depth = 0; depth < 4 && current.isDir; depth++) {
    const children = readDirectory(reader, resBase, current.target);
    if (children.length === 0) throw new Error('empty resource directory');
    current = children[0];
  }
  if (current.isDir) throw new Error('resource tree too deep');
  const data = reader.read(resBase + current.target, 16); // IMAGE_RESOURCE_DATA_ENTRY
  return { fileOffset: rvaToOffset(data.readUInt32LE(0)), size: data.readUInt32LE(4) };
}

/** Builds an .ico from the group directory and the individual images, largest image first. */
function buildIco(groupEntries, imageBlobs) {
  const usable = groupEntries
    .filter((e) => imageBlobs.has(e.id))
    .sort((a, b) => b.width * b.height - a.width * a.height || b.bitCount - a.bitCount);
  if (usable.length === 0) return null;

  const header = Buffer.alloc(6 + usable.length * 16);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type: icon
  header.writeUInt16LE(usable.length, 4);

  let offset = header.length;
  const parts = [header];
  usable.forEach((e, i) => {
    const blob = imageBlobs.get(e.id);
    const at = 6 + i * 16;
    header.writeUInt8(e.width >= 256 ? 0 : e.width, at); // ICO stores 256 as 0
    header.writeUInt8(e.height >= 256 ? 0 : e.height, at + 1);
    header.writeUInt8(e.colorCount, at + 2);
    header.writeUInt8(0, at + 3);
    header.writeUInt16LE(e.planes, at + 4);
    header.writeUInt16LE(e.bitCount, at + 6);
    header.writeUInt32LE(blob.length, at + 8);
    header.writeUInt32LE(offset, at + 12);
    offset += blob.length;
    parts.push(blob);
  });
  return Buffer.concat(parts);
}

/**
 * Reads the .exe's first icon group and its images: { groupEntries, imageBlobs } (see buildIco), or
 * null when it has none or the file is not a PE it understands. Never throws.
 */
function readIconResources(exePath) {
  let fd;
  try {
    fd = fs.openSync(exePath, 'r');
    const reader = new Reader(fd, fs.fstatSync(fd).size);

    const dos = reader.read(0, 64);
    if (dos.toString('latin1', 0, 2) !== 'MZ') return null;
    const peOffset = dos.readUInt32LE(0x3c);
    const coff = reader.read(peOffset, 24);
    if (coff.toString('latin1', 0, 4) !== 'PE\0\0') return null;

    const sectionCount = coff.readUInt16LE(6);
    const optionalSize = coff.readUInt16LE(20);
    if (sectionCount === 0 || sectionCount > 96 || optionalSize < 96) return null;

    const optional = reader.read(peOffset + 24, optionalSize);
    const magic = optional.readUInt16LE(0);
    const dirStart = magic === 0x20b ? 112 : magic === 0x10b ? 96 : -1; // PE32+ / PE32
    if (dirStart < 0 || optionalSize < dirStart + 24) return null;
    const resourceRva = optional.readUInt32LE(dirStart + 16);
    if (resourceRva === 0) return null;

    const table = reader.read(peOffset + 24 + optionalSize, sectionCount * 40);
    const sections = [];
    for (let i = 0; i < sectionCount; i++) {
      sections.push({
        virtualSize: table.readUInt32LE(i * 40 + 8),
        virtualAddress: table.readUInt32LE(i * 40 + 12),
        rawSize: table.readUInt32LE(i * 40 + 16),
        rawPointer: table.readUInt32LE(i * 40 + 20),
      });
    }
    const rvaToOffset = makeRvaToOffset(sections);
    const resBase = rvaToOffset(resourceRva);

    const types = readDirectory(reader, resBase, 0);
    const groupType = types.find((t) => !t.named && t.id === RT_GROUP_ICON && t.isDir);
    const iconType = types.find((t) => !t.named && t.id === RT_ICON && t.isDir);
    if (!groupType || !iconType) return null;

    // The exe's icon is the first icon group (what Explorer shows).
    const groups = readDirectory(reader, resBase, groupType.target);
    if (groups.length === 0) return null;
    const groupData = firstData(reader, resBase, groups[0], rvaToOffset);
    if (groupData.size < 6 || groupData.size > MAX_ICON_BYTES) return null;
    const group = reader.read(groupData.fileOffset, groupData.size);
    const count = group.readUInt16LE(4);
    if (count === 0 || 6 + count * 14 > group.length) return null;

    const groupEntries = [];
    for (let i = 0; i < count; i++) {
      const at = 6 + i * 14;
      groupEntries.push({
        width: group.readUInt8(at) || 256,
        height: group.readUInt8(at + 1) || 256,
        colorCount: group.readUInt8(at + 2),
        planes: group.readUInt16LE(at + 4),
        bitCount: group.readUInt16LE(at + 6),
        id: group.readUInt16LE(at + 12),
      });
    }

    const wanted = new Set(groupEntries.map((e) => e.id));
    const imageBlobs = new Map();
    for (const entry of readDirectory(reader, resBase, iconType.target)) {
      if (entry.named || !wanted.has(entry.id)) continue;
      const data = firstData(reader, resBase, entry, rvaToOffset);
      if (data.size === 0 || data.size > MAX_ICON_BYTES) continue;
      imageBlobs.set(entry.id, reader.read(data.fileOffset, data.size));
    }

    return imageBlobs.size > 0 ? { groupEntries, imageBlobs } : null;
  } catch {
    return null;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** The .exe's main icon as an .ico file Buffer (every size), or null. Never throws. */
function extractIcoFromExe(exePath) {
  const resources = readIconResources(exePath);
  return resources ? buildIco(resources.groupEntries, resources.imageBlobs) : null;
}

/**
 * The best single icon for display: { mime, data } or null. The largest image wins. When it is
 * PNG-compressed (Vista-style 256x256 icons) it is returned as a plain PNG -- exact, and browsers
 * refuse an .ico whose directory size disagrees with the PNG inside (some vendors' exes have a
 * 3000x3000 PNG listed as 256x256). Otherwise (old bitmap icons) an .ico with every size is built.
 */
function extractBestIconFromExe(exePath) {
  const resources = readIconResources(exePath);
  if (!resources) return null;

  const { groupEntries, imageBlobs } = resources;
  const largest = groupEntries
    .filter((e) => imageBlobs.has(e.id))
    .sort((a, b) => b.width * b.height - a.width * a.height || b.bitCount - a.bitCount)[0];
  const blob = imageBlobs.get(largest.id);
  if (blob.length > PNG_SIGNATURE.length && blob.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) {
    return { mime: 'image/png', data: blob };
  }
  const ico = buildIco(groupEntries, imageBlobs);
  return ico ? { mime: 'image/x-icon', data: ico } : null;
}

module.exports = { extractIcoFromExe, extractBestIconFromExe, buildIco };
