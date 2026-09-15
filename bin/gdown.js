#!/usr/bin/env node
'use strict';

const { program } = require('commander');
const { download, downloadFolder } = require('../lib/gdown');
const pkg = require('../package.json');

program
  .name('gdown')
  .version(pkg.version)
  .argument('<url_or_id>', 'Google Drive share URL, uc?id=... URL, or a bare file/folder ID')
  .option('-O, --output <path>', 'output file or directory path')
  .option('-q, --quiet', 'suppress progress bar and logs', false)
  .option('--folder', 'treat the input as a folder and download its contents recursively', false)
  .action(async (urlOrId, opts) => {
    try {
      if (opts.folder) {
        await downloadFolder(urlOrId, { output: opts.output, quiet: opts.quiet });
      } else {
        await download(urlOrId, { output: opts.output, quiet: opts.quiet });
      }
    } catch (err) {
      console.error(`Error: ${err.message}`);
      process.exitCode = 1;
    }
  });

program.parse(process.argv);
