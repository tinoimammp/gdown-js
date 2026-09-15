'use strict';

const fs = require('fs');
const path = require('path');
const axios = require('axios');
const cliProgress = require('cli-progress');

/**
 * Try to pull a Google Drive file/folder ID out of a URL, or accept a bare ID.
 */
function extractId(input, { folder = false } = {}) {
  if (!input) return null;

  // Bare ID (letters, digits, - and _, reasonably long, no slashes/params)
  if (/^[a-zA-Z0-9_-]{10,}$/.test(input)) return input;

  const filePatterns = [
    /\/file\/d\/([a-zA-Z0-9_-]+)/, // .../file/d/<id>/view
    /\/uc\?.*[?&]id=([a-zA-Z0-9_-]+)/, // .../uc?id=<id>
    /\/open\?.*[?&]id=([a-zA-Z0-9_-]+)/, // .../open?id=<id>
    /[?&]id=([a-zA-Z0-9_-]+)/, // any ?id=<id>
  ];
  const folderPatterns = [/\/folders\/([a-zA-Z0-9_-]+)/];

  const patterns = folder ? folderPatterns.concat(filePatterns) : filePatterns.concat(folderPatterns);
  for (const p of patterns) {
    const m = input.match(p);
    if (m) return m[1];
  }
  return null;
}

/* ---------------------------------------------------------------- *
 * Minimal cookie jar (axios doesn't persist cookies across requests
 * by itself, and Drive's confirm-token flow relies on cookies).
 * ---------------------------------------------------------------- */
function updateCookieJar(jar, headers) {
  const setCookie = headers['set-cookie'];
  if (!setCookie) return;
  for (const raw of setCookie) {
    const pair = raw.split(';')[0];
    const idx = pair.indexOf('=');
    if (idx === -1) continue;
    jar[pair.slice(0, idx)] = pair.slice(idx + 1);
  }
}

function cookieHeader(jar) {
  const s = Object.entries(jar)
    .map(([k, v]) => `${k}=${v}`)
    .join('; ');
  return s ? { Cookie: s } : {};
}

/* ---------------------------------------------------------------- *
 * When Drive can't scan a large file for viruses, or a link is
 * "shared" rather than public, it serves an HTML page with a form
 * (id="download-form") whose hidden inputs, appended to its action
 * URL, produce the real download link. We parse that generically
 * instead of hardcoding a single "confirm" token, since Google has
 * changed the exact field names over time.
 * ---------------------------------------------------------------- */
function parseConfirmForm(html, baseUrl) {
  const formMatch =
    html.match(/<form[^>]*id=["']download-form["'][^>]*action=["']([^"']+)["'][^>]*>([\s\S]*?)<\/form>/i) ||
    html.match(/<form[^>]*action=["']([^"']+)["'][^>]*id=["']download-form["'][^>]*>([\s\S]*?)<\/form>/i);
  if (!formMatch) return null;

  const action = formMatch[1].replace(/&amp;/g, '&');
  const inputsHtml = formMatch[2];
  const inputRegex = /<input[^>]*name=["']([^"']+)["'][^>]*value=["']([^"']*)["'][^>]*\/?>/gi;

  const url = new URL(action, baseUrl);
  let m;
  while ((m = inputRegex.exec(inputsHtml)) !== null) {
    url.searchParams.set(m[1], m[2]);
  }
  return url.toString();
}

function filenameFromHeaders(headers) {
  const cd = headers['content-disposition'];
  if (!cd) return null;
  let m = cd.match(/filename\*=UTF-8''([^;]+)/i);
  if (m) {
    try {
      return decodeURIComponent(m[1]);
    } catch {
      return m[1];
    }
  }
  m = cd.match(/filename=["']?([^"';]+)["']?/i);
  return m ? m[1] : null;
}

function formatSpeed(bytesPerSecond) {
  if (!isFinite(bytesPerSecond) || bytesPerSecond <= 0) return '0 KB/s';
  const mb = bytesPerSecond / (1024 * 1024);
  if (mb >= 1) return `${mb.toFixed(2)} MB/s`;
  const kb = bytesPerSecond / 1024;
  return `${kb.toFixed(1)} KB/s`;
}

async function streamToString(stream) {
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf-8');
}

/**
 * Download a single file from Google Drive.
 *
 * @param {string} urlOrId - a Drive share URL, a `uc?id=...` URL, or a bare file ID.
 * @param {object} [options]
 * @param {string} [options.output] - output path (defaults to the server-supplied filename, or the file ID).
 * @param {boolean} [options.quiet] - suppress the progress bar / log line.
 * @returns {Promise<string>} resolved output path.
 */
async function download(urlOrId, options = {}) {
  const { output, quiet = false } = options;

  const id = extractId(urlOrId, { folder: false });
  if (!id) {
    throw new Error(`Could not extract a Google Drive file ID from: ${urlOrId}`);
  }

  const jar = {};
  let currentUrl = `https://drive.google.com/uc?id=${id}&export=download`;
  let response;

  for (let attempt = 0; attempt < 5; attempt++) {
    response = await axios.get(currentUrl, {
      responseType: 'stream',
      maxRedirects: 10,
      headers: cookieHeader(jar),
      validateStatus: () => true,
    });
    updateCookieJar(jar, response.headers);

    const contentType = response.headers['content-type'] || '';
    if (!contentType.includes('text/html')) break; // this is the real file stream

    const html = await streamToString(response.data);

    if (response.status >= 400) {
      throw new Error(
        `Google Drive returned HTTP ${response.status} for file ID "${id}". ` +
          `It may be private, deleted, or the ID/URL may be wrong.`
      );
    }
    if (/Quota exceeded/i.test(html)) {
      throw new Error('Download quota exceeded for this file. Try again later, or ask the owner for a fresh copy.');
    }

    const nextUrl = parseConfirmForm(html, currentUrl);
    if (!nextUrl) {
      throw new Error(
        'Could not locate a download link on Google\'s confirmation page. ' +
          'The file may be private (need to be shared with "Anyone with the link"), or Drive\'s page changed.'
      );
    }
    currentUrl = nextUrl;
  }

  const finalContentType = response.headers['content-type'] || '';
  if (finalContentType.includes('text/html')) {
    throw new Error('Failed to get past Google Drive\'s confirmation page after several attempts.');
  }

  const filename = filenameFromHeaders(response.headers) || id;
  const outputPath = output || filename;
  const partPath = outputPath + '.part';

  const dir = path.dirname(outputPath);
  if (dir && dir !== '.') fs.mkdirSync(dir, { recursive: true });

  const resume = options.resume !== false; // resume by default
  let startByte = 0;

  if (resume && fs.existsSync(partPath)) {
    startByte = fs.statSync(partPath).size;
  }

  if (startByte > 0) {
    // We already consumed headers for the no-Range request above; we don't
    // need its body, so drop it and re-request the same URL with Range set.
    response.data.destroy();
    response = await axios.get(currentUrl, {
      responseType: 'stream',
      maxRedirects: 10,
      headers: { ...cookieHeader(jar), Range: `bytes=${startByte}-` },
      validateStatus: () => true,
    });
    updateCookieJar(jar, response.headers);

    if (response.status === 416) {
      // "Range not satisfiable" — the .part file is already complete (or corrupt). Start over.
      if (!quiet) console.log('Existing partial file looks complete or invalid, restarting from scratch.');
      fs.unlinkSync(partPath);
      startByte = 0;
      response = await axios.get(currentUrl, {
        responseType: 'stream',
        maxRedirects: 10,
        headers: cookieHeader(jar),
        validateStatus: () => true,
      });
    } else if (response.status !== 206) {
      // Server ignored Range and sent the whole file (200) — can't safely append, restart clean.
      if (!quiet) console.log('Server does not support resuming this download; starting from scratch.');
      startByte = 0;
    } else if (!quiet) {
      console.log(`Resuming from byte ${startByte}.`);
    }
  }

  let total;
  const contentRange = response.headers['content-range']; // "bytes 1000-1999/2000"
  const rangeMatch = contentRange && contentRange.match(/\/(\d+)$/);
  if (rangeMatch) {
    total = parseInt(rangeMatch[1], 10);
  } else {
    total = startByte + parseInt(response.headers['content-length'] || '0', 10);
  }

  let bar = null;
  if (!quiet) {
    bar = new cliProgress.SingleBar(
      { format: '{bar} {percentage}% | {value}/{total} bytes | {speed}' },
      cliProgress.Presets.shades_classic
    );
    bar.start(total || 0, startByte, { speed: '0 KB/s' });
  }

  let downloaded = startByte;
  const writer = fs.createWriteStream(partPath, { flags: startByte > 0 ? 'a' : 'w' });

  // Speed sampled over a rolling window (not just since the very start),
  // so it reflects current throughput rather than a lifetime average.
  const SPEED_SAMPLE_MS = 400;
  let windowStart = Date.now();
  let windowBytes = 0;
  let currentSpeed = 0;

  await new Promise((resolve, reject) => {
    response.data.on('data', (chunk) => {
      downloaded += chunk.length;
      windowBytes += chunk.length;

      const elapsed = Date.now() - windowStart;
      if (elapsed >= SPEED_SAMPLE_MS) {
        currentSpeed = windowBytes / (elapsed / 1000); // bytes/sec
        windowBytes = 0;
        windowStart = Date.now();
      }

      if (bar) bar.update(downloaded, { speed: formatSpeed(currentSpeed) });
    });
    response.data.on('error', reject);
    writer.on('error', reject);
    writer.on('finish', resolve);
    response.data.pipe(writer);
  });

  if (bar) bar.stop();

  // Only becomes the final filename once fully downloaded — if something
  // fails above, the .part file stays on disk so the next call can resume it.
  fs.renameSync(partPath, outputPath);

  if (!quiet) console.log(`Saved to: ${outputPath}`);

  return outputPath;
}

/* ---------------------------------------------------------------- *
 * Folder download (experimental / best-effort).
 *
 * Google Drive doesn't offer a public, documented endpoint for
 * listing a public folder's contents. gdown itself works around this
 * by scraping a JS variable (`window['_DRIVE_ivd']`) embedded in the
 * folder's HTML page, which holds an escaped JSON blob describing its
 * children. That format is undocumented and Google can change it
 * without notice, so treat this as best-effort, same as upstream gdown.
 * ---------------------------------------------------------------- */
const FOLDER_MIME_TYPE = 'application/vnd.google-apps.folder';

async function fetchFolderEntries(folderId, jar) {
  const url = `https://drive.google.com/drive/folders/${folderId}`;
  const res = await axios.get(url, { headers: cookieHeader(jar), validateStatus: () => true });
  updateCookieJar(jar, res.headers);

  if (res.status >= 400) {
    throw new Error(`Could not open folder "${folderId}" (HTTP ${res.status}). It may not be public.`);
  }

  const html = res.data;
  const match = html.match(/_DRIVE_ivd"\]\s*=\s*'((?:[^'\\]|\\.)*)'/);
  if (!match) {
    throw new Error(
      'Could not find folder listing data in the page. Google may have changed the page format, ' +
        'or the folder is empty/private.'
    );
  }

  let raw;
  try {
    // The blob is a JS string literal (unicode-escaped JSON-ish data).
    raw = JSON.parse(`"${match[1]}"`);
    const data = JSON.parse(raw);
    const entries = data[0] || [];
    return entries.map((e) => ({
      id: e[0],
      name: e[2],
      mimeType: e[3],
    }));
  } catch (err) {
    throw new Error(`Failed to parse folder listing data: ${err.message}`);
  }
}

/**
 * Recursively download a public Google Drive folder.
 *
 * @param {string} urlOrId - a Drive folder URL or bare folder ID.
 * @param {object} [options]
 * @param {string} [options.output] - destination directory (defaults to the folder name, or the folder ID).
 * @param {boolean} [options.quiet]
 */
async function downloadFolder(urlOrId, options = {}) {
  const { output, quiet = false } = options;
  const id = extractId(urlOrId, { folder: true });
  if (!id) throw new Error(`Could not extract a Google Drive folder ID from: ${urlOrId}`);

  const jar = {};
  const rootDir = output || id;
  fs.mkdirSync(rootDir, { recursive: true });

  async function walk(folderId, dir) {
    const entries = await fetchFolderEntries(folderId, jar);
    for (const entry of entries) {
      if (entry.mimeType === FOLDER_MIME_TYPE) {
        const subDir = path.join(dir, entry.name);
        fs.mkdirSync(subDir, { recursive: true });
        if (!quiet) console.log(`Entering folder: ${subDir}`);
        await walk(entry.id, subDir);
      } else {
        const outPath = path.join(dir, entry.name);
        if (!quiet) console.log(`Downloading: ${entry.name}`);
        await download(entry.id, { output: outPath, quiet });
      }
    }
  }

  await walk(id, rootDir);
  return rootDir;
}

module.exports = { download, downloadFolder, extractId };
