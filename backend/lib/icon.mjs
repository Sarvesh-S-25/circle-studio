// The Circle Studio icon (the logo's ring and bead) as a Windows .ico, drawn in code so no binary is kept in the repo.
import fs from 'node:fs';
import path from 'node:path';

// One pixel of the logo (frontend/logo.svg, a 20x20 box): off-white disc, teal ring open at the top right, gold bead.
function pixel(x, y) {
  const dx = x - 10, dy = y - 10, d = Math.hypot(dx, dy);
  const ang = Math.atan2(dy, dx) * 180 / Math.PI;
  const bead = Math.hypot(x - 14.95, y - 5.05) <= 1.7;
  if (bead) return [0x00, 0x57, 0x71, 255];
  const inGap = ang > -72.4 && ang < -17.6;
  if (Math.abs(d - 7) <= 0.75 && !inGap) return [0x73, 0x6e, 0x01, 255];
  if (d <= 9.8) return [0xf2, 0xf6, 0xf7, 255];
  return [0, 0, 0, 0];
}

function bitmap(size) {
  const ss = 4; // 4x4 samples per pixel, for smooth edges
  const px = Buffer.alloc(size * size * 4);
  for (let row = 0; row < size; row++) {
    for (let col = 0; col < size; col++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let sy = 0; sy < ss; sy++) for (let sx = 0; sx < ss; sx++) {
        const [pb, pg, pr, pa] = pixel(((col + (sx + 0.5) / ss) / size) * 20, ((row + (sy + 0.5) / ss) / size) * 20);
        b += pb * pa; g += pg * pa; r += pr * pa; a += pa;
      }
      const n = ss * ss;
      const o = ((size - 1 - row) * size + col) * 4; // bottom-up rows
      px[o] = a ? Math.round(b / a) : 0; px[o + 1] = a ? Math.round(g / a) : 0; px[o + 2] = a ? Math.round(r / a) : 0; px[o + 3] = Math.round(a / n);
    }
  }
  const head = Buffer.alloc(40);
  head.writeUInt32LE(40, 0); head.writeInt32LE(size, 4); head.writeInt32LE(size * 2, 8); head.writeUInt16LE(1, 12); head.writeUInt16LE(32, 14);
  head.writeUInt32LE(px.length, 20);
  return Buffer.concat([head, px, Buffer.alloc(size * Math.ceil(size / 32) * 4)]); // then an all-zero AND mask
}

export function ico(sizes) {
  const images = sizes.map(bitmap);
  const dir = Buffer.alloc(6 + 16 * sizes.length);
  dir.writeUInt16LE(1, 2); dir.writeUInt16LE(sizes.length, 4);
  let offset = dir.length;
  sizes.forEach((s, i) => {
    const e = 6 + 16 * i;
    dir[e] = s; dir[e + 1] = s; dir.writeUInt16LE(1, e + 4); dir.writeUInt16LE(32, e + 6);
    dir.writeUInt32LE(images[i].length, e + 8); dir.writeUInt32LE(offset, e + 12);
    offset += images[i].length;
  });
  return Buffer.concat([dir, ...images]);
}

/** Write data/circle-studio.ico (16 to 64 px) and return its path. */
export function writeIcon(dataDir) {
  const p = path.join(dataDir, 'circle-studio.ico');
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(p, ico([16, 32, 48, 64]));
  return p;
}
