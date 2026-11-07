import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { wrapPngAsIco } from './lib/ico.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const SVG_PATH = path.join(ROOT, 'app', 'app', 'icon.svg');
const ICO_PATH = path.join(ROOT, 'app', 'app', 'favicon.ico');
const APPLE_ICON_PATH = path.join(ROOT, 'app', 'app', 'apple-icon.png');
const ICO_SIZE = 32;
const APPLE_ICON_SIZE = 180;

async function main() {
  const svg = fs.readFileSync(SVG_PATH);
  const png = await sharp(svg).resize(ICO_SIZE, ICO_SIZE).png().toBuffer();
  fs.writeFileSync(ICO_PATH, wrapPngAsIco(png, ICO_SIZE));
  console.log(`Wrote ${path.relative(ROOT, ICO_PATH)} (${ICO_SIZE}x${ICO_SIZE} PNG-in-ICO, ${png.length} PNG bytes).`);

  // iOS never crops corners itself off the icon.svg's own rounded rect, so
  // draw the apple-icon full-bleed square-cornered — iOS applies its own mask.
  const appleSquareSvg = fs.readFileSync(SVG_PATH, 'utf8').replace(/rx="\d+(\.\d+)?"/, 'rx="0"');
  const applePng = await sharp(Buffer.from(appleSquareSvg)).resize(APPLE_ICON_SIZE, APPLE_ICON_SIZE).png().toBuffer();
  fs.writeFileSync(APPLE_ICON_PATH, applePng);
  console.log(`Wrote ${path.relative(ROOT, APPLE_ICON_PATH)} (${APPLE_ICON_SIZE}x${APPLE_ICON_SIZE}).`);
}

await main();
