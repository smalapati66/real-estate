import "./style.css";
import { forEachBrushCell } from "../../shared/brush";
import { PAPER_RGB, rgbToHex, type Rgb } from "../../shared/color";
import {
  CELL_COUNT, GRID_SIZE, MAX_PATH_PER_MESSAGE, MAX_POINTS_PER_MESSAGE, SEND_INTERVAL_MS, UNPAINTED,
} from "../../shared/constants";
import { paintBorder } from "./border";
import { Connection, type ConnectionState } from "./connection";

const WS_URL = import.meta.env.VITE_WS_URL || `ws://${location.hostname}:8787/ws`;

const frame = document.getElementById("frame") as HTMLDivElement;
const boardCanvas = document.getElementById("board") as HTMLCanvasElement;
const previewCanvas = document.getElementById("preview") as HTMLCanvasElement;
const swatch = document.getElementById("swatch") as HTMLSpanElement;
const coverageEl = document.getElementById("coverage") as HTMLSpanElement;
const presentEl = document.getElementById("present") as HTMLSpanElement;
const statusEl = document.getElementById("status") as HTMLSpanElement;

// ---------------------------------------------------------------------------
// Authoritative board (only ever changed by server frames)
// ---------------------------------------------------------------------------

const owners = new Uint16Array(CELL_COUNT);
const palette = new Map<number, Rgb>();
let myId = 0;
let myColor: Rgb = 0;
let myCells = 0;

const boardCtx = boardCanvas.getContext("2d")!;
const boardImage = boardCtx.createImageData(GRID_SIZE, GRID_SIZE);
const boardPx = new Uint32Array(boardImage.data.buffer);
let boardDirty = true;

/** Canvas ImageData is RGBA bytes; on little-endian hosts that is 0xAABBGGRR as a uint32. */
function pixel(rgb: Rgb): number {
  return (0xff000000 | ((rgb & 0xff) << 16) | (rgb & 0xff00) | ((rgb >> 16) & 0xff)) >>> 0;
}
const PAPER_PX = pixel(PAPER_RGB);

function cellPixel(owner: number): number {
  if (owner === UNPAINTED) return PAPER_PX;
  const rgb = palette.get(owner);
  return rgb === undefined ? pixel(0x999999) : pixel(rgb);
}

// ---------------------------------------------------------------------------
// Optimistic preview: our own unacknowledged strokes, drawn on a layer above
// the board and discarded as soon as the server acknowledges them. The board
// layer therefore always converges to the server's order.
// ---------------------------------------------------------------------------

const previewCtx = previewCanvas.getContext("2d")!;
const previewImage = previewCtx.createImageData(GRID_SIZE, GRID_SIZE);
const previewPx = new Uint32Array(previewImage.data.buffer);
let previewDirty = false;

/** Batches sent but not yet acknowledged, keyed by sequence number. */
const pending = new Map<number, number[]>();
let seq = 0;

function stampPreview(pts: number[]): void {
  const c = pixel(myColor);
  forEachBrushCell(pts, (i) => (previewPx[i] = c));
  previewDirty = true;
}

function rebuildPreview(): void {
  previewPx.fill(0);
  for (const pts of pending.values()) stampPreview(pts);
  if (unsent.length) stampPreview(unsent);
  previewDirty = true;
}

// ---------------------------------------------------------------------------
// Pointer input (mouse, touch, pen)
// ---------------------------------------------------------------------------

let activePointer: number | null = null;
let lastPoint: [number, number] | null = null;
/** Points not yet sent: flat [x, y, ...], starting with the previous batch's last point. */
let unsent: number[] = [];

function toCell(e: PointerEvent): [number, number] {
  const r = boardCanvas.getBoundingClientRect();
  const clamp = (v: number) => Math.max(0, Math.min(GRID_SIZE - 1, Math.floor(v)));
  return [clamp(((e.clientX - r.left) / r.width) * GRID_SIZE), clamp(((e.clientY - r.top) / r.height) * GRID_SIZE)];
}

function addPoint([x, y]: [number, number]): void {
  if (lastPoint && lastPoint[0] === x && lastPoint[1] === y) return;
  if (unsent.length === 0 && lastPoint) unsent.push(lastPoint[0], lastPoint[1]);
  unsent.push(x, y);
  stampPreview(lastPoint ? [lastPoint[0], lastPoint[1], x, y] : [x, y]);
  lastPoint = [x, y];
}

previewCanvas.addEventListener("pointerdown", (e) => {
  if (!conn.ready || activePointer !== null) return;
  if (e.pointerType === "mouse" && e.button !== 0) return;
  e.preventDefault();
  previewCanvas.setPointerCapture(e.pointerId);
  activePointer = e.pointerId;
  lastPoint = null;
  unsent = [];
  addPoint(toCell(e));
});

previewCanvas.addEventListener("pointermove", (e) => {
  if (e.pointerId !== activePointer) return;
  e.preventDefault();
  const samples = e.getCoalescedEvents?.() ?? [];
  for (const s of samples.length ? samples : [e]) addPoint(toCell(s));
});

function endStroke(e: PointerEvent): void {
  if (e.pointerId !== activePointer) return;
  flush();
  activePointer = null;
  lastPoint = null;
}
previewCanvas.addEventListener("pointerup", endStroke);
previewCanvas.addEventListener("pointercancel", endStroke);
previewCanvas.addEventListener("contextmenu", (e) => e.preventDefault());
// Belt and braces for browsers that ignore touch-action: never scroll or zoom while drawing.
previewCanvas.addEventListener("touchstart", (e) => e.preventDefault(), { passive: false });
previewCanvas.addEventListener("touchmove", (e) => e.preventDefault(), { passive: false });

/** Send unsent points, split to respect the server's per-message limits. */
function flush(): void {
  if (unsent.length === 0) return;
  if (!conn.ready) {
    abandonStroke();
    return;
  }
  let batch = [unsent[0], unsent[1]];
  let length = 0;
  const sendBatch = () => {
    const s = ++seq;
    if (conn.send({ t: "draw", seq: s, pts: batch })) pending.set(s, batch);
  };
  for (let i = 2; i < unsent.length; i += 2) {
    const seg = Math.hypot(unsent[i] - unsent[i - 2], unsent[i + 1] - unsent[i - 1]);
    if (batch.length / 2 >= MAX_POINTS_PER_MESSAGE || length + seg > MAX_PATH_PER_MESSAGE) {
      sendBatch();
      batch = [unsent[i - 2], unsent[i - 1]];
      length = 0;
    }
    batch.push(unsent[i], unsent[i + 1]);
    length += seg;
  }
  sendBatch();
  unsent = [];
}

setInterval(flush, SEND_INTERVAL_MS);

/** Drop anything in flight. Called on disconnect: offline strokes are never queued. */
function abandonStroke(): void {
  if (activePointer !== null && previewCanvas.hasPointerCapture(activePointer)) {
    previewCanvas.releasePointerCapture(activePointer);
  }
  activePointer = null;
  lastPoint = null;
  unsent = [];
  pending.clear();
  rebuildPreview();
}

// ---------------------------------------------------------------------------
// Server events
// ---------------------------------------------------------------------------

const conn = new Connection(WS_URL, {
  state(state: ConnectionState, detail?: string) {
    frame.dataset.state = state;
    if (state !== "ready") abandonStroke();
    statusEl.textContent =
      state === "ready" ? "" :
      state === "connecting" ? detail ?? "connecting…" :
      `${detail ?? "offline"} · drawing unavailable`;
    if (state !== "ready") presentEl.textContent = "";
  },
  welcome(id, color) {
    myId = id;
    myColor = color;
    swatch.style.background = rgbToHex(color);
  },
  snapshot(s) {
    owners.set(s.owners);
    palette.clear();
    for (const [id, rgb] of s.palette) palette.set(id, rgb);
    palette.set(myId, myColor);
    myCells = 0;
    for (let i = 0; i < CELL_COUNT; i++) {
      boardPx[i] = cellPixel(owners[i]);
      if (owners[i] === myId) myCells++;
    }
    boardDirty = true;
    renderCoverage();
  },
  update(u) {
    palette.set(u.owner, u.color);
    const c = pixel(u.color);
    for (const { start, length } of u.runs) {
      for (let i = start; i < start + length; i++) {
        if (owners[i] === myId) myCells--;
        owners[i] = u.owner;
        boardPx[i] = c;
      }
    }
    if (u.owner === myId) for (const r of u.runs) myCells += r.length;
    boardDirty = true;
    renderCoverage();
  },
  ack(s) {
    // The matching update (if anything changed) arrived just before this ack.
    if (pending.delete(s)) rebuildPreview();
  },
  presence(n) {
    presentEl.textContent = `${n} here`;
  },
});

function renderCoverage(): void {
  coverageEl.textContent = `${((myCells / CELL_COUNT) * 100).toFixed(2)}%`;
}

function frameLoop(): void {
  if (boardDirty) {
    boardCtx.putImageData(boardImage, 0, 0);
    boardDirty = false;
  }
  if (previewDirty) {
    previewCtx.putImageData(previewImage, 0, 0);
    previewDirty = false;
  }
  requestAnimationFrame(frameLoop);
}

paintBorder(document.getElementById("border") as HTMLCanvasElement);
boardPx.fill(PAPER_PX);
requestAnimationFrame(frameLoop);
conn.connect();
