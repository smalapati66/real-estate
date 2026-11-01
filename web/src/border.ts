import { GRID_SIZE } from "../../shared/constants";

/** Border margin around the board, in board cells. */
export const BORDER_PAD = 12;
const SIZE = GRID_SIZE + BORDER_PAD * 2;
const INK = [0x1d, 0x1c, 0x1a];

/**
 * Paint a hand-drawn frame at the board's own pixel scale: four bowed,
 * wobbly brush strokes that overshoot the corners like a quick sketch.
 * Ink runs right up to the board edge, so there is no undrawable gap and
 * no board cell is ever covered (the board canvas sits on top).
 * Seeded, so every visitor sees the same frame.
 */
export function paintBorder(canvas: HTMLCanvasElement, seed = 7): void {
  canvas.width = canvas.height = SIZE;
  const ctx = canvas.getContext("2d")!;
  const img = ctx.createImageData(SIZE, SIZE);
  const rand = mulberry32(seed);

  // Stroke centrelines sit 4 cells outside the board; the rest of the pad is room for wobble and overshoot.
  const lo = BORDER_PAD - 4, hi = SIZE - 1 - lo;
  const corners: Array<[number, number]> = [[lo, lo], [hi, lo], [hi, hi], [lo, hi]];

  // Solid ink between the centrelines and the board edge.
  for (let y = lo; y <= hi; y++) {
    for (let x = lo; x <= hi; x++) setPixel(img.data, x, y, INK);
  }

  for (let e = 0; e < 4; e++) {
    const [ax, ay] = corners[e], [bx, by] = corners[(e + 1) % 4];
    const len = Math.hypot(bx - ax, by - ay);
    const ux = (bx - ax) / len, uy = (by - ay) / len; // along the edge
    const nx = -uy, ny = ux;                           // across the edge
    const start = -(1 + rand() * 4), end = len + 1 + rand() * 4; // corner overshoot
    const bow = (rand() - 0.5) * 3;
    const phase = rand() * 10, freq = 0.02 + rand() * 0.02;
    for (let s = start; s <= end; s += 0.5) {
      const t = (s - start) / (end - start);
      const wobble = bow * Math.sin(Math.PI * t) + 0.6 * Math.sin(s * freq * 3 + phase);
      // Thicker in the middle, tapering where the "brush" lands and lifts.
      const r = (2.6 + 1.1 * Math.sin(s * freq + phase)) * Math.min(1, t * 8, (1 - t) * 8) + 1;
      stamp(img.data, ax + ux * s + nx * wobble, ay + uy * s + ny * wobble, r);
    }
  }
  ctx.putImageData(img, 0, 0);
}

function stamp(px: Uint8ClampedArray, cx: number, cy: number, r: number): void {
  const x0 = Math.max(0, Math.floor(cx - r)), x1 = Math.min(SIZE - 1, Math.ceil(cx + r));
  const y0 = Math.max(0, Math.floor(cy - r)), y1 = Math.min(SIZE - 1, Math.ceil(cy + r));
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      if ((x - cx) ** 2 + (y - cy) ** 2 > r * r) continue;
      setPixel(px, x, y, INK);
    }
  }
}

function setPixel(px: Uint8ClampedArray, x: number, y: number, [r, g, b]: number[]): void {
  const i = (y * SIZE + x) * 4;
  px[i] = r; px[i + 1] = g; px[i + 2] = b; px[i + 3] = 255;
}

function mulberry32(a: number): () => number {
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
