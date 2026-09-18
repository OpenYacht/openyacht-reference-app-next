import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// The database lane: SQL behaviour that needs a real Postgres. CI runs it
// against `supabase start`; locally it runs against the development project.
export default defineConfig({
  resolve: { alias: { "@": fileURLToPath(new URL(".", import.meta.url)) } },
  test: {
    environment: "node",
    include: ["tests/db/**/*.test.ts"],
    // One connection, one transaction per test.
    fileParallelism: false,
  },
});
