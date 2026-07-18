// One-off generator for installer/assets/fanad.ico (committed — not part of the build pipeline).
// Renders assets/fanad-logo.svg at the standard icon sizes with @resvg/resvg-js and packs them
// into an .ico with PNG-compressed entries (supported since Windows Vista).
// Run from the repo root:  node installer/assets/make-icon.js
import { Resvg } from '@resvg/resvg-js';
import { readFileSync, writeFileSync } from 'node:fs';

const svg = readFileSync('assets/fanad-logo.svg');
const sizes = [16, 24, 32, 48, 64, 128, 256];
const pngs = sizes.map((s) => new Resvg(svg, { fitTo: { mode: 'width', value: s } }).render().asPng());

const header = Buffer.alloc(6);
header.writeUInt16LE(0, 0); // reserved
header.writeUInt16LE(1, 2); // type 1 = icon
header.writeUInt16LE(sizes.length, 4);

let offset = 6 + 16 * sizes.length;
const entries = sizes.map((s, i) => {
  const e = Buffer.alloc(16);
  e.writeUInt8(s === 256 ? 0 : s, 0); // width (0 encodes 256)
  e.writeUInt8(s === 256 ? 0 : s, 1); // height
  e.writeUInt16LE(1, 4); // color planes
  e.writeUInt16LE(32, 6); // bits per pixel
  e.writeUInt32LE(pngs[i].length, 8);
  e.writeUInt32LE(offset, 12);
  offset += pngs[i].length;
  return e;
});

writeFileSync('installer/assets/fanad.ico', Buffer.concat([header, ...entries, ...pngs]));
console.log(`Wrote installer/assets/fanad.ico (${sizes.join(', ')} px)`);
