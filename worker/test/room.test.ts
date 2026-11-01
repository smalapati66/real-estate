import { abortAllDurableObjects, evictDurableObject, reset } from "cloudflare:test";
import { env, exports } from "cloudflare:workers";
import { afterEach, describe, expect, it } from "vitest";
import { forEachBrushCell } from "../../shared/brush";
import { colorForId } from "../../shared/color";
import { CELL_COUNT, FRAME_SNAPSHOT, FRAME_UPDATE } from "../../shared/constants";
import {
  decodeSnapshot, decodeUpdate, frameType,
  type ServerMessage, type Snapshot, type Update,
} from "../../shared/protocol";

const ORIGIN = "https://art.test";
const ADMIN = "test-admin-token-0123456789abcdefghijkl";

type Frame = { json: ServerMessage } | { snapshot: Snapshot } | { update: Update };

/** A test WebSocket client with an awaitable inbox. */
class Client {
  inbox: Frame[] = [];
  private waiters: Array<() => void> = [];
  id = 0;
  token = "";
  constructor(readonly ws: WebSocket) {
    ws.binaryType = "arraybuffer";
    ws.accept();
    ws.addEventListener("message", (e) => {
      const d = e.data;
      if (typeof d === "string") this.inbox.push({ json: JSON.parse(d) });
      else if (frameType(d as ArrayBuffer) === FRAME_SNAPSHOT) this.inbox.push({ snapshot: decodeSnapshot(d as ArrayBuffer) });
      else if (frameType(d as ArrayBuffer) === FRAME_UPDATE) this.inbox.push({ update: decodeUpdate(d as ArrayBuffer) });
      this.waiters.splice(0).forEach((w) => w());
    });
  }

  /** Wait for (and remove) the first frame matching `pred`. */
  async next<T extends Frame>(pred: (f: Frame) => f is T, ms = 2000): Promise<T> {
    const deadline = Date.now() + ms;
    for (;;) {
      const i = this.inbox.findIndex(pred);
      if (i >= 0) return this.inbox.splice(i, 1)[0] as T;
      if (Date.now() > deadline) throw new Error("timed out; inbox: " + JSON.stringify(this.inbox).slice(0, 300));
      await new Promise<void>((r) => {
        this.waiters.push(r);
        setTimeout(r, 50);
      });
    }
  }

  json<K extends ServerMessage["t"]>(t: K) {
    return this.next((f): f is { json: Extract<ServerMessage, { t: K }> } => "json" in f && f.json.t === t).then((f) => f.json);
  }
  snapshot() {
    return this.next((f): f is { snapshot: Snapshot } => "snapshot" in f).then((f) => f.snapshot);
  }
  update() {
    return this.next((f): f is { update: Update } => "update" in f).then((f) => f.update);
  }
  send(m: unknown) {
    this.ws.send(JSON.stringify(m));
  }
  /** Send a draw batch and wait for its ack. */
  async draw(seq: number, pts: number[]) {
    this.send({ t: "draw", seq, pts });
    const ack = await this.json("ack");
    expect(ack.seq).toBe(seq);
    return ack;
  }
}

async function open(origin: string | null = ORIGIN): Promise<Response> {
  const headers: Record<string, string> = { Upgrade: "websocket" };
  if (origin) headers.Origin = origin;
  return exports.default.fetch("https://api.test/ws", { headers });
}

/** Connect and complete the hello handshake, returning the client and its first snapshot. */
async function join(token?: string): Promise<{ c: Client; snap: Snapshot }> {
  const res = await open();
  expect(res.status).toBe(101);
  const c = new Client(res.webSocket!);
  c.send(token ? { t: "hello", token } : { t: "hello" });
  const welcome = await c.json("welcome");
  c.id = welcome.id;
  c.token = welcome.token;
  expect(welcome.color).toBe(colorForId(welcome.id));
  return { c, snap: await c.snapshot() };
}

function stub() {
  return env.CANVAS_ROOM.getByName("main");
}

function countOwner(owners: Uint16Array, id: number): number {
  let n = 0;
  for (const o of owners) if (o === id) n++;
  return n;
}

function cellsOf(pts: number[]): Set<number> {
  const s = new Set<number>();
  forEachBrushCell(pts, (i) => s.add(i));
  return s;
}

async function waitForFlush() {
  for (let i = 0; i < 100; i++) {
    const s = await stub().stats();
    if (s.persistedRevision === s.revision) return s;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error("never flushed");
}

const sockets: Client[] = [];
async function tracked(token?: string) {
  const j = await join(token);
  sockets.push(j.c);
  return j;
}

afterEach(async () => {
  for (const c of sockets.splice(0)) {
    try { c.ws.close(1000); } catch { /* already closed */ }
  }
  // Wipe storage, then drop the live instance so its in-memory board goes too.
  await reset();
  await abortAllDurableObjects();
});

describe("websocket gate", () => {
  it("rejects missing or foreign origins and non-upgrade requests", async () => {
    expect((await open(null)).status).toBe(403);
    expect((await open("https://evil.test")).status).toBe(403);
    expect((await exports.default.fetch("https://api.test/ws")).status).toBe(426);
  });
});

describe("live drawing", () => {
  it("issues an identity, then a consistent snapshot", async () => {
    const { c, snap } = await tracked();
    expect(c.id).toBeGreaterThan(0);
    expect(c.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(snap.owners.length).toBe(CELL_COUNT);
    expect((await c.json("presence")).n).toBe(1);
  });

  it("broadcasts the same ordered updates to every client and transfers ownership", async () => {
    const { c: a } = await tracked();
    const { c: b } = await tracked();
    expect(a.id).not.toBe(b.id);

    await a.draw(1, [100, 100]);
    const ua = await a.update();
    const ub = await b.update();
    expect(ua).toEqual(ub);
    expect(ua.owner).toBe(a.id);
    expect(ua.runs.reduce((n, r) => n + r.length, 0)).toBe(37);

    await b.draw(1, [102, 100]);
    const second = await a.update();
    expect(second.revision).toBe(ua.revision + 1);
    expect(await b.update()).toEqual(second);

    // A fresh snapshot reflects the transfer exactly.
    a.send({ t: "sync" });
    const snap = await a.snapshot();
    const overlap = [...cellsOf([100, 100])].filter((i) => cellsOf([102, 100]).has(i)).length;
    expect(countOwner(snap.owners, b.id)).toBe(37);
    expect(countOwner(snap.owners, a.id)).toBe(37 - overlap);
    expect(snap.palette.get(a.id)).toBe(colorForId(a.id));
    expect(snap.revision).toBe(second.revision);
  });

  it("repainting your own cells sends no update and does not bump the revision", async () => {
    const { c } = await tracked();
    await c.draw(1, [50, 50, 60, 60]);
    const first = await c.update();
    await c.draw(2, [50, 50, 60, 60]);
    await c.draw(3, [55, 55]);
    expect(c.inbox.some((f) => "update" in f)).toBe(false);
    expect((await stub().stats()).revision).toBe(first.revision);
  });

  it("orders concurrent strokes identically for everyone", async () => {
    const { c: a } = await tracked();
    const { c: b } = await tracked();
    // Fire both without waiting; whoever the object processes second wins the crossing.
    a.send({ t: "draw", seq: 1, pts: [10, 128, 245, 128] });
    b.send({ t: "draw", seq: 1, pts: [128, 10, 128, 245] });
    const seenByA = [await a.update(), await a.update()];
    const seenByB = [await b.update(), await b.update()];
    expect(seenByA).toEqual(seenByB);
    expect(seenByA[1].revision).toBe(seenByA[0].revision + 1);
    a.send({ t: "sync" });
    const snap = await a.snapshot();
    expect(snap.owners[128 * 256 + 128]).toBe(seenByA[1].owner);
  });

  it("rejects malformed or oversized drawing without changing the board", async () => {
    const { c } = await tracked();
    c.send({ t: "draw", seq: 1, pts: [0, 0, 255, 0, 0, 1] });
    expect((await c.json("error")).code).toBe("bad_message");
    c.send({ t: "draw", seq: 2, pts: [0, 0], owner: 99 });
    expect((await c.json("error")).code).toBe("bad_message");
    c.ws.send("x".repeat(5000));
    expect((await c.json("error")).code).toBe("bad_message");
    expect((await stub().stats()).paintedCells).toBe(0);
  });

  it("refuses drawing before the handshake", async () => {
    const res = await open();
    const c = new Client(res.webSocket!);
    sockets.push(c);
    c.send({ t: "draw", seq: 1, pts: [5, 5] });
    expect((await c.json("error")).code).toBe("not_ready");
  });

  it("rate-limits a flood of messages but still acks each one", async () => {
    const { c } = await tracked();
    for (let i = 0; i < 80; i++) c.send({ t: "draw", seq: i, pts: [i % 256, 10] });
    const acks = [];
    for (let i = 0; i < 80; i++) acks.push(await c.json("ack"));
    expect(acks.filter((a) => !a.ok).length).toBeGreaterThan(0);
    expect(acks.filter((a) => a.ok).length).toBeGreaterThanOrEqual(40);
  });
});

describe("identity and reconnection", () => {
  it("restores the same identity and colour from the stored token", async () => {
    const { c: first } = await tracked();
    await first.draw(1, [30, 30, 90, 30]);
    const painted = (await first.update()).runs.reduce((n, r) => n + r.length, 0);
    first.ws.close(1000);

    const { c: again, snap } = await tracked(first.token);
    expect(again.id).toBe(first.id);
    expect(again.token).toBe(first.token);
    expect(countOwner(snap.owners, again.id)).toBe(painted);
  });

  it("issues a new identity for an unknown token", async () => {
    const { c } = await tracked("Z".repeat(43));
    expect(c.token).not.toBe("Z".repeat(43));
  });

  it("counts two tabs with one identity as one visitor, and cleans up on close", async () => {
    const { c: a } = await tracked();
    await a.json("presence");
    const { c: a2 } = await tracked(a.token);
    expect((await a2.json("presence")).n).toBe(1);
    const { c: b } = await tracked();
    expect((await b.json("presence")).n).toBe(2);
    b.ws.close(1000);
    // a and a2 each receive presence updates; the last one after b leaves is 1.
    let n = -1;
    for (let i = 0; i < 4 && n !== 1; i++) n = (await a.json("presence")).n;
    expect(n).toBe(1);
  });
});

describe("persistence", () => {
  it("restores the grid, counts and revision after eviction (memory lost, storage kept)", async () => {
    const { c } = await tracked();
    await c.draw(1, [0, 0, 255, 255]);
    const u = await c.update();
    const before = await waitForFlush();
    c.ws.close(1000);
    await evictDurableObject(stub(), { webSockets: "close" }).catch(() => {});

    const { c: back, snap } = await tracked(c.token);
    expect(back.id).toBe(c.id);
    expect(snap.revision).toBe(u.revision);
    const after = await stub().stats();
    expect(after.paintedCells).toBe(before.paintedCells);
    expect(countOwner(snap.owners, c.id)).toBe(before.paintedCells);
  });

  it("keeps hibernated sockets identified and drawing after the object is evicted", async () => {
    const { c: a } = await tracked();
    const { c: b } = await tracked();
    await a.draw(1, [40, 40]);
    await a.update();
    await b.update();
    await waitForFlush();
    await evictDurableObject(stub(), { webSockets: "hibernate" });

    // Same sockets, fresh instance: identity comes from the attachment, grid from SQLite.
    await b.draw(2, [42, 40]);
    const u = await a.update();
    expect(u.owner).toBe(b.id);
    b.send({ t: "sync" });
    const snap = await b.snapshot();
    expect(countOwner(snap.owners, a.id) + countOwner(snap.owners, b.id)).toBe(
      new Set([...cellsOf([40, 40]), ...cellsOf([42, 40])]).size,
    );
  });

  it("flushes when the last visitor leaves", async () => {
    const { c } = await tracked();
    await c.draw(1, [7, 7]);
    await c.update();
    c.ws.close(1000);
    const s = await waitForFlush();
    expect(s.paintedCells).toBe(37);
  });
});

describe("admin reset", () => {
  const post = (headers: Record<string, string>, body?: unknown) =>
    exports.default.fetch("https://api.test/admin/reset", {
      method: "POST",
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });

  it("requires the bearer secret and an explicit confirmation", async () => {
    expect((await post({})).status).toBe(401);
    expect((await post({ Authorization: "Bearer wrong" }, { confirm: "reset" })).status).toBe(401);
    expect((await post({ Authorization: `Bearer ${ADMIN}` })).status).toBe(400);
  });

  it("clears the board, keeps identities, and pushes a fresh snapshot", async () => {
    const { c } = await tracked();
    await c.draw(1, [128, 128]);
    const u = await c.update();
    const res = await post({ Authorization: `Bearer ${ADMIN}` }, { confirm: "reset" });
    expect(res.status).toBe(200);
    const snap = await c.snapshot();
    expect(snap.revision).toBeGreaterThan(u.revision);
    expect(countOwner(snap.owners, 0)).toBe(CELL_COUNT);
    const s = await stub().stats();
    expect(s.paintedCells).toBe(0);
    expect(s.visitors).toBe(1);
  });
});
