// Kopiert statische Renderer-Assets nach dist/ (plattformunabhaengig).
import { cp, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const from = join(root, 'src', 'renderer');
const to = join(root, 'dist', 'renderer');

const ASSETS = ['index.html', 'styles.css', 'splash.html', 'splash.css'];

await mkdir(to, { recursive: true });

for (const asset of ASSETS) {
  await cp(join(from, asset), join(to, asset));
  console.log(`copied  ${asset}`);
}
