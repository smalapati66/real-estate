/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Full WebSocket URL of the Worker, e.g. wss://shared-canvas-api.example.workers.dev/ws */
  readonly VITE_WS_URL?: string;
}
interface ImportMeta {
  readonly env: ImportMetaEnv;
}
