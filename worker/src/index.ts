export { CanvasRoom } from "./room";

/** Every visitor shares one canvas, so every request goes to one named object. */
const ROOM_NAME = "main";

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const room = env.CANVAS_ROOM.getByName(ROOM_NAME);

    if (url.pathname === "/ws") {
      if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
        return new Response("expected websocket upgrade", { status: 426 });
      }
      if (!originAllowed(request.headers.get("Origin"), env.ALLOWED_ORIGINS)) {
        return new Response("origin not allowed", { status: 403 });
      }
      return room.fetch(request);
    }

    if (url.pathname.startsWith("/admin/")) {
      const denied = await checkAdmin(request, env.ADMIN_TOKEN);
      if (denied) return denied;
      if (url.pathname === "/admin/reset" && request.method === "POST") {
        // Require an explicit confirmation body so a stray POST cannot wipe the board.
        const body = await request.json().catch(() => null) as { confirm?: unknown } | null;
        if (body?.confirm !== "reset") {
          return Response.json({ error: 'send {"confirm":"reset"}' }, { status: 400 });
        }
        return Response.json(await room.reset());
      }
      if (url.pathname === "/admin/stats" && request.method === "GET") {
        return Response.json(await room.stats());
      }
      return new Response("not found", { status: 404 });
    }

    if (url.pathname === "/") return new Response("shared canvas backend\n");
    return new Response("not found", { status: 404 });
  },
} satisfies ExportedHandler<Env>;

/** Exact match against a comma-separated allow-list. Browsers always send Origin on WebSocket upgrades. */
export function originAllowed(origin: string | null, allowList: string | undefined): boolean {
  if (!origin || !allowList) return false;
  return allowList.split(",").map((o) => o.trim()).filter(Boolean).includes(origin);
}

async function checkAdmin(request: Request, secret: string | undefined): Promise<Response | null> {
  if (!secret || secret.length < 32) {
    return new Response("admin disabled: set the ADMIN_TOKEN secret (32+ chars)", { status: 503 });
  }
  const header = request.headers.get("Authorization") ?? "";
  const presented = header.startsWith("Bearer ") ? header.slice(7) : "";
  // Compare fixed-length digests in constant time.
  const enc = new TextEncoder();
  const [a, b] = await Promise.all([
    crypto.subtle.digest("SHA-256", enc.encode(presented)),
    crypto.subtle.digest("SHA-256", enc.encode(secret)),
  ]);
  if (!crypto.subtle.timingSafeEqual(a, b)) {
    return new Response("unauthorized", { status: 401, headers: { "WWW-Authenticate": "Bearer" } });
  }
  return null;
}
