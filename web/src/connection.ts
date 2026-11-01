import { FRAME_SNAPSHOT, FRAME_UPDATE, PING, PONG } from "../../shared/constants";
import {
  decodeSnapshot, decodeUpdate, frameType,
  type ClientMessage, type ServerMessage, type Snapshot, type Update,
} from "../../shared/protocol";

const TOKEN_KEY = "shared-canvas.token";
const BACKOFF_BASE_MS = 500;
const BACKOFF_MAX_MS = 30_000;
const HEARTBEAT_MS = 20_000;
const PONG_TIMEOUT_MS = 10_000;

export type ConnectionState = "connecting" | "ready" | "offline";

export interface ConnectionEvents {
  state(state: ConnectionState, detail?: string): void;
  welcome(id: number, color: number): void;
  /** A full, authoritative board. Always arrives before any update it precedes. */
  snapshot(s: Snapshot): void;
  /** The next update in revision order (gaps are handled here, never passed on). */
  update(u: Update): void;
  ack(seq: number): void;
  presence(n: number): void;
}

/**
 * One WebSocket to the shared canvas, with handshake, ordered revisions,
 * resync on gaps, keepalive, and bounded exponential backoff.
 */
export class Connection {
  private ws: WebSocket | null = null;
  private attempt = 0;
  private reconnectTimer: number | undefined;
  private heartbeatTimer: number | undefined;
  private pongTimer: number | undefined;
  /** Revision of the last applied frame; null until a snapshot arrives. */
  private revision: number | null = null;

  constructor(private readonly url: string, private readonly on: ConnectionEvents) {
    addEventListener("online", () => this.reconnectNow());
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible") this.reconnectNow();
    });
  }

  get ready(): boolean {
    return this.ws?.readyState === WebSocket.OPEN && this.revision !== null;
  }

  connect(): void {
    clearTimeout(this.reconnectTimer);
    this.revision = null;
    this.on.state("connecting");
    let ws: WebSocket;
    try {
      ws = new WebSocket(this.url);
    } catch {
      this.down("bad WebSocket URL");
      return;
    }
    ws.binaryType = "arraybuffer";
    this.ws = ws;

    ws.onopen = () => {
      if (ws !== this.ws) return;
      const token = readToken();
      this.send(token ? { t: "hello", token } : { t: "hello" });
      this.startHeartbeat();
    };
    ws.onmessage = (e) => {
      if (ws !== this.ws) return;
      if (typeof e.data === "string") this.onText(e.data);
      else this.onBinary(e.data as ArrayBuffer);
    };
    ws.onclose = () => {
      if (ws === this.ws) this.down();
    };
  }

  /** Returns false (and sends nothing) when not ready; strokes are never queued offline. */
  send(msg: ClientMessage): boolean {
    if (this.ws?.readyState !== WebSocket.OPEN) return false;
    if (msg.t === "draw" && this.revision === null) return false;
    this.ws.send(JSON.stringify(msg));
    return true;
  }

  private onText(data: string): void {
    if (data === PONG) {
      clearTimeout(this.pongTimer);
      return;
    }
    let msg: ServerMessage;
    try {
      msg = JSON.parse(data);
    } catch {
      return;
    }
    switch (msg.t) {
      case "welcome":
        writeToken(msg.token);
        this.on.welcome(msg.id, msg.color);
        break;
      case "ack":
        this.on.ack(msg.seq);
        break;
      case "presence":
        this.on.presence(msg.n);
        break;
      case "error":
        if (msg.code === "busy" || msg.code === "full") this.on.state("offline", msg.code === "full" ? "canvas is full" : "busy · retrying");
        else if (msg.code === "not_ready") this.resync();
        break;
    }
  }

  private onBinary(buf: ArrayBuffer): void {
    const type = frameType(buf);
    if (type === FRAME_SNAPSHOT) {
      const snap = decodeSnapshot(buf);
      this.revision = snap.revision;
      this.attempt = 0;
      this.on.snapshot(snap);
      this.on.state("ready");
    } else if (type === FRAME_UPDATE) {
      if (this.revision === null) return; // waiting for a snapshot
      const u = decodeUpdate(buf);
      if (u.revision <= this.revision) return; // already reflected
      if (u.revision !== this.revision + 1) {
        this.resync();
        return;
      }
      this.revision = u.revision;
      this.on.update(u);
    }
  }

  /** Missed an update: stop applying until a fresh snapshot arrives. */
  private resync(): void {
    if (this.revision === null) return;
    this.revision = null;
    this.on.state("connecting", "resyncing…");
    this.ws?.send(JSON.stringify({ t: "sync" } satisfies ClientMessage));
  }

  private startHeartbeat(): void {
    clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = setInterval(() => {
      if (this.ws?.readyState !== WebSocket.OPEN) return;
      this.ws.send(PING); // answered by the runtime without waking the Durable Object
      clearTimeout(this.pongTimer);
      this.pongTimer = setTimeout(() => this.down("connection stalled"), PONG_TIMEOUT_MS);
    }, HEARTBEAT_MS);
  }

  private down(detail?: string): void {
    clearInterval(this.heartbeatTimer);
    clearTimeout(this.pongTimer);
    const ws = this.ws;
    this.ws = null;
    this.revision = null;
    if (ws && ws.readyState <= WebSocket.OPEN) ws.close();
    this.on.state("offline", detail);
    const delay = Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** this.attempt) * (0.5 + Math.random() * 0.5);
    this.attempt = Math.min(this.attempt + 1, 10);
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = setTimeout(() => this.connect(), delay);
  }

  private reconnectNow(): void {
    if (this.ws) return; // connecting or connected
    this.attempt = 0;
    this.connect();
  }
}

function readToken(): string | null {
  try {
    return localStorage.getItem(TOKEN_KEY);
  } catch {
    return memoryToken;
  }
}

let memoryToken: string | null = null;
function writeToken(token: string): void {
  memoryToken = token;
  try {
    localStorage.setItem(TOKEN_KEY, token);
  } catch {
    // Storage unavailable (e.g. some private modes): identity lasts for this tab only.
  }
}
