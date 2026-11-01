// Shared by the browser and the Worker. Keep this file free of DOM/Workers APIs.

/** Logical grid size. Never changes with screen size. */
export const GRID_SIZE = 256;
export const CELL_COUNT = GRID_SIZE * GRID_SIZE; // 65,536

/** Owner id 0 means "unpainted". Visitor ids are 1..MAX_VISITOR_ID (uint16). */
export const UNPAINTED = 0;
export const MAX_VISITOR_ID = 0xffff;

/** Fixed brush: an opaque disc of this radius (in cells) swept along the path. */
export const BRUSH_RADIUS = 3.5;

/** Client batching cadence (~20 messages per second). */
export const SEND_INTERVAL_MS = 50;

/** Server-enforced per-message limits (the client splits batches to stay under them). */
export const MAX_POINTS_PER_MESSAGE = 48;
/** Max summed segment length per message, in cells. The canvas diagonal is ~362. */
export const MAX_PATH_PER_MESSAGE = 400;
/** Max size of any client->server text frame, in bytes/chars. */
export const MAX_CLIENT_FRAME = 1024;

/** Text frames the runtime answers without waking the Durable Object. */
export const PING = "ping";
export const PONG = "pong";

/** Binary server->client frame types (first byte). */
export const FRAME_SNAPSHOT = 1;
export const FRAME_UPDATE = 2;
