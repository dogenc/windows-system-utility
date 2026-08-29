/**
 * Icon-Generator – ohne externe Bildbibliothek.
 *
 * Quellen:
 *   assets/icon.svg         Detailvariante (Glanz, Vignette, Streiflicht, Praegung)
 *   assets/icon-small.svg   Vereinfachte Variante fuer 16/24/32 px
 *
 * Beide werden in EINEM Offscreen-BrowserWindow gerendert und per
 * `capturePage()` abgenommen. Daraus entstehen:
 *   assets/icon.png   256x256 mit Alphakanal
 *   assets/icon.ico   16, 24, 32, 48, 64, 128, 256 – kleine Groessen aus der
 *                     vereinfachten Quelle, damit sie nicht zu Matsch werden
 *
 * Aufruf:  npm run icon
 */
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const ROOT = path.join(__dirname, '..');
const ASSETS = path.join(ROOT, 'assets');

/** Ab dieser Kantenlaenge wird die Detailvariante benutzt. */
const DETAIL_THRESHOLD = 48;
const SIZES = [16, 24, 32, 48, 64, 128, 256];

/** Packt fertige PNG-Buffer in einen ICO-Container (Vista+ akzeptiert PNG direkt). */
function buildIco(entries) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type: 1 = icon
  header.writeUInt16LE(entries.length, 4);

  const directory = Buffer.alloc(16 * entries.length);
  let offset = header.length + directory.length;

  entries.forEach((entry, index) => {
    const at = index * 16;
    const dimension = entry.size >= 256 ? 0 : entry.size; // 0 steht fuer 256
    directory.writeUInt8(dimension, at + 0); // Breite
    directory.writeUInt8(dimension, at + 1); // Hoehe
    directory.writeUInt8(0, at + 2); // Palettengroesse
    directory.writeUInt8(0, at + 3); // reserved
    directory.writeUInt16LE(1, at + 4); // Farbebenen
    directory.writeUInt16LE(32, at + 6); // Bit pro Pixel
    directory.writeUInt32LE(entry.png.length, at + 8);
    directory.writeUInt32LE(offset, at + 12);
    offset += entry.png.length;
  });

  return Buffer.concat([header, directory, ...entries.map((e) => e.png)]);
}

/** Schreibt eine Renderseite fuer eine SVG-Quelle und gibt ihren Pfad zurueck. */
function writePage(svgFile) {
  const svg = fs.readFileSync(path.join(ASSETS, svgFile), 'utf8');
  const html =
    '<!doctype html><meta charset="utf-8">' +
    '<style>html,body{margin:0;width:256px;height:256px;background:transparent}' +
    'svg{display:block}</style>' +
    svg;

  const page = path.join(ASSETS, `.render-${path.parse(svgFile).name}.html`);
  fs.writeFileSync(page, html, 'utf8');
  return page;
}

app.disableHardwareAcceleration();

app
  .whenReady()
  .then(async () => {
    // WICHTIG: nur EIN Offscreen-Fenster. Ein zweites, nach dem Zerstoeren des
    // ersten angelegtes Offscreen-Fenster scheitert unter Windows reproduzierbar
    // mit ERR_FAILED – stattdessen navigieren wir dasselbe Fenster mehrfach.
    const window = new BrowserWindow({
      width: 256,
      height: 256,
      show: false,
      frame: false,
      transparent: true,
      backgroundColor: '#00000000',
      webPreferences: { offscreen: true, contextIsolation: true, nodeIntegration: false },
    });

    const pages = [];

    /** Navigiert das Fenster zur Quelle und nimmt einen 256x256-Frame ab. */
    async function shoot(svgFile) {
      const page = writePage(svgFile);
      pages.push(page);

      await window.loadURL(pathToFileURL(page).toString());
      // Kurz warten, bis Systemfont geladen und der erste Frame gemalt ist.
      await new Promise((resolve) => setTimeout(resolve, 700));

      const image = await window.webContents.capturePage();
      if (image.isEmpty()) throw new Error(`Offscreen-Capture von ${svgFile} war leer`);
      return image.resize({ width: 256, height: 256, quality: 'best' });
    }

    try {
      const detail = await shoot('icon.svg');
      const small = await shoot('icon-small.svg');

      fs.writeFileSync(path.join(ASSETS, 'icon.png'), detail.toPNG());
      console.log('geschrieben  assets/icon.png   256x256 (Detailvariante)');

      const entries = SIZES.map((size) => {
        const source = size >= DETAIL_THRESHOLD ? detail : small;
        return {
          size,
          png: source.resize({ width: size, height: size, quality: 'best' }).toPNG(),
        };
      });

      fs.writeFileSync(path.join(ASSETS, 'icon.ico'), buildIco(entries));
      console.log(`geschrieben  assets/icon.ico   ${SIZES.join(', ')}`);
      console.log(`             unter ${DETAIL_THRESHOLD}px aus icon-small.svg`);
    } finally {
      window.destroy();
      for (const page of pages) fs.rmSync(page, { force: true });
    }

    app.exit(0);
  })
  .catch((error) => {
    console.error('Icon-Generierung fehlgeschlagen:', error);
    app.exit(1);
  });
