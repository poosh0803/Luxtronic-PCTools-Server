'use strict';

// Helpers shared by the upload pages (apps.html, drivers.html, tools.html, publish.html): error
// banner, formatting, fetchJson, and XHR uploads with a progress bar (#upload-progress).

function showError(message) {
  const box = document.getElementById('error');
  box.textContent = message;
  box.style.display = 'block';
}

function clearError() {
  document.getElementById('error').style.display = 'none';
}

const HTML_ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => HTML_ESCAPES[c]);
}

function fmtDateTime(iso) {
  return iso ? new Date(iso).toLocaleString() : '-';
}

function fmtSize(bytes) {
  if (bytes == null) return '';
  const n = Number(bytes);
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

async function fetchJson(url, options) {
  const res = await fetch(url, options);
  if (!res.ok) {
    let detail = '';
    try {
      detail = (await res.json()).message || '';
    } catch {
      /* ignore */
    }
    throw new Error(`${res.status} ${res.statusText}${detail ? ` -- ${detail}` : ''}`);
  }
  if (res.status === 204) return null;
  return res.json();
}

// XHR rather than fetch so large installers get upload progress.
function putFile(url, file, contentType, label) {
  return new Promise((resolve, reject) => {
    const bar = document.getElementById('upload-bar');
    const wrap = document.getElementById('upload-progress');
    const text = document.getElementById('upload-label');
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', url);
    xhr.setRequestHeader('Content-Type', contentType);
    xhr.upload.onprogress = (e) => {
      if (!e.lengthComputable) return;
      const pct = Math.round((e.loaded / e.total) * 100);
      wrap.style.display = '';
      bar.style.width = `${pct}%`;
      text.textContent = `${label} ${pct}% (${fmtSize(e.loaded)} / ${fmtSize(e.total)})`;
    };
    xhr.onload = () => {
      wrap.style.display = 'none';
      if (xhr.status >= 200 && xhr.status < 300) return resolve(JSON.parse(xhr.responseText));
      let detail = '';
      try {
        detail = JSON.parse(xhr.responseText).message || '';
      } catch {
        /* ignore */
      }
      reject(new Error(`${xhr.status}${detail ? ` -- ${detail}` : ''}`));
    };
    xhr.onerror = () => {
      wrap.style.display = 'none';
      reject(new Error('network error during upload'));
    };
    xhr.send(file);
  });
}

function uploadPackage(id, file) {
  return putFile(
    `/api/apps/${id}/file?filename=${encodeURIComponent(file.name)}`,
    file,
    'application/octet-stream',
    `Uploading ${file.name}`
  );
}

function uploadIcon(id, file) {
  const type = file.type || (/\.ico$/i.test(file.name) ? 'image/x-icon' : '');
  return putFile(`/api/apps/${id}/icon`, file, type, 'Uploading icon');
}
