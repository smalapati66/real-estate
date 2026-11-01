import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
      miniflare: {
        bindings: {
          ALLOWED_ORIGINS: "https://art.test",
          ADMIN_TOKEN: "test-admin-token-0123456789abcdefghijkl",
          // Flush quickly so persistence tests do not wait two seconds.
          FLUSH_INTERVAL_MS: "25",
        },
      },
    }),
  ],
});
