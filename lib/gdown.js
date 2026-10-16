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
  // `sourceUrl` lets downloadFolder() point at an export endpoint for
  // Google Docs/Sheets/Slides, which have no original file behind uc?id=.
  let currentUrl = options.sourceUrl || `https://drive.google.com/uc?id=${id}&export=download`;
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
  if (response.status >= 400) {
    response.data.destroy();
    throw new Error(`Google Drive returned HTTP ${response.status} for file ID "${id}".`);
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

// The folder page's `_DRIVE_ivd` blob never lists more than this many children.
const FOLDER_PAGE_LIMIT = 50;

// Google-native files have no original bytes to download, so they must be
// exported to an Office/image format instead.
const EXPORT_FORMATS = {
  'application/vnd.google-apps.document': {
    url: (id) => `https://docs.google.com/document/d/${id}/export?format=docx`,
    ext: '.docx',
  },
  'application/vnd.google-apps.spreadsheet': {
    url: (id) => `https://docs.google.com/spreadsheets/d/${id}/export?format=xlsx`,
    ext: '.xlsx',
  },
  'application/vnd.google-apps.presentation': {
    url: (id) => `https://docs.google.com/presentation/d/${id}/export/pptx`,
    ext: '.pptx',
  },
  'application/vnd.google-apps.drawing': {
    url: (id) => `https://docs.google.com/drawings/d/${id}/export/png`,
    ext: '.png',
  },
};

/**
 * Decode the body of a single-quoted JS string literal. Drive's page uses
 * `\xNN` (which JSON.parse rejects) alongside `\/`, `\\` and `\uNNNN`, so
 * this has to be done in one pass: decoding `\x` first and `\\` later would
 * mangle sequences like `\\x22`.
 */
function unescapeJsString(s) {
  const simple = { n: '\n', r: '\r', t: '\t', b: '\b', f: '\f', v: '\v', 0: '\0' };
  return s.replace(/\\(x[0-9a-fA-F]{2}|u[0-9a-fA-F]{4}|[\s\S])/g, (_, esc) => {
    if (esc.length > 1) return String.fromCharCode(parseInt(esc.slice(1), 16));
    return esc in simple ? simple[esc] : esc;
  });
}

function decodeHtmlEntities(s) {
  return s.replace(/&(#x[0-9a-fA-F]+|#\d+|amp|lt|gt|quot|apos|#39);/g, (_, e) => {
    if (e[0] === '#') {
      return String.fromCodePoint(e[1] === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10));
    }
    return { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }[e];
  });
}

async function fetchFolderPage(folderId, jar) {
  const url = `https://drive.google.com/drive/folders/${folderId}`;
  const res = await axios.get(url, { headers: cookieHeader(jar), validateStatus: () => true });
  updateCookieJar(jar, res.headers);

  if (res.status >= 400) {
    throw new Error(`Could not open folder "${folderId}" (HTTP ${res.status}). It may not be public.`);
  }

  const match = res.data.match(/_DRIVE_ivd['"]\]\s*=\s*'((?:[^'\\]|\\.)*)'/);
  if (!match) {
    throw new Error(
      'Could not find folder listing data in the page. Google may have changed the page format, ' +
        'or the folder is empty/private.'
    );
  }

  try {
    const data = JSON.parse(unescapeJsString(match[1]));
    const entries = (data && data[0]) || [];
    return entries.map((e) => ({ id: e[0], name: e[2], mimeType: e[3] }));
  } catch (err) {
    throw new Error(`Failed to parse folder listing data: ${err.message}`);
  }
}

/**
 * The `embeddedfolderview` page isn't capped at 50 children, but only
 * exposes types indirectly (the folder link, the type-icon URL, or the
 * docs.google.com editor link), so it's used to fill in what the main
 * page left out rather than as the primary source.
 */
async function fetchEmbeddedFolderEntries(folderId, jar) {
  const url = `https://drive.google.com/embeddedfolderview?id=${folderId}`;
  const res = await axios.get(url, { headers: cookieHeader(jar), validateStatus: () => true });
  updateCookieJar(jar, res.headers);
  if (res.status >= 400) throw new Error(`HTTP ${res.status}`);

  const entries = [];
  const chunks = res.data.split('<div class="flip-entry" id="entry-').slice(1);
  for (const chunk of chunks) {
    const id = chunk.match(/^([a-zA-Z0-9_-]+)"/);
    const title = chunk.match(/<div class="flip-entry-title">([^<]*)<\/div>/);
    const href = chunk.match(/<a href="([^"]+)"/);
    if (!id || !title || !href) continue;

    let mimeType;
    const typeIcon = chunk.match(/googleusercontent\.com\/\d+\/type\/([^"]+)"/);
    const editor = href[1].match(/docs\.google\.com\/(document|spreadsheets|presentation|drawings)\//);
    if (/\/drive\/folders\//.test(href[1])) mimeType = FOLDER_MIME_TYPE;
    else if (typeIcon) mimeType = decodeHtmlEntities(typeIcon[1]);
    else if (editor) {
      const kind = { document: 'document', spreadsheets: 'spreadsheet', presentation: 'presentation', drawings: 'drawing' };
      mimeType = `application/vnd.google-apps.${kind[editor[1]]}`;
    } else mimeType = 'application/octet-stream';

    entries.push({ id: id[1], name: decodeHtmlEntities(title[1]), mimeType });
  }
  return entries;
}

/**
 * List a folder's direct children. `truncated` is true when the listing may
 * be missing items (the main page hit its 50-item cap and the fallback
 * couldn't fill in the rest).
 */
async function fetchFolderEntries(folderId, jar) {
  const entries = await fetchFolderPage(folderId, jar);
  if (entries.length < FOLDER_PAGE_LIMIT) return { entries, truncated: false };

  let embedded;
  try {
    embedded = await fetchEmbeddedFolderEntries(folderId, jar);
  } catch {
    return { entries, truncated: true };
  }
  const seen = new Set(entries.map((e) => e.id));
  const extra = embedded.filter((e) => !seen.has(e.id));
  return {
    entries: entries.concat(extra),
    // Fewer items than the capped page means the fallback didn't parse
    // properly, so we can't vouch for completeness.
    truncated: embedded.length < entries.length,
    usedFallback: true,
  };
}

/**
 * Make a Drive name safe to use as a single path component.
 */
function sanitizeName(name, fallback) {
  let s = String(name || '')
    // eslint-disable-next-line no-control-regex
    .replace(/[\/\\:*?"<>|\x00-\x1f]/g, '_')
    .replace(/[. ]+$/, '') // Windows silently drops trailing dots/spaces
    .trim();
  if (!s || s === '.' || s === '..') s = fallback;
  return s;
}

/**
 * Return `name`, or `name (1)`, `name (2)`, ... (before the extension for
 * files) so that siblings with the same name don't overwrite each other.
 * Compared case-insensitively, since macOS/Windows filesystems are.
 */
function uniqueName(name, used, { isFolder = false } = {}) {
  const ext = isFolder ? '' : path.extname(name);
  const base = ext ? name.slice(0, -ext.length) : name;
  let candidate = name;
  for (let n = 1; used.has(candidate.toLowerCase()); n++) {
    candidate = `${base} (${n})${ext}`;
  }
  used.add(candidate.toLowerCase());
  return candidate;
}

/**
 * Recursively download a public Google Drive folder.
 *
 * A single file (or subfolder) that fails doesn't stop the rest; failures
 * are summarized at the end and reported by rejecting with an error whose
 * `failures` property lists them.
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
  const failures = [];
  const warnings = [];

  // Listing the root folder is the one failure we can't continue past.
  const root = await fetchFolderEntries(id, jar);
  fs.mkdirSync(rootDir, { recursive: true });

  async function walk(listing, dir) {
    const { entries, truncated, usedFallback } = listing;
    if (truncated) {
      const msg =
        `${dir}: Drive only returned ${entries.length} items for this folder; ` +
        'its contents may be incomplete.';
      warnings.push(msg);
      console.warn(`Warning: ${msg}`);
    } else if (usedFallback && !quiet) {
      console.log(`${dir}: folder page was capped at ${FOLDER_PAGE_LIMIT} items, listed all ${entries.length} via embedded view.`);
    }

    const used = new Set();
    for (const entry of entries) {
      const isFolder = entry.mimeType === FOLDER_MIME_TYPE;
      const exportFormat = EXPORT_FORMATS[entry.mimeType];

      let name = sanitizeName(entry.name, entry.id);
      if (exportFormat && !name.toLowerCase().endsWith(exportFormat.ext)) name += exportFormat.ext;
      const outPath = path.join(dir, uniqueName(name, used, { isFolder }));

      if (isFolder) {
        if (!quiet) console.log(`Entering folder: ${outPath}`);
        try {
          fs.mkdirSync(outPath, { recursive: true });
          await walk(await fetchFolderEntries(entry.id, jar), outPath);
        } catch (err) {
          failures.push({ path: outPath, error: err.message });
          console.error(`Failed to list folder ${outPath}: ${err.message}`);
        }
        continue;
      }

      if (entry.mimeType && entry.mimeType.startsWith('application/vnd.google-apps.') && !exportFormat) {
        const msg = `${outPath}: skipped, ${entry.mimeType} can't be downloaded or exported.`;
        warnings.push(msg);
        if (!quiet) console.log(`Skipping: ${msg}`);
        continue;
      }

      if (!quiet) console.log(`Downloading: ${outPath}${exportFormat ? ' (exported)' : ''}`);
      try {
        await download(entry.id, {
          output: outPath,
          quiet,
          sourceUrl: exportFormat ? exportFormat.url(entry.id) : undefined,
        });
      } catch (err) {
        failures.push({ path: outPath, error: err.message });
        console.error(`Failed: ${outPath}: ${err.message}`);
      }
    }
  }

  await walk(root, rootDir);

  if (warnings.length || failures.length) {
    console.warn('\nSummary:');
    for (const w of warnings) console.warn(`  warning: ${w}`);
    for (const f of failures) console.warn(`  failed:  ${f.path}: ${f.error}`);
  }
  if (failures.length) {
    const err = new Error(`${failures.length} item(s) failed to download into ${rootDir}.`);
    err.failures = failures;
    err.output = rootDir;
    throw err;
  }
  return rootDir;
}

module.exports = { download, downloadFolder, extractId };
