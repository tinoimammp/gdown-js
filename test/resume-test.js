'use strict';
const http = require('http');
const fs = require('fs');
const crypto = require('crypto');
const axios = require('axios');

// 500KB of deterministic pseudo-random bytes, so we can checksum-compare later.
const FULL_CONTENT = crypto.randomBytes(500 * 1024);

const server = http.createServer((req, res) => {
  const range = req.headers.range; // e.g. "bytes=204800-"
  if (range) {
    const start = parseInt(range.match(/bytes=(\d+)-/)[1], 10);
    if (start >= FULL_CONTENT.length) {
      res.writeHead(416);
      return res.end();
    }
    const chunk = FULL_CONTENT.slice(start);
    res.writeHead(206, {
      'content-range': `bytes ${start}-${FULL_CONTENT.length - 1}/${FULL_CONTENT.length}`,
      'content-length': chunk.length,
    });
    return res.end(chunk);
  }
  res.writeHead(200, { 'content-length': FULL_CONTENT.length });
  res.end(FULL_CONTENT);
});

async function run() {
  await new Promise((r) => server.listen(0, r));
  const port = server.address().port;
  const url = `http://localhost:${port}/file`;
  const partPath = '/tmp/resume-test.part';
  const outputPath = '/tmp/resume-test.out';
  fs.rmSync(partPath, { force: true });
  fs.rmSync(outputPath, { force: true });

  // --- Phase 1: simulate an interrupted download (only write first 40%) ---
  let res1 = await axios.get(url, { responseType: 'stream' });
  const writer1 = fs.createWriteStream(partPath);
  let written = 0;
  const targetPartial = Math.floor(FULL_CONTENT.length * 0.4);
  await new Promise((resolve) => {
    res1.data.on('data', (chunk) => {
      written += chunk.length;
      writer1.write(chunk);
      if (written >= targetPartial) {
        res1.data.destroy();
        writer1.end(resolve);
      }
    });
  });
  const partialSize = fs.statSync(partPath).size;
  console.log(`Phase 1: wrote ${partialSize} bytes (simulated interruption at ~40%)`);

  // --- Phase 2: resume logic, mirroring what lib/gdown.js now does ---
  const startByte = fs.statSync(partPath).size;
  const res2 = await axios.get(url, {
    responseType: 'stream',
    headers: { Range: `bytes=${startByte}-` },
    validateStatus: () => true,
  });

  if (res2.status !== 206) throw new Error(`Expected 206, got ${res2.status}`);
  const cr = res2.headers['content-range'];
  const total = parseInt(cr.match(/\/(\d+)$/)[1], 10);
  if (total !== FULL_CONTENT.length) throw new Error('Total size mismatch from content-range');
  console.log(`Phase 2: server confirmed 206 Partial Content, total=${total}`);

  const writer2 = fs.createWriteStream(partPath, { flags: 'a' });
  await new Promise((resolve, reject) => {
    res2.data.on('error', reject);
    writer2.on('error', reject);
    writer2.on('finish', resolve);
    res2.data.pipe(writer2);
  });

  fs.renameSync(partPath, outputPath);

  // --- Verify integrity ---
  const finalBuf = fs.readFileSync(outputPath);
  const match = Buffer.compare(finalBuf, FULL_CONTENT) === 0;
  console.log(`Phase 3: final file size=${finalBuf.length}, expected=${FULL_CONTENT.length}, byte-for-byte match=${match}`);

  server.close();
  fs.rmSync(outputPath, { force: true });

  if (!match || finalBuf.length !== FULL_CONTENT.length) {
    console.log('RESULT: FAIL');
    process.exit(1);
  }
  console.log('RESULT: PASS — resumed download is byte-identical to a full download');
}

run().catch((err) => {
  console.error('Test error:', err);
  process.exit(1);
});
