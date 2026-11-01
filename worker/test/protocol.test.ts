import { describe, expect, it } from "vitest";
import { CELL_COUNT } from "../../shared/constants";
import { decodeSnapshot, decodeUpdate, encodeSnapshot, encodeUpdate, toRuns } from "../../shared/protocol";
import { Board } from "../src/board";
import { originAllowed } from "../src/index";
import { parseClientMessage } from "../src/validate";

describe("binary frames", () => {
  it("round-trips a snapshot", () => {
    const b = new Board();
    b.paint(3, [10, 10, 100, 200]);
    b.paint(70000 % 65536, [0, 0]);
    const palette = new Map([[3, 0x123456], [4464, 0xabcdef]]);
    const snap = decodeSnapshot(encodeSnapshot(42, b.owners, palette));
    expect(snap.revision).toBe(42);
    expect(snap.owners).toEqual(b.owners);
    expect(snap.palette).toEqual(palette);
  });

  it("encodes an empty board compactly", () => {
    const empty = new Uint16Array(CELL_COUNT);
    expect(encodeSnapshot(0, empty, new Map()).byteLength).toBeLessThan(32);
  });

  it("round-trips an update", () => {
    const runs = toRuns([1, 2, 3, 7, 8, 65535]);
    expect(runs).toEqual([{ start: 1, length: 3 }, { start: 7, length: 2 }, { start: 65535, length: 1 }]);
    const u = decodeUpdate(encodeUpdate({ revision: 9, owner: 65535, color: 0xff8800, runs }));
    expect(u).toEqual({ revision: 9, owner: 65535, color: 0xff8800, runs });
  });
});

describe("client message validation", () => {
  const ok = (m: unknown) => parseClientMessage(JSON.stringify(m));

  it("accepts well-formed messages", () => {
    expect(ok({ t: "hello" })).toEqual({ t: "hello" });
    expect(ok({ t: "hello", token: "a".repeat(43) })).toEqual({ t: "hello", token: "a".repeat(43) });
    expect(ok({ t: "draw", seq: 1, pts: [0, 0, 255, 255] })).toEqual({ t: "draw", seq: 1, pts: [0, 0, 255, 255] });
    expect(ok({ t: "sync" })).toEqual({ t: "sync" });
  });

  it("rejects bad coordinates, shapes and sizes", () => {
    expect(ok({ t: "draw", seq: 1, pts: [0, 256] })).toBeNull();
    expect(ok({ t: "draw", seq: 1, pts: [-1, 0] })).toBeNull();
    expect(ok({ t: "draw", seq: 1, pts: [1.5, 0] })).toBeNull();
    expect(ok({ t: "draw", seq: 1, pts: [1] })).toBeNull();
    expect(ok({ t: "draw", seq: 1, pts: [] })).toBeNull();
    expect(ok({ t: "draw", seq: -1, pts: [1, 1] })).toBeNull();
    expect(ok({ t: "draw", seq: 1, pts: [1, 1], owner: 5 })).toBeNull();
    expect(ok({ t: "draw", seq: 1, pts: "1,1" })).toBeNull();
    // 49 points: over the per-message point limit.
    expect(ok({ t: "draw", seq: 1, pts: Array(98).fill(5) })).toBeNull();
    // Zig-zag across the canvas: path far longer than the per-message limit.
    expect(ok({ t: "draw", seq: 1, pts: [0, 0, 255, 0, 0, 1] })).toBeNull();
    expect(ok({ t: "hello", token: "short" })).toBeNull();
    expect(ok({ t: "paint", cells: [1, 2, 3] })).toBeNull();
    expect(parseClientMessage("not json")).toBeNull();
    expect(parseClientMessage(new ArrayBuffer(4))).toBeNull();
    expect(parseClientMessage(JSON.stringify({ t: "hello" }) + " ".repeat(2000))).toBeNull();
  });
});

describe("origin allow-list", () => {
  const list = "https://art.test, https://*.proj.pages.dev";
  it("matches exact origins and one-label wildcards only", () => {
    expect(originAllowed("https://art.test", list)).toBe(true);
    expect(originAllowed("https://a27f5e34.proj.pages.dev", list)).toBe(true);
    expect(originAllowed("https://proj.pages.dev", list)).toBe(false);
    expect(originAllowed("https://a.b.proj.pages.dev", list)).toBe(false);
    expect(originAllowed("https://evilproj.pages.dev", list)).toBe(false);
    expect(originAllowed("http://a27f5e34.proj.pages.dev", list)).toBe(false);
    expect(originAllowed("https://x.proj.pages.dev.evil.com", list)).toBe(false);
    expect(originAllowed("https://art.test.evil.com", list)).toBe(false);
    expect(originAllowed(null, list)).toBe(false);
  });
});
