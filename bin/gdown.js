#!/usr/bin/env node
'use strict';

const readline = require('readline');
const { program } = require('commander');
const { download, downloadFolder, isFolderUrl } = require('../lib/gdown');
const pkg = require('../package.json');

// Without -O, everything lands inside this directory (under its original
// name) instead of being scattered across the current directory.
const DEFAULT_OUTPUT_DIR = 'out/';

async function run(urlOrId, opts) {
  const output = opts.output || DEFAULT_OUTPUT_DIR;
  // Folder links are recognized automatically; --folder is only needed for bare folder IDs.
  if (opts.folder || isFolderUrl(urlOrId)) {
    await downloadFolder(urlOrId, { output, quiet: opts.quiet });
  } else {
    await download(urlOrId, { output, quiet: opts.quiet });
  }
}

function ask(question) {
  // A fresh interface per question, so it isn't holding the terminal while
  // the progress bar draws.
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    // close() fires the 'close' handler synchronously, so the answer has to
    // be resolved first or it would be swallowed as a Ctrl+D/Ctrl+C.
    rl.question(question, (answer) => {
      resolve(answer);
      rl.close();
    });
    rl.on('close', () => resolve(null)); // Ctrl+D / Ctrl+C
  });
}

/**
 * No link given: keep asking for links and downloading each one, until an
 * empty line (or Ctrl+C/Ctrl+D).
 */
async function interactive(opts) {
  console.log('Paste a Google Drive file or folder link and press Enter. Empty line to quit.');
  for (;;) {
    const answer = await ask('\nLink: ');
    const input = answer && answer.trim();
    if (!input) break;
    try {
      await run(input, opts);
    } catch (err) {
      console.error(`Error: ${err.message}`);
      process.exitCode = 1;
    }
  }
}

program
  .name('gdown')
  .version(pkg.version)
  .argument('[url_or_id]', 'Google Drive share URL, uc?id=... URL, or a bare file/folder ID (omit to be prompted)')
  .option(
    '-O, --output <path>',
    `output file or directory path (end with / to save inside a directory; default: ${DEFAULT_OUTPUT_DIR})`
  )
  .option('-q, --quiet', 'suppress progress bar and logs', false)
  .option('--folder', 'treat the input as a folder (only needed for bare folder IDs)', false)
  .action(async (urlOrId, opts) => {
    if (!urlOrId) {
      if (!process.stdin.isTTY) {
        program.error('error: missing link (pass it as an argument, or run in a terminal to be prompted)');
      }
      await interactive(opts);
      return;
    }
    try {
      await run(urlOrId, opts);
    } catch (err) {
      console.error(`Error: ${err.message}`);
      process.exitCode = 1;
    }
  });

program.parse(process.argv);
