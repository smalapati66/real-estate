import { DurableObject } from "cloudflare:workers";
import { pathLength } from "../../shared/brush";
import { colorForId, type Rgb } from "../../shared/color";
import { MAX_VISITOR_ID, PING, PONG } from "../../shared/constants";
import {
  encodeSnapshot, encodeUpdate, toRuns,
  type ErrorCode, type ServerMessage,
} from "../../shared/protocol";
import { Board, CHUNK_COUNT } from "./board";
import { parseClientMessage, TokenBucket } from "./validate";

/**
 * Per-socket state that must survive hibernation. Stored with
 * serializeAttachment(); JavaScript memory does not survive hibernation.
 */
interface Attachment {
  /** Visitor id once the hello handshake has completed. */
  vid: number | null;
  /** True once a hello has been received, so a socket cannot claim two identities. */
  hello: boolean;
}

interface Limits {
  messages: TokenBucket;
  /** Budget of brush path length (cells) per second. */
  ink: TokenBucket;
}

const DEFAULT_FLUSH_MS = 2000;

/**
 * The single shared canvas. Every visitor is routed to one instance.
 *
 * Persistence strategy (see README for detail):
 *  - The grid lives in memory as a Uint16Array of owner ids and is persisted
 *    as CHUNK_COUNT BLOB rows. Edits mark chunks dirty; a coalescing timer
 *    writes only dirty chunks plus the revision, in one transaction, at most
 *    once per FLUSH_INTERVAL_MS. The last socket closing flushes immediately.
 *  - Ownership counts are recomputed from the grid on load, never stored.
 *  - Visitor identities are one row each, written on creation/reconnect.
 *  - A pending setTimeout keeps the object from hibernating, so dirty state is
 *    always flushed before hibernation. Only an abrupt crash/eviction can lose
 *    edits, and at most the last FLUSH_INTERVAL_MS of them.
 */
export class CanvasRoom extends DurableObject<Env> {
  private readonly sql: SqlStorage;
  private readonly board = new Board();
  private revision = 0;
  private persistedRevision = 0;
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly flushMs: number;

  // In-memory only; losing these on hibernation just resets the limits.
  private readonly limits = new Map<WebSocket, Limits>();
  private readonly newIdentities = new TokenBucket(30, 0.5); // 30 burst, then 30/min

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    const configured = Number(env.FLUSH_INTERVAL_MS);
    this.flushMs = Number.isFinite(configured) && configured > 0 ? configured : DEFAULT_FLUSH_MS;

    // SQLite calls are synchronous, so the constructor fully restores state
    // before any event is delivered. This runs again after every wake-up.
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS chunks (idx INTEGER PRIMARY KEY, data BLOB NOT NULL);
      CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS visitors (
        id INTEGER PRIMARY KEY,
        token_hash BLOB NOT NULL UNIQUE,
        created_at INTEGER NOT NULL,
        last_seen INTEGER NOT NULL
      );
    `);
    for (const row of this.sql.exec<{ idx: number; data: ArrayBuffer }>("SELECT idx, data FROM chunks")) {
      this.board.loadChunk(row.idx, row.data);
    }
    this.board.recount();
    const rev = this.sql.exec<{ value: number }>("SELECT value FROM meta WHERE key = 'revision'").toArray();
    this.revision = this.persistedRevision = rev[0]?.value ?? 0;

    // Keepalive pings are answered by the runtime without waking the object.
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair(PING, PONG));
  }

  // -------------------------------------------------------------------------
  // Connection lifecycle
  // -------------------------------------------------------------------------

  async fetch(request: Request): Promise<Response> {
    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
      return new Response("expected websocket", { status: 426 });
    }
    const { 0: client, 1: server } = new WebSocketPair();
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({ vid: null, hello: false } satisfies Attachment);
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws: WebSocket, raw: string | ArrayBuffer): Promise<void> {
    const msg = parseClientMessage(raw);
    if (!msg) {
      this.sendJson(ws, { t: "error", code: "bad_message" });
      return;
    }
    switch (msg.t) {
      case "hello":
        return this.handleHello(ws, msg.token);
      case "draw":
        return this.handleDraw(ws, msg.seq, msg.pts);
      case "sync":
        if (!this.attachment(ws).vid) return this.sendError(ws, "not_ready");
        if (!this.limitsFor(ws).messages.take()) return this.sendError(ws, "rate_limited");
        ws.send(this.snapshotFrame());
        return;
    }
  }

  async webSocketClose(ws: WebSocket): Promise<void> {
    // With compatibility_date >= 2026-04-07 the runtime replies to the close
    // frame itself, so there is no need to call ws.close() here.
    this.disconnected(ws);
  }

  async webSocketError(ws: WebSocket): Promise<void> {
    this.disconnected(ws);
  }

  private disconnected(ws: WebSocket): void {
    this.limits.delete(ws);
    // The closing socket can still be listed by getWebSockets(); exclude it.
    const remaining = this.identifiedSockets(ws);
    this.broadcastPresence(remaining);
    if (remaining.length === 0) this.flush();
  }

  // -------------------------------------------------------------------------
  // Identity
  // -------------------------------------------------------------------------

  private async handleHello(ws: WebSocket, token: string | undefined): Promise<void> {
    const att = this.attachment(ws);
    if (att.hello) return this.sendError(ws, "bad_message");
    ws.serializeAttachment({ vid: null, hello: true } satisfies Attachment);

    let vid: number | null = null;
    if (token) {
      const hash = await sha256(token);
      const row = this.sql.exec<{ id: number }>("SELECT id FROM visitors WHERE token_hash = ?", hash).toArray()[0];
      if (row) {
        vid = row.id;
        this.sql.exec("UPDATE visitors SET last_seen = ? WHERE id = ?", Date.now(), vid);
      }
    }
    if (vid === null) {
      // Unknown or missing token: issue a fresh identity.
      if (!this.newIdentities.take()) {
        this.sendError(ws, "busy");
        ws.close(1013, "try again later");
        return;
      }
      token = randomToken();
      vid = this.createVisitor(await sha256(token));
      if (vid === null) {
        this.sendError(ws, "full");
        ws.close(1013, "canvas full");
        return;
      }
    }
    if (ws.readyState !== WebSocket.OPEN) return;

    // Everything below is synchronous, so the snapshot is consistent with the
    // revision and every later update reaches this socket after it, in order.
    ws.serializeAttachment({ vid, hello: true } satisfies Attachment);
    this.sendJson(ws, { t: "welcome", id: vid, color: colorForId(vid), token: token! });
    ws.send(this.snapshotFrame());
    this.broadcastPresence(this.identifiedSockets());
  }

  /** Allocate the next visitor id, reclaiming a long-idle, cell-less id once the uint16 space is used up. */
  private createVisitor(tokenHash: ArrayBuffer): number | null {
    const now = Date.now();
    const { m } = this.sql.exec<{ m: number }>("SELECT COALESCE(MAX(id), 0) AS m FROM visitors").one();
    if (m < MAX_VISITOR_ID) {
      this.sql.exec(
        "INSERT INTO visitors (id, token_hash, created_at, last_seen) VALUES (?, ?, ?, ?)",
        m + 1, tokenHash, now, now,
      );
      return m + 1;
    }
    const connected = new Set(this.identifiedSockets().map((s) => this.attachment(s).vid));
    for (const { id } of this.sql.exec<{ id: number }>("SELECT id FROM visitors ORDER BY last_seen LIMIT 1000")) {
      if (this.board.counts[id] === 0 && !connected.has(id)) {
        this.sql.exec(
          "UPDATE visitors SET token_hash = ?, created_at = ?, last_seen = ? WHERE id = ?",
          tokenHash, now, now, id,
        );
        return id;
      }
    }
    return null;
  }

  // -------------------------------------------------------------------------
  // Drawing
  // -------------------------------------------------------------------------

  /**
   * Fully synchronous: the Durable Object runs one event at a time, so each
   * batch is applied atomically and all clients observe the same order.
   */
  private handleDraw(ws: WebSocket, seq: number, pts: number[]): void {
    const { vid } = this.attachment(ws);
    if (!vid) return this.sendError(ws, "not_ready");

    const limits = this.limitsFor(ws);
    if (!limits.messages.take() || !limits.ink.take(pathLength(pts) + 1)) {
      // Reject but still ack, so the client drops its optimistic preview.
      this.sendJson(ws, { t: "ack", seq, ok: false });
      return;
    }

    const changed = this.board.paint(vid, pts);
    if (changed.length > 0) {
      this.revision++;
      const frame = encodeUpdate({ revision: this.revision, owner: vid, color: colorForId(vid), runs: toRuns(changed) });
      for (const s of this.identifiedSockets()) safeSend(s, frame);
      this.scheduleFlush();
    }
    this.sendJson(ws, { t: "ack", seq, ok: true });
  }

  private limitsFor(ws: WebSocket): Limits {
    let l = this.limits.get(ws);
    if (!l) {
      l = { messages: new TokenBucket(40, 25), ink: new TokenBucket(1600, 1000) };
      this.limits.set(ws, l);
    }
    return l;
  }

  // -------------------------------------------------------------------------
  // Persistence
  // -------------------------------------------------------------------------

  private scheduleFlush(): void {
    this.flushTimer ??= setTimeout(() => {
      this.flushTimer = null;
      this.flush();
    }, this.flushMs);
  }

  private flush(): void {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    if (!this.board.hasDirtyChunks() && this.persistedRevision === this.revision) return;
    const chunks = this.board.takeDirtyChunks();
    const revision = this.revision;
    try {
      this.ctx.storage.transactionSync(() => {
        for (const [idx, data] of chunks) {
          this.sql.exec("INSERT OR REPLACE INTO chunks (idx, data) VALUES (?, ?)", idx, data);
        }
        this.sql.exec("INSERT OR REPLACE INTO meta (key, value) VALUES ('revision', ?)", revision);
      });
      this.persistedRevision = revision;
    } catch (err) {
      console.error("flush failed; will retry", err);
      this.board.markDirty(chunks.map(([idx]) => idx));
      this.scheduleFlush();
    }
  }

  // -------------------------------------------------------------------------
  // Admin (called over RPC from the Worker after it checks the secret)
  // -------------------------------------------------------------------------

  async reset(): Promise<{ revision: number }> {
    this.board.clear();
    this.revision++;
    this.flush();
    const frame = this.snapshotFrame();
    for (const s of this.identifiedSockets()) safeSend(s, frame);
    return { revision: this.revision };
  }

  async stats(): Promise<{ revision: number; persistedRevision: number; visitors: number; present: number; paintedCells: number; chunks: number }> {
    const { n } = this.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM visitors").one();
    return {
      revision: this.revision,
      persistedRevision: this.persistedRevision,
      visitors: n,
      present: distinctVisitors(this.identifiedSockets().map((s) => this.attachment(s))),
      paintedCells: this.board.owners.length - this.board.counts[0],
      chunks: CHUNK_COUNT,
    };
  }

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  private snapshotFrame(): ArrayBuffer {
    const palette = new Map<number, Rgb>();
    for (const id of this.board.activeOwners()) palette.set(id, colorForId(id));
    return encodeSnapshot(this.revision, this.board.owners, palette);
  }

  private attachment(ws: WebSocket): Attachment {
    return (ws.deserializeAttachment() as Attachment | null) ?? { vid: null, hello: false };
  }

  /** Open sockets that completed the handshake, optionally excluding one that is closing. */
  private identifiedSockets(exclude?: WebSocket): WebSocket[] {
    return this.ctx.getWebSockets().filter(
      (s) => s !== exclude && s.readyState === WebSocket.OPEN && this.attachment(s).vid !== null,
    );
  }

  private broadcastPresence(sockets: WebSocket[]): void {
    const msg = JSON.stringify({ t: "presence", n: distinctVisitors(sockets.map((s) => this.attachment(s))) } satisfies ServerMessage);
    for (const s of sockets) safeSend(s, msg);
  }

  private sendJson(ws: WebSocket, msg: ServerMessage): void {
    safeSend(ws, JSON.stringify(msg));
  }

  private sendError(ws: WebSocket, code: ErrorCode): void {
    this.sendJson(ws, { t: "error", code });
  }
}

/** Two tabs in one browser share an identity and count as one visitor. */
function distinctVisitors(atts: Attachment[]): number {
  return new Set(atts.map((a) => a.vid)).size;
}

function safeSend(ws: WebSocket, data: string | ArrayBuffer): void {
  try {
    ws.send(data);
  } catch {
    // Socket is closing; its close event will clean up.
  }
}

function randomToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function sha256(text: string): Promise<ArrayBuffer> {
  return crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
}
