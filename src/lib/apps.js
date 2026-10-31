'use strict';

// Storage helpers for the downloadable-apps feature (public/apps.html, src/routes/apps.js).
// Each app gets a directory APPS_DIR/<id>/ holding `package` (the uploaded file, stored under a
// fixed name; the original name is kept in the DB for the download) and `icon.<ext>`.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { Transform } = require('stream');
const { pipeline } = require('stream/promises');
const { execFile } = require('child_process');

const APPS_DIR = path.resolve(
  __dirname, '..', '..', process.env.APPS_DIR || path.join('data', 'apps')
);
const MAX_UPLOAD_BYTES = (Number(process.env.MAX_APP_UPLOAD_MB) || 2048) * 1024 * 1024;
const MAX_ICON_BYTES = 2 * 1024 * 1024;

const ICON_TYPES = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/svg+xml': 'svg',
  'image/x-icon': 'ico',
  'image/vnd.microsoft.icon': 'ico',
  'image/webp': 'webp',
};

function appDir(id) {
  return path.join(APPS_DIR, id);
}

function packagePath(id) {
  return path.join(appDir(id), 'package');
}

function iconPath(id, mime) {
  return path.join(appDir(id), `icon.${ICON_TYPES[mime]}`);
}

/** Strips path parts and characters Windows/HTTP headers dislike from a client-supplied name. */
function sanitizeDownloadName(name) {
  const base = String(name || '').split(/[\\/]/).pop().replace(/[<>:"|?*\x00-\x1f]/g, '_').trim();
  return base.slice(0, 200) || 'download';
}

/**
 * Streams `source` to `destPath` (via a temp file + rename, so a failed/aborted upload never
 * replaces a good file), computing size and SHA-256 on the way. Rejects with err.code
 * 'too_large' past maxBytes.
 * @returns {Promise<{ size: number, sha256: string }>}
 */
async function saveStream(source, destPath, maxBytes) {
  fs.mkdirSync(path.dirname(destPath), { recursive: true });
  const tmpPath = `${destPath}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  const hash = crypto.createHash('sha256');
  let size = 0;
  const meter = new Transform({
    transform(chunk, enc, cb) {
      size += chunk.length;
      if (size > maxBytes) {
        const err = new Error('upload too large');
        err.code = 'too_large';
        return cb(err);
      }
      hash.update(chunk);
      cb(null, chunk);
    },
  });
  try {
    await pipeline(source, meter, fs.createWriteStream(tmpPath));
    fs.renameSync(tmpPath, destPath);
    return { size, sha256: hash.digest('hex') };
  } catch (err) {
    fs.rmSync(tmpPath, { force: true });
    throw err;
  }
}

/**
 * Best-effort: pulls the icon out of an .exe as PNG using Windows' System.Drawing (32x32 --
 * ExtractAssociatedIcon's native size). Resolves true on success, false on any failure
 * (non-Windows host, no embedded icon, PowerShell missing); callers fall back to a manual upload.
 */
function extractExeIcon(exePath, outPngPath) {
  if (process.platform !== 'win32') return Promise.resolve(false);
  const script =
    'Add-Type -AssemblyName System.Drawing;' +
    '$i=[System.Drawing.Icon]::ExtractAssociatedIcon($env:LUX_EXE);' +
    'if($i -eq $null){exit 1};' +
    '$i.ToBitmap().Save($env:LUX_OUT,[System.Drawing.Imaging.ImageFormat]::Png)';
  return new Promise((resolve) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', script],
      { env: { ...process.env, LUX_EXE: exePath, LUX_OUT: outPngPath }, timeout: 15000, windowsHide: true },
      (err) => resolve(!err && fs.existsSync(outPngPath))
    );
  });
}

function removeIcons(id) {
  const dir = appDir(id);
  if (!fs.existsSync(dir)) return;
  for (const f of fs.readdirSync(dir)) if (f.startsWith('icon.')) fs.rmSync(path.join(dir, f), { force: true });
}

function removeAppFiles(id) {
  fs.rmSync(appDir(id), { recursive: true, force: true });
}

module.exports = {
  APPS_DIR, MAX_UPLOAD_BYTES, MAX_ICON_BYTES, ICON_TYPES,
  appDir, packagePath, iconPath, sanitizeDownloadName,
  saveStream, extractExeIcon, removeIcons, removeAppFiles,
};
