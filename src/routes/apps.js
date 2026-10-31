'use strict';

// Downloadable apps (dashboard page public/apps.html). NOT in CONTRACT.md yet -- the client-facing
// part (list + download for the PC client) is still to be agreed. Like the other dashboard
// endpoints these have no auth (LAN-trust). Uploads are raw request bodies (PUT, not multipart)
// so multi-hundred-MB installers stream straight to disk without a body-parsing dependency.

const express = require('express');
const fs = require('fs');
const pool = require('../../db/pool');
const { isValidUuid, isNonEmptyString } = require('../lib/validation');
const apps = require('../lib/apps');

const router = express.Router();

const CATEGORIES = ['app', 'driver', 'tool'];

const COLUMNS =
  'id, category, name, description, version, file_name, file_size, file_sha256, icon_mime, icon_source, created_at, updated_at';

/** null for absent/blank, undefined for invalid (wrong type or too long), else the trimmed text. */
function optionalText(v, max) {
  if (v === undefined || v === null) return null;
  if (typeof v !== 'string') return undefined;
  const t = v.trim();
  return t.length > max ? undefined : t || null;
}

async function loadApp(req, res) {
  const { id } = req.params;
  if (!isValidUuid(id)) {
    res.status(400).json({ error: 'invalid_request', message: 'invalid app id' });
    return null;
  }
  const { rows } = await pool.query(`SELECT ${COLUMNS} FROM apps WHERE id = $1`, [id]);
  if (rows.length === 0) {
    res.status(404).json({ error: 'not_found', message: 'app not found' });
    return null;
  }
  return rows[0];
}

// ?category=app|driver|tool (default app, so the PC client's existing app list is unchanged).
router.get('/api/apps', async (req, res, next) => {
  const category = req.query.category === undefined ? 'app' : req.query.category;
  if (!CATEGORIES.includes(category)) {
    return res.status(400).json({ error: 'invalid_request', message: 'category must be app, driver or tool' });
  }
  try {
    const { rows } = await pool.query(
      `SELECT ${COLUMNS} FROM apps WHERE category = $1 ORDER BY lower(name)`,
      [category]
    );
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

router.post('/api/apps', async (req, res, next) => {
  const body = req.body || {};
  const description = optionalText(body.description, 2000);
  const version = optionalText(body.version, 50);
  const category = body.category === undefined ? 'app' : body.category;
  if (!CATEGORIES.includes(category) || !isNonEmptyString(body.name) || body.name.length > 100 || description === undefined || version === undefined) {
    return res.status(400).json({
      error: 'invalid_request',
      message: 'category must be app, driver or tool; name is required (max 100 chars); description max 2000, version max 50',
    });
  }
  try {
    const { rows } = await pool.query(
      `INSERT INTO apps (name, description, version, category) VALUES ($1, $2, $3, $4) RETURNING ${COLUMNS}`,
      [body.name.trim(), description, version, category]
    );
    res.status(201).json(rows[0]);
  } catch (err) {
    next(err);
  }
});

router.patch('/api/apps/:id', async (req, res, next) => {
  try {
    const app = await loadApp(req, res);
    if (!app) return;
    const body = req.body || {};
    const name = body.name === undefined ? app.name : body.name;
    const description = body.description === undefined ? app.description : optionalText(body.description, 2000);
    const version = body.version === undefined ? app.version : optionalText(body.version, 50);
    if (!isNonEmptyString(name) || name.length > 100 || description === undefined || version === undefined) {
      return res.status(400).json({ error: 'invalid_request', message: 'invalid name, description or version' });
    }
    const { rows } = await pool.query(
      `UPDATE apps SET name = $1, description = $2, version = $3, updated_at = now()
       WHERE id = $4 RETURNING ${COLUMNS}`,
      [name.trim(), description, version, app.id]
    );
    res.json(rows[0]);
  } catch (err) {
    next(err);
  }
});

router.delete('/api/apps/:id', async (req, res, next) => {
  try {
    const app = await loadApp(req, res);
    if (!app) return;
    await pool.query('DELETE FROM apps WHERE id = $1', [app.id]);
    apps.removeAppFiles(app.id);
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

// PUT /api/apps/:id/file?filename=Setup.exe -- raw body is the installer/package. Replaces any
// previous file. For .exe files without a manually uploaded icon, tries to extract one.
router.put('/api/apps/:id/file', async (req, res, next) => {
  try {
    const app = await loadApp(req, res);
    if (!app) return;
    const fileName = apps.sanitizeDownloadName(req.query.filename);
    let saved;
    try {
      saved = await apps.saveStream(req, apps.packagePath(app.id), apps.MAX_UPLOAD_BYTES);
    } catch (err) {
      if (err.code === 'too_large') {
        return res.status(413).json({
          error: 'too_large',
          message: `file exceeds ${apps.MAX_UPLOAD_BYTES / 1024 / 1024} MB limit`,
        });
      }
      throw err;
    }

    let iconMime = app.icon_mime;
    let iconSource = app.icon_source;
    if (/\.exe$/i.test(fileName) && app.icon_source !== 'upload') {
      apps.removeIcons(app.id);
      const ok = await apps.extractExeIcon(apps.packagePath(app.id), apps.iconPath(app.id, 'image/png'));
      iconMime = ok ? 'image/png' : null;
      iconSource = ok ? 'extracted' : null;
    }

    const { rows } = await pool.query(
      `UPDATE apps SET file_name = $1, file_size = $2, file_sha256 = $3, icon_mime = $4,
         icon_source = $5, updated_at = now() WHERE id = $6 RETURNING ${COLUMNS}`,
      [fileName, saved.size, saved.sha256, iconMime, iconSource, app.id]
    );
    res.json(rows[0]);
  } catch (err) {
    next(err);
  }
});

// PUT /api/apps/:id/icon -- raw image body (Content-Type png/jpeg/svg/ico/webp, max 2 MB).
router.put('/api/apps/:id/icon', async (req, res, next) => {
  try {
    const app = await loadApp(req, res);
    if (!app) return;
    const mime = (req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
    if (!apps.ICON_TYPES[mime]) {
      return res.status(415).json({ error: 'invalid_request', message: 'icon must be png, jpeg, svg, ico or webp' });
    }
    apps.removeIcons(app.id);
    try {
      await apps.saveStream(req, apps.iconPath(app.id, mime), apps.MAX_ICON_BYTES);
    } catch (err) {
      if (err.code === 'too_large') {
        return res.status(413).json({ error: 'too_large', message: 'icon exceeds 2 MB' });
      }
      throw err;
    }
    const { rows } = await pool.query(
      `UPDATE apps SET icon_mime = $1, icon_source = 'upload', updated_at = now()
       WHERE id = $2 RETURNING ${COLUMNS}`,
      [mime, app.id]
    );
    res.json(rows[0]);
  } catch (err) {
    next(err);
  }
});

router.get('/api/apps/:id/icon', async (req, res, next) => {
  try {
    const app = await loadApp(req, res);
    if (!app) return;
    if (!app.icon_mime) return res.status(404).json({ error: 'not_found', message: 'app has no icon' });
    const p = apps.iconPath(app.id, app.icon_mime);
    if (!fs.existsSync(p)) return res.status(404).json({ error: 'not_found', message: 'icon file missing' });
    res.type(app.icon_mime);
    // SVG can carry script; sandbox it if someone opens the URL directly.
    res.set('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; sandbox");
    res.set('Cache-Control', 'no-cache');
    fs.createReadStream(p).pipe(res);
  } catch (err) {
    next(err);
  }
});

router.get('/api/apps/:id/download', async (req, res, next) => {
  try {
    const app = await loadApp(req, res);
    if (!app) return;
    const p = apps.packagePath(app.id);
    if (!app.file_name || !fs.existsSync(p)) {
      return res.status(404).json({ error: 'not_found', message: 'app has no uploaded file' });
    }
    res.set('X-File-SHA256', app.file_sha256);
    res.download(p, app.file_name);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
