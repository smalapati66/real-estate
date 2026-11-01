#!/usr/bin/env node
// Live two-client synchronisation check against a running Worker.
//
//   WS_URL=ws://localhost:8787/ws ORIGIN=http://localhost:5173 npm run smoke
//
// Opens two WebSockets with fresh identities, has each draw, and checks both
// receive identical, gap-free updates; then reconnects the first with its
// token and checks it gets the same identity back and a snapshot containing
// its cells. Draws a small mark in the top-left corner of the real board.

const WS_URL = process.env.WS_URL ?? "ws://localhost:8787/ws";
const ORIGIN = process.env.ORIGIN ?? "http://localhost:5173";

function client(token) {
  return new Promise((resolve, reject) => {
    // Node's WebSocket (undici) accepts a `headers` option, which browsers do not need.
    const ws = new WebSocket(WS_URL, { headers: { Origin: ORIGIN } });
    ws.binaryType = "arraybuffer";
    const c = { ws, frames: [], waiters: [] };
    ws.onmessage = (e) => {
      c.frames.push(typeof e.data === "string" ? JSON.parse(e.data) : decode(e.data));
      c.waiters.splice(0).forEach((w) => w());
    };
    ws.onerror = () => reject(new Error(`could not connect to ${WS_URL} (is it running? is ${ORIGIN} allowed?)`));
    ws.onopen = async () => {
      ws.send(JSON.stringify(token ? { t: "hello", token } : { t: "hello" }));
      const w = await next(c, (f) => f.t === "welcome");
      Object.assign(c, { id: w.id, token: w.token, snapshot: await next(c, (f) => f.t === "snapshot") });
      resolve(c);
    };
  });
}

async function next(c, pred, ms = 3000) {
  const deadline = Date.now() + ms;
  for (;;) {
    const i = c.frames.findIndex(pred);
    if (i >= 0) return c.frames.splice(i, 1)[0];
    if (Date.now() > deadline) throw new Error("timeout waiting for frame");
    await new Promise((r) => { c.waiters.push(r); setTimeout(r, 50); });
  }
}

function decode(buf) {
  const v = new DataView(buf);
  const type = v.getUint8(0);
  const revision = v.getUint32(1, true);
  if (type === 2) {
    let cells = 0;
    for (let i = 0, o = 12; i < v.getUint16(10, true); i++, o += 4) cells += v.getUint16(o + 2, true) + 1;
    return { t: "update", revision, owner: v.getUint16(5, true), cells };
  }
  let o = 5 + 2 + v.getUint16(5, true) * 5;
  const runs = v.getUint32(o, true); o += 4;
  const counts = new Map();
  for (let i = 0; i < runs; i++, o += 4) {
    const owner = v.getUint16(o, true);
    counts.set(owner, (counts.get(owner) ?? 0) + v.getUint16(o + 2, true) + 1);
  }
  return { t: "snapshot", revision, counts };
}

function check(cond, msg) {
  if (!cond) { console.error("FAIL", msg); process.exit(1); }
  console.log("ok  ", msg);
}

const a = await client();
const b = await client();
check(a.id !== b.id, `two identities issued (${a.id}, ${b.id})`);

a.ws.send(JSON.stringify({ t: "draw", seq: 1, pts: [4, 4, 20, 4] }));
const ua = await next(a, (f) => f.t === "update");
const ub = await next(b, (f) => f.t === "update");
check(JSON.stringify(ua) === JSON.stringify(ub), `both clients saw A's stroke as revision ${ua.revision}`);

b.ws.send(JSON.stringify({ t: "draw", seq: 1, pts: [12, 0, 12, 10] }));
const ua2 = await next(a, (f) => f.t === "update");
const ub2 = await next(b, (f) => f.t === "update");
check(ua2.revision === ua.revision + 1 && JSON.stringify(ua2) === JSON.stringify(ub2), "B's crossing stroke arrived next, in order, for both");

a.ws.send(JSON.stringify({ t: "sync" }));
const snap = await next(a, (f) => f.t === "snapshot");
const aCells = snap.counts.get(a.id) ?? 0;
const bCells = snap.counts.get(b.id) ?? 0;
check(bCells === ub2.cells && aCells > 0 && aCells < ua.cells, `B's stroke took cells from A (A ${ua.cells} -> ${aCells}, B ${bCells})`);

// Repaint over the crossing: takes back exactly B's overlap; a second identical pass changes nothing.
a.ws.send(JSON.stringify({ t: "draw", seq: 2, pts: [4, 4, 20, 4] }));
const retake = await next(a, (f) => f.t === "update");
await next(a, (f) => f.t === "ack" && f.seq === 2);
check(retake.cells === ua.cells - aCells, `A retook ${retake.cells} overlapped cells`);
a.ws.send(JSON.stringify({ t: "draw", seq: 3, pts: [4, 4, 20, 4] }));
await next(a, (f) => f.t === "ack" && f.seq === 3);
check(!a.frames.some((f) => f.t === "update"), "repainting own cells produced no update");
const ownCells = ua.cells;

a.ws.close();
await new Promise((r) => setTimeout(r, 200));
const again = await client(a.token);
check(again.id === a.id, "reconnect with stored token restores the same identity");
check((again.snapshot.counts.get(a.id) ?? 0) === ownCells, `reconnect snapshot contains all ${ownCells} of A's cells`);

const bad = new WebSocket(WS_URL, { headers: { Origin: "https://evil.example" } });
const rejected = await new Promise((r) => { bad.onerror = () => r(true); bad.onopen = () => r(false); });
check(rejected, "foreign origin is refused");

again.ws.close();
b.ws.close();
console.log("smoke test passed");
