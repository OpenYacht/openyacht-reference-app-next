import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// The database lane: SQL behaviour that needs a real Postgres. CI runs it
// against `supabase start`; locally it runs against the development project,
// reading the connection string from .env.local like the rest of the app.
// Variables already in the environment win — loadEnvFile never overrides one.
if (existsSync(".env.local")) process.loadEnvFile(".env.local");

export default defineConfig({
  resolve: { alias: { "@": fileURLToPath(new URL(".", import.meta.url)) } },
  test: {
    environment: "node",
    include: ["tests/db/**/*.test.ts"],
    // One connection, one transaction per test; files take turns.
    fileParallelism: false,
  },
});
