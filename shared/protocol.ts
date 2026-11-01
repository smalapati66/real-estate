import { CELL_COUNT, FRAME_SNAPSHOT, FRAME_UPDATE } from "./constants";
import type { Rgb } from "./color";

// ---------------------------------------------------------------------------
// Client -> server: small JSON text frames.
// ---------------------------------------------------------------------------

export type ClientMessage =
  /** First frame on every connection. Omit `token` to request a new identity. */
  | { t: "hello"; token?: string }
  /** A batch of brush samples: flat integer cell coordinates [x0,y0,x1,y1,...]. */
  | { t: "draw"; seq: number; pts: number[] }
  /** Ask for a fresh snapshot (sent when a revision gap is detected). */
  | { t: "sync" };

// ---------------------------------------------------------------------------
// Server -> client: JSON text frames for control, binary frames for pixels.
// ---------------------------------------------------------------------------

export type ServerMessage =
  | { t: "welcome"; id: number; color: Rgb; token: string }
  /** Sent to the drawing socket after its batch was applied (or rejected). */
  | { t: "ack"; seq: number; ok: boolean }
  | { t: "presence"; n: number }
  | { t: "error"; code: ErrorCode };

export type ErrorCode = "bad_message" | "not_ready" | "rate_limited" | "busy" | "full";

/** A run of consecutive cell indices [start, start+length). */
export interface Run { start: number; length: number }

export interface Snapshot {
  revision: number;
  palette: Map<number, Rgb>;
  owners: Uint16Array;
}

export interface Update {
  revision: number;
  owner: number;
  color: Rgb;
  runs: Run[];
}

// All binary frames are little-endian.
//
// Snapshot: u8 type | u32 revision | u16 paletteLen | paletteLen * (u16 id, u8 r, u8 g, u8 b)
//           | u32 runCount | runCount * (u16 owner, u16 length-1)
// Update:   u8 type | u32 revision | u16 owner | u8 r, u8 g, u8 b
//           | u16 runCount | runCount * (u16 start, u16 length-1)

export function encodeSnapshot(revision: number, owners: Uint16Array, palette: Map<number, Rgb>): ArrayBuffer {
  // Run-length encode the owner grid; mostly-empty or blobby boards compress well.
  const runOwners: number[] = [];
  const runLengths: number[] = [];
  let current = owners[0], length = 0;
  for (let i = 0; i < owners.length; i++) {
    if (owners[i] === current && length < 0x10000) {
      length++;
    } else {
      runOwners.push(current); runLengths.push(length);
      current = owners[i]; length = 1;
    }
  }
  runOwners.push(current); runLengths.push(length);

  const size = 1 + 4 + 2 + palette.size * 5 + 4 + runOwners.length * 4;
  const buf = new ArrayBuffer(size);
  const v = new DataView(buf);
  let o = 0;
  v.setUint8(o, FRAME_SNAPSHOT); o += 1;
  v.setUint32(o, revision, true); o += 4;
  v.setUint16(o, palette.size, true); o += 2;
  for (const [id, rgb] of palette) {
    v.setUint16(o, id, true);
    v.setUint8(o + 2, (rgb >> 16) & 0xff);
    v.setUint8(o + 3, (rgb >> 8) & 0xff);
    v.setUint8(o + 4, rgb & 0xff);
    o += 5;
  }
  v.setUint32(o, runOwners.length, true); o += 4;
  for (let i = 0; i < runOwners.length; i++) {
    v.setUint16(o, runOwners[i], true);
    v.setUint16(o + 2, runLengths[i] - 1, true);
    o += 4;
  }
  return buf;
}

export function decodeSnapshot(buf: ArrayBuffer): Snapshot {
  const v = new DataView(buf);
  let o = 0;
  if (v.getUint8(o) !== FRAME_SNAPSHOT) throw new Error("not a snapshot");
  o += 1;
  const revision = v.getUint32(o, true); o += 4;
  const paletteLen = v.getUint16(o, true); o += 2;
  const palette = new Map<number, Rgb>();
  for (let i = 0; i < paletteLen; i++) {
    palette.set(v.getUint16(o, true), (v.getUint8(o + 2) << 16) | (v.getUint8(o + 3) << 8) | v.getUint8(o + 4));
    o += 5;
  }
  const runCount = v.getUint32(o, true); o += 4;
  const owners = new Uint16Array(CELL_COUNT);
  let cell = 0;
  for (let i = 0; i < runCount; i++) {
    const owner = v.getUint16(o, true);
    const length = v.getUint16(o + 2, true) + 1;
    o += 4;
    if (cell + length > CELL_COUNT) throw new Error("snapshot overflows grid");
    owners.fill(owner, cell, cell + length);
    cell += length;
  }
  if (cell !== CELL_COUNT) throw new Error("snapshot does not cover grid");
  return { revision, palette, owners };
}

/** Collapse a sorted list of cell indices into runs. */
export function toRuns(sortedCells: ArrayLike<number>): Run[] {
  const runs: Run[] = [];
  for (let i = 0; i < sortedCells.length; i++) {
    const c = sortedCells[i];
    const last = runs[runs.length - 1];
    if (last && last.start + last.length === c) last.length++;
    else runs.push({ start: c, length: 1 });
  }
  return runs;
}

export function encodeUpdate(u: Update): ArrayBuffer {
  const buf = new ArrayBuffer(1 + 4 + 2 + 3 + 2 + u.runs.length * 4);
  const v = new DataView(buf);
  v.setUint8(0, FRAME_UPDATE);
  v.setUint32(1, u.revision, true);
  v.setUint16(5, u.owner, true);
  v.setUint8(7, (u.color >> 16) & 0xff);
  v.setUint8(8, (u.color >> 8) & 0xff);
  v.setUint8(9, u.color & 0xff);
  v.setUint16(10, u.runs.length, true);
  let o = 12;
  for (const r of u.runs) {
    v.setUint16(o, r.start, true);
    v.setUint16(o + 2, r.length - 1, true);
    o += 4;
  }
  return buf;
}

export function decodeUpdate(buf: ArrayBuffer): Update {
  const v = new DataView(buf);
  if (v.getUint8(0) !== FRAME_UPDATE) throw new Error("not an update");
  const runCount = v.getUint16(10, true);
  const runs: Run[] = [];
  for (let i = 0, o = 12; i < runCount; i++, o += 4) {
    const start = v.getUint16(o, true);
    const length = v.getUint16(o + 2, true) + 1;
    if (start + length > CELL_COUNT) throw new Error("update overflows grid");
    runs.push({ start, length });
  }
  return {
    revision: v.getUint32(1, true),
    owner: v.getUint16(5, true),
    color: (v.getUint8(7) << 16) | (v.getUint8(8) << 8) | v.getUint8(9),
    runs,
  };
}

export function frameType(buf: ArrayBuffer): number {
  return buf.byteLength > 0 ? new DataView(buf).getUint8(0) : -1;
}
