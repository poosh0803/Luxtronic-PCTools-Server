'use strict';

// Fills in missing icons for .exe files that were uploaded before icon extraction worked on this
// server (or on a host without PowerShell). Reads each .exe's own icon (src/lib/exeIcon.js) and
// stores it exactly as an upload would.
//
//   node scripts/extract-icons.js            only entries that have an .exe and no icon
//   node scripts/extract-icons.js --all      also redo icons that were extracted earlier
//
// Icons uploaded by hand are never touched.

require('dotenv').config();
const fs = require('fs');
const pool = require('../db/pool');
const apps = require('../src/lib/apps');

async function main() {
  const redoAll = process.argv.includes('--all');
  const { rows } = await pool.query(
    `SELECT id, category, name, file_name, icon_mime, icon_source FROM apps
     WHERE file_name ILIKE '%.exe' AND (icon_source IS DISTINCT FROM 'upload')
       AND ($1::boolean OR icon_mime IS NULL)
     ORDER BY category, lower(name)`,
    [redoAll]
  );

  let done = 0;
  let none = 0;
  for (const app of rows) {
    const exe = apps.packagePath(app.id);
    if (!fs.existsSync(exe)) {
      console.log(`skip   ${app.category}/${app.name}: file missing on disk`);
      continue;
    }
    const mime = await apps.extractAndStoreExeIcon(app.id, exe);
    await pool.query('UPDATE apps SET icon_mime = $1, icon_source = $2, updated_at = now() WHERE id = $3', [
      mime,
      mime ? 'extracted' : null,
      app.id,
    ]);
    if (mime) {
      done++;
      console.log(`icon   ${app.category}/${app.name}`);
    } else {
      none++;
      console.log(`none   ${app.category}/${app.name}: the exe has no icon`);
    }
  }
  console.log(`${rows.length} checked, ${done} icons stored, ${none} without an icon`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
