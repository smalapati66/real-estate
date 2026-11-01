/** RGB colour packed as 0xRRGGBB. */
export type Rgb = number;

/** Display colour for cells nobody owns (the "paper"). */
export const PAPER_RGB: Rgb = 0xf7f5f0;

/**
 * Deterministic colour for a server-assigned visitor id. Hues advance by the
 * golden angle so consecutive visitors look distinct; saturation and lightness
 * cycle a little so that hue collisions still differ. Lightness stays in a
 * band that reads clearly against the off-white paper.
 *
 * Only the server calls this; clients receive colours in protocol frames.
 */
export function colorForId(id: number): Rgb {
  const h = (id * 137.50776405) % 360;
  const s = [0.72, 0.58, 0.85][id % 3];
  const l = [0.52, 0.42, 0.6, 0.34][Math.floor(id / 3) % 4];
  return hslToRgb(h, s, l);
}

function hslToRgb(h: number, s: number, l: number): Rgb {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const hp = h / 60;
  const x = c * (1 - Math.abs((hp % 2) - 1));
  const [r1, g1, b1] =
    hp < 1 ? [c, x, 0] : hp < 2 ? [x, c, 0] : hp < 3 ? [0, c, x] :
    hp < 4 ? [0, x, c] : hp < 5 ? [x, 0, c] : [c, 0, x];
  const m = l - c / 2;
  const to8 = (v: number) => Math.round((v + m) * 255);
  return (to8(r1) << 16) | (to8(g1) << 8) | to8(b1);
}

export function rgbToHex(rgb: Rgb): string {
  return "#" + rgb.toString(16).padStart(6, "0");
}
