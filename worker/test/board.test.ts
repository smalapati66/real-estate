import { describe, expect, it } from "vitest";
import { forEachBrushCell } from "../../shared/brush";
import { CELL_COUNT, GRID_SIZE } from "../../shared/constants";
import { Board, CHUNK_COUNT } from "../src/board";

const idx = (x: number, y: number) => y * GRID_SIZE + x;
const A = 1, B = 2;

function cellsOf(pts: number[]): Set<number> {
  const s = new Set<number>();
  forEachBrushCell(pts, (i) => s.add(i));
  return s;
}

function totalCount(b: Board): number {
  return b.counts.reduce((sum, n) => sum + n, 0);
}

describe("brush", () => {
  it("stamps a disc of 37 cells for a single tap (radius 3.5)", () => {
    const cells = cellsOf([100, 100]);
    expect(cells.size).toBe(37);
    expect(cells.has(idx(103, 100))).toBe(true);
    expect(cells.has(idx(104, 100))).toBe(false);
    expect(cells.has(idx(103, 103))).toBe(false); // corner is outside the circle
  });

  it("clips at the edges and never wraps to the next row", () => {
    expect(cellsOf([0, 0]).size).toBe(13);
    expect(cellsOf([255, 255]).size).toBe(13);
    const right = cellsOf([255, 10]);
    for (const i of right) expect(i % GRID_SIZE).toBeGreaterThanOrEqual(252);
    const left = cellsOf([0, 10]);
    for (const i of left) expect(i % GRID_SIZE).toBeLessThanOrEqual(3);
  });

  it("covers a fast segment continuously, with a fixed width", () => {
    const cells = cellsOf([10, 50, 200, 50]);
    for (let x = 10; x <= 200; x++) {
      for (let dy = -3; dy <= 3; dy++) expect(cells.has(idx(x, 50 + dy))).toBe(true);
      expect(cells.has(idx(x, 46))).toBe(false);
      expect(cells.has(idx(x, 54))).toBe(false);
    }
  });

  it("covers diagonal jumps without gaps", () => {
    const cells = cellsOf([0, 0, 255, 255]);
    for (let t = 0; t <= 255; t++) expect(cells.has(idx(t, t))).toBe(true);
  });
});

describe("board ownership", () => {
  it("counts coverage against all 65,536 cells", () => {
    const b = new Board();
    expect(b.counts[0]).toBe(CELL_COUNT);
    expect(b.paint(A, [100, 100])).toHaveLength(37);
    expect(b.counts[A]).toBe(37);
    expect(b.coverage(A)).toBeCloseTo(37 / 65536, 12);
    expect(b.counts[0]).toBe(CELL_COUNT - 37);
    expect(totalCount(b)).toBe(CELL_COUNT);
  });

  it("does not increase coverage when repainting your own cells", () => {
    const b = new Board();
    b.paint(A, [20, 20, 80, 20]);
    const before = b.counts[A];
    expect(b.paint(A, [20, 20, 80, 20])).toEqual([]);
    expect(b.paint(A, [50, 20])).toEqual([]);
    expect(b.counts[A]).toBe(before);
  });

  it("de-duplicates cells shared by consecutive segments", () => {
    const b = new Board();
    const changed = b.paint(A, [30, 30, 40, 30, 40, 40, 30, 30]);
    expect(new Set(changed).size).toBe(changed.length);
    expect(b.counts[A]).toBe(changed.length);
  });

  it("transfers ownership: previous owner decrements, new owner increments", () => {
    const b = new Board();
    b.paint(A, [100, 100]);
    const changed = b.paint(B, [102, 100]);
    const overlap = [...cellsOf([100, 100])].filter((i) => cellsOf([102, 100]).has(i)).length;
    expect(changed).toHaveLength(37);
    expect(b.counts[B]).toBe(37);
    expect(b.counts[A]).toBe(37 - overlap);
    expect(b.owners[idx(101, 100)]).toBe(B);
    expect(b.owners[idx(97, 100)]).toBe(A);
    expect(totalCount(b)).toBe(CELL_COUNT);
  });

  it("resolves overlapping strokes by application order", () => {
    const one = new Board();
    one.paint(A, [10, 128, 245, 128]);
    one.paint(B, [128, 10, 128, 245]);
    expect(one.owners[idx(128, 128)]).toBe(B);
    const two = new Board();
    two.paint(B, [128, 10, 128, 245]);
    two.paint(A, [10, 128, 245, 128]);
    expect(two.owners[idx(128, 128)]).toBe(A);
    for (const b of [one, two]) expect(totalCount(b)).toBe(CELL_COUNT);
  });

  it("returns changed cells sorted and only marks touched chunks dirty", () => {
    const b = new Board();
    const changed = b.paint(A, [5, 5, 60, 5]);
    expect(changed).toEqual([...changed].sort((x, y) => x - y));
    const dirty = b.takeDirtyChunks();
    expect(dirty.map(([c]) => c)).toEqual([0]);
    expect(b.hasDirtyChunks()).toBe(false);
  });

  it("round-trips through persisted chunks and recomputes counts", () => {
    const b = new Board();
    b.paint(A, [0, 0, 255, 255]);
    b.paint(B, [0, 255, 255, 0]);
    const chunks = b.takeDirtyChunks();
    expect(chunks).toHaveLength(CHUNK_COUNT);
    const restored = new Board();
    for (const [c, bytes] of chunks) restored.loadChunk(c, bytes);
    restored.recount();
    expect(restored.owners).toEqual(b.owners);
    expect(restored.counts[A]).toBe(b.counts[A]);
    expect(restored.counts[B]).toBe(b.counts[B]);
    expect(restored.counts[0]).toBe(b.counts[0]);
  });

  it("clear() empties the board and marks every chunk dirty", () => {
    const b = new Board();
    b.paint(A, [9, 9]);
    b.takeDirtyChunks();
    b.clear();
    expect(b.counts[A]).toBe(0);
    expect(b.counts[0]).toBe(CELL_COUNT);
    expect(b.takeDirtyChunks()).toHaveLength(CHUNK_COUNT);
  });
});
