import { pathLength } from "../../shared/brush";
import {
  GRID_SIZE, MAX_CLIENT_FRAME, MAX_PATH_PER_MESSAGE, MAX_POINTS_PER_MESSAGE,
} from "../../shared/constants";
import type { ClientMessage } from "../../shared/protocol";

/** Tokens are 32 random bytes, base64url without padding. */
export const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

/**
 * Parse and strictly validate a client frame. Returns null for anything
 * malformed: wrong type, unknown fields, out-of-range coordinates, too many
 * points, or a path too long for one message.
 */
export function parseClientMessage(raw: string | ArrayBuffer): ClientMessage | null {
  if (typeof raw !== "string" || raw.length > MAX_CLIENT_FRAME) return null;
  let m: unknown;
  try {
    m = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof m !== "object" || m === null || Array.isArray(m)) return null;
  const o = m as Record<string, unknown>;
  const keys = Object.keys(o);

  switch (o.t) {
    case "hello":
      if (!keys.every((k) => k === "t" || k === "token")) return null;
      if (o.token === undefined) return { t: "hello" };
      if (typeof o.token !== "string" || !TOKEN_PATTERN.test(o.token)) return null;
      return { t: "hello", token: o.token };

    case "sync":
      return keys.length === 1 ? { t: "sync" } : null;

    case "draw": {
      if (keys.length !== 3 || !("seq" in o) || !("pts" in o)) return null;
      const { seq, pts } = o;
      if (!Number.isSafeInteger(seq) || (seq as number) < 0) return null;
      if (!Array.isArray(pts) || pts.length < 2 || pts.length % 2 !== 0) return null;
      if (pts.length > MAX_POINTS_PER_MESSAGE * 2) return null;
      for (const p of pts) {
        if (!Number.isInteger(p) || p < 0 || p >= GRID_SIZE) return null;
      }
      if (pathLength(pts) > MAX_PATH_PER_MESSAGE) return null;
      return { t: "draw", seq: seq as number, pts: pts as number[] };
    }

    default:
      return null;
  }
}

/** Simple token bucket. Lives in memory; resetting on hibernation is harmless. */
export class TokenBucket {
  private tokens: number;
  private last: number;
  constructor(private readonly capacity: number, private readonly perSecond: number, now = Date.now()) {
    this.tokens = capacity;
    this.last = now;
  }
  take(amount = 1, now = Date.now()): boolean {
    this.tokens = Math.min(this.capacity, this.tokens + ((now - this.last) / 1000) * this.perSecond);
    this.last = now;
    if (this.tokens < amount) return false;
    this.tokens -= amount;
    return true;
  }
}
