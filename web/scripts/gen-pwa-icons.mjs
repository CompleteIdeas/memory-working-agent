/* The v2 app's install icons (v2 build, slice P1), drawn from one shape so they always agree: the "memory meter"
 * (five rising bars) on the Instrument palette (web/src/v2/shell/v2.css).
 *
 *   node web/scripts/gen-pwa-icons.mjs        (uses the repo's @napi-rs/canvas; the PNGs are committed)
 *
 * Writes web/public/pwa/:
 *   icon-192.png, icon-512.png                 purpose "any": a rounded tile, light (signal orange, graphite bars)
 *   icon-dark-192.png, icon-dark-512.png       the same on graphite with orange bars (the page's dark-mode icon)
 *   maskable-192.png, maskable-512.png         purpose "maskable": full bleed, the bars inside the 80% safe circle
 *   monochrome-512.png                         purpose "monochrome": white bars on transparent (Android themed icons)
 *   apple-touch-icon.png                       180 px, full bleed (iOS rounds it)
 *   icon.svg                                   the favicon (follows light/dark itself)
 */
import { createCanvas } from '@napi-rs/canvas';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'pwa');
mkdirSync(OUT, { recursive: true });

const ORANGE = '#ec4a18', GRAPHITE = '#1e2127', NIGHT = '#16181c', ORANGE_DARK = '#ff6a33';

/** The bars inside a box of `w` centred at (cx, cy). */
function bars(ctx, cx, cy, w, color) {
  const count = 5, barW = w * 0.13, gap = w * 0.0725;
  const total = count * barW + (count - 1) * gap;
  const x0 = cx - total / 2, base = cy + w * 0.36;
  ctx.fillStyle = color;
  for (let i = 0; i < count; i++) {
    const h = w * (0.28 + i * 0.11);
    const x = x0 + i * (barW + gap), r = barW * 0.22;
    ctx.beginPath(); ctx.roundRect(x, base - h, barW, h, [r, r, 0, 0]); ctx.fill();
  }
}

function png(name, size, draw) {
  const c = createCanvas(size, size);
  const ctx = c.getContext('2d');
  draw(ctx, size);
  writeFileSync(join(OUT, name), c.toBuffer('image/png'));
  console.log(`wrote public/pwa/${name}`);
}

const tile = (bg, fg) => (ctx, s) => {
  ctx.fillStyle = bg; ctx.beginPath(); ctx.roundRect(0, 0, s, s, s * 0.22); ctx.fill();
  bars(ctx, s / 2, s / 2, s * 0.62, fg);
};
const bleed = (bg, fg, glyph) => (ctx, s) => {
  ctx.fillStyle = bg; ctx.fillRect(0, 0, s, s);
  bars(ctx, s / 2, s / 2, s * glyph, fg);
};

for (const s of [192, 512]) {
  png(`icon-${s}.png`, s, tile(ORANGE, GRAPHITE));
  png(`icon-dark-${s}.png`, s, tile(NIGHT, ORANGE_DARK));
  // maskable: the bars stay inside the central 80% circle (the glyph box is 46% of the side)
  png(`maskable-${s}.png`, s, bleed(ORANGE, GRAPHITE, 0.46));
}
png('monochrome-512.png', 512, (ctx, s) => { ctx.clearRect(0, 0, s, s); bars(ctx, s / 2, s / 2, s * 0.46, '#ffffff'); });
png('apple-touch-icon.png', 180, bleed(ORANGE, GRAPHITE, 0.56));

// the favicon: one SVG that follows the system's light/dark
const svgBars = (() => {
  const w = 62, cx = 50, cy = 50, count = 5, barW = w * 0.13, gap = w * 0.0725;
  const total = count * barW + (count - 1) * gap, x0 = cx - total / 2, base = cy + w * 0.36;
  return Array.from({ length: count }, (_, i) => {
    const h = w * (0.28 + i * 0.11);
    return `<rect class="b" x="${(x0 + i * (barW + gap)).toFixed(2)}" y="${(base - h).toFixed(2)}" width="${barW.toFixed(2)}" height="${h.toFixed(2)}" rx="1.6"/>`;
  }).join('');
})();
writeFileSync(join(OUT, 'icon.svg'), `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><style>.t{fill:${ORANGE}}.b{fill:${GRAPHITE}}@media (prefers-color-scheme:dark){.t{fill:${NIGHT}}.b{fill:${ORANGE_DARK}}}</style><rect class="t" width="100" height="100" rx="22"/>${svgBars}</svg>\n`);
console.log('wrote public/pwa/icon.svg');
