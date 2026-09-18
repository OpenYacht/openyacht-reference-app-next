import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// The unit lane: the federation core and the route handlers, with storage
// faked through the core's ports. No database, no network.
export default defineConfig({
  resolve: { alias: { "@": fileURLToPath(new URL(".", import.meta.url)) } },
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    exclude: ["tests/db/**"],
  },
});
