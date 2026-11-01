import { BRUSH_RADIUS, GRID_SIZE } from "./constants";

/**
 * Visit every cell covered by a round brush swept along a polyline.
 *
 * `pts` is a flat list [x0, y0, x1, y1, ...] of integer cell coordinates. A
 * single point stamps one disc. Cell (x, y) is covered when its centre lies
 * within `radius` of some segment. Cells where segments overlap may be visited
 * more than once; callers that care must de-duplicate.
 *
 * The same function runs on the server (authoritative) and in the browser
 * (optimistic preview), so both agree on exactly which cells a stroke covers.
 */
export function forEachBrushCell(
  pts: ArrayLike<number>,
  visit: (index: number) => void,
  radius: number = BRUSH_RADIUS,
): void {
  const n = pts.length >> 1;
  if (n === 0) return;
  const r2 = radius * radius;
  const reach = Math.ceil(radius);
  const segments = Math.max(1, n - 1);
  for (let s = 0; s < segments; s++) {
    const ax = pts[s * 2], ay = pts[s * 2 + 1];
    const bx = n === 1 ? ax : pts[s * 2 + 2];
    const by = n === 1 ? ay : pts[s * 2 + 3];
    const dx = bx - ax, dy = by - ay;
    const len2 = dx * dx + dy * dy;
    const x0 = Math.max(0, Math.min(ax, bx) - reach);
    const x1 = Math.min(GRID_SIZE - 1, Math.max(ax, bx) + reach);
    const y0 = Math.max(0, Math.min(ay, by) - reach);
    const y1 = Math.min(GRID_SIZE - 1, Math.max(ay, by) + reach);
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        // Distance from (x, y) to the closest point on segment a->b.
        let t = len2 === 0 ? 0 : ((x - ax) * dx + (y - ay) * dy) / len2;
        t = t < 0 ? 0 : t > 1 ? 1 : t;
        const ex = ax + t * dx - x, ey = ay + t * dy - y;
        if (ex * ex + ey * ey <= r2) visit(y * GRID_SIZE + x);
      }
    }
  }
}

/** Sum of segment lengths of a flat point list, in cells. */
export function pathLength(pts: ArrayLike<number>): number {
  let total = 0;
  for (let i = 2; i + 1 < pts.length; i += 2) {
    total += Math.hypot(pts[i] - pts[i - 2], pts[i + 1] - pts[i - 1]);
  }
  return total;
}
