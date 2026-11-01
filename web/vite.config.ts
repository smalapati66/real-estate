import { fileURLToPath } from "node:url";
import { defineConfig, loadEnv } from "vite";

// The app imports ../shared, which sits outside web/.
const repoRoot = fileURLToPath(new URL("..", import.meta.url));

export default defineConfig(({ command, mode }) => {
  // A production build without a backend URL would silently point at localhost.
  // loadEnv reads web/.env* files and VITE_* variables from the shell.
  if (command === "build" && !loadEnv(mode, ".", "VITE_").VITE_WS_URL) {
    throw new Error("VITE_WS_URL is not set. Copy web/.env.example to web/.env.production.local or export it.");
  }
  return {
    server: { port: 5173, strictPort: true, fs: { allow: [repoRoot] } },
    build: { target: "es2022" },
  };
});
