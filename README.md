# gdown-js

[![license](https://img.shields.io/badge/license-MIT-blue.svg)](#license)

Download files and folders from Google Drive, right from Node.js — no
browser, no OAuth app registration, no API key.

`gdown-js` is a Node.js package inspired by the Python
[`gdown`](https://github.com/wkentaro/gdown) by [@wkentaro](https://github.com/wkentaro).
It isn't a line-by-line port — Node handles HTTP, streams, and CLI parsing
differently from Python — but it aims for the same experience: paste a
share link, get your file, and don't get stuck on Drive's virus-scan warning
page for large files.

![Sample successful download](assets/sample-download.jpeg)

## Why

Google Drive shows an HTML "Google Drive can't scan this file for viruses"
interstitial for files it can't scan (usually anything large). A plain
`fetch`/`curl`/`axios` request against a share link just downloads that
HTML page instead of your file. `gdown-js` detects the interstitial and
automatically resubmits its hidden form fields — both the classic
`confirm=<token>` cookie style and the newer `uuid`-based form — to reach
the real file.

## Features

- Accepts a full share URL (`.../file/d/<id>/view`), a `uc?id=...` URL, an
  `open?id=...` URL, or a bare file ID.
- Automatically works around the large-file confirmation page.
- Streams straight to disk with a progress bar — never buffers the whole
  file in memory.
- Picks up the real filename from the `Content-Disposition` header when you
  don't pass `-O`.
- Experimental recursive folder download.
- Usable as a CLI (`gdown`) or as a library in your own Node scripts.

## Installation

This package isn't published to npm yet — install it from a local clone:

```bash
git clone https://github.com/tinoimammp/gdown-js.git
cd gdown-js
npm install
npm link   # optional: makes the `gdown` command available globally
```

## Usage

### Command line

The easiest way: run `gdown` with no arguments, then paste links one at a
time. File and folder links are detected automatically. Press Enter on an
empty line to quit.

Unless you pass `-O`, every download goes into `./out/` under its original
name (for a folder, its name on Drive), so nothing gets scattered across the
current directory.

```
$ gdown
Paste a Google Drive file or folder link and press Enter. Empty line to quit.

Link: https://drive.google.com/drive/folders/1FoLdErIDxxxxxxxx
...
Link:
```

Download a file:

```bash
gdown "https://drive.google.com/file/d/1AbCDeFGhIJKlmnop/view?usp=sharing"
```

By bare ID:

```bash
gdown 1AbCDeFGhIJKlmnop
```

Choose the output path, or end it with `/` to save inside a directory under
the original name:

```bash
gdown 1AbCDeFGhIJKlmnop -O myfile.zip
gdown 1AbCDeFGhIJKlmnop -O downloads/
```

Suppress the progress bar and logs:

```bash
gdown 1AbCDeFGhIJKlmnop -q
```

Download a whole public folder (experimental). Folder links are detected
automatically, and the folder is saved as `out/<its name on Drive>`:

```bash
gdown "https://drive.google.com/drive/folders/1FoLdErIDxxxxxxxx"
```

`--folder` is only needed when you pass a bare folder ID:

```bash
gdown --folder 1FoLdErIDxxxxxxxx -O ./out
```

Run a long download in the background with `nohup` (keeps going after you
close the terminal/SSH session — use `-q` since there's no terminal to
render the progress bar to):

```bash
nohup gdown 1AbCDeFGhIJKlmnop -O myfile.zip -q > gdown.log 2>&1 &
```

Check on it later:

```bash
tail -f gdown.log      # follow progress/errors
jobs                    # see if it's still running (same shell session)
```

### As a library

```js
const { download, downloadFolder } = require('./lib/gdown');

await download('https://drive.google.com/file/d/1AbCDeFGhIJKlmnop/view', {
  output: 'myfile.zip',
});

await downloadFolder('1FoLdErIDxxxxxxxx', { output: './out' });
```

## Known limitations

Like upstream `gdown`, this only works against links that are publicly
viewable ("Anyone with the link") — there's no Drive API / OAuth flow here.

- **Folder download is best-effort.** Google doesn't publish a documented
  way to list a public folder's contents by scraping its page; this relies
  on an embedded JS variable (`_DRIVE_ivd`) whose format Google can change
  without notice.
- **Folder pages list at most 50 items.** When a folder hits that cap,
  gdown-js fills in the rest from Drive's `embeddedfolderview` page (tested
  with up to 100 items). If that fallback fails, you get a warning that the
  folder may be incomplete instead of losing files silently.
- **Google Docs/Sheets/Slides/Drawings are exported** as `.docx`/`.xlsx`/
  `.pptx`/`.png`. Other Google-native types (Forms, Sites, shortcuts, ...)
  are skipped with a message.
- In a folder download, a file that fails doesn't stop the rest. Failures
  are listed in a summary at the end, and the command exits non-zero.

## Acknowledgements

This project exists because of the reverse-engineering work done by
[@wkentaro](https://github.com/wkentaro) and contributors on the original
[`gdown`](https://github.com/wkentaro/gdown). If `gdown-js` is useful to
you, consider checking out (and supporting) the upstream project too.

## License

MIT
