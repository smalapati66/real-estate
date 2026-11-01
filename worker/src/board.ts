import { forEachBrushCell } from "../../shared/brush";
import { CELL_COUNT, MAX_VISITOR_ID, UNPAINTED } from "../../shared/constants";

/** The grid is persisted as this many BLOB rows (16,384 cells = 32 KiB each). */
export const CHUNK_COUNT = 4;
export const CHUNK_CELLS = CELL_COUNT / CHUNK_COUNT;

/**
 * Authoritative in-memory board: who owns each cell, and how many cells each
 * owner has. Pure data structure, no I/O, so it can be unit tested directly.
 *
 * Ownership (visitor ids) is stored separately from display colour; colours
 * are looked up per id only when frames are encoded.
 */
export class Board {
  readonly owners = new Uint16Array(CELL_COUNT);
  /** counts[id] = cells owned by visitor `id`; counts[0] = unpainted cells. */
  readonly counts = new Uint32Array(MAX_VISITOR_ID + 1);
  /** Chunks modified since the last `takeDirtyChunks()`. */
  private readonly dirty = new Set<number>();

  constructor() {
    this.counts[UNPAINTED] = CELL_COUNT;
  }

  /**
   * Paint `owner` along the polyline. Returns the sorted indices of cells whose
   * owner actually changed; repainting your own cells changes nothing.
   */
  paint(owner: number, pts: ArrayLike<number>): number[] {
    if (owner < 1 || owner > MAX_VISITOR_ID) throw new RangeError("bad owner");
    const changed: number[] = [];
    const { owners, counts } = this;
    forEachBrushCell(pts, (i) => {
      const prev = owners[i];
      if (prev === owner) return; // also de-duplicates overlapping segments
      counts[prev]--;
      counts[owner]++;
      owners[i] = owner;
      changed.push(i);
    });
    if (changed.length > 0) {
      changed.sort((a, b) => a - b);
      for (const i of changed) this.dirty.add((i / CHUNK_CELLS) | 0);
    }
    return changed;
  }

  clear(): void {
    this.owners.fill(UNPAINTED);
    this.counts.fill(0);
    this.counts[UNPAINTED] = CELL_COUNT;
    for (let c = 0; c < CHUNK_COUNT; c++) this.dirty.add(c);
  }

  /** Coverage fraction for one owner. The denominator is always all 65,536 cells. */
  coverage(owner: number): number {
    return this.counts[owner] / CELL_COUNT;
  }

  /** Ids with at least one cell, for the snapshot palette. */
  activeOwners(): number[] {
    const ids: number[] = [];
    for (let id = 1; id <= MAX_VISITOR_ID; id++) if (this.counts[id] > 0) ids.push(id);
    return ids;
  }

  hasDirtyChunks(): boolean {
    return this.dirty.size > 0;
  }

  /** Returns [chunkIndex, bytes] for each dirty chunk and marks them clean. */
  takeDirtyChunks(): Array<[number, ArrayBuffer]> {
    const out: Array<[number, ArrayBuffer]> = [];
    for (const c of [...this.dirty].sort()) {
      out.push([c, this.chunkBytes(c)]);
    }
    this.dirty.clear();
    return out;
  }

  /** Re-mark chunks dirty (used if a flush fails, so the next one retries). */
  markDirty(chunks: number[]): void {
    for (const c of chunks) this.dirty.add(c);
  }

  chunkBytes(c: number): ArrayBuffer {
    // Explicit little-endian so the stored format does not depend on the host.
    const buf = new ArrayBuffer(CHUNK_CELLS * 2);
    const v = new DataView(buf);
    const base = c * CHUNK_CELLS;
    for (let i = 0; i < CHUNK_CELLS; i++) v.setUint16(i * 2, this.owners[base + i], true);
    return buf;
  }

  /** Load one persisted chunk. Call `recount()` after loading all chunks. */
  loadChunk(c: number, bytes: ArrayBuffer): void {
    if (c < 0 || c >= CHUNK_COUNT || bytes.byteLength !== CHUNK_CELLS * 2) {
      throw new Error(`corrupt chunk ${c}`);
    }
    const v = new DataView(bytes);
    const base = c * CHUNK_CELLS;
    for (let i = 0; i < CHUNK_CELLS; i++) this.owners[base + i] = v.getUint16(i * 2, true);
  }

  /** Rebuild counts from the grid. Counts are derived, never persisted, so they cannot drift. */
  recount(): void {
    this.counts.fill(0);
    for (let i = 0; i < CELL_COUNT; i++) this.counts[this.owners[i]]++;
  }
}
