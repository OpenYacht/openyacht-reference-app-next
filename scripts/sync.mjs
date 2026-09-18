// Runs one sync pass by calling the node's own internal route — the same route
// a scheduler calls. The server must be running.
//
//   pnpm sync                 partners that are due
//   pnpm sync -- --force      ignore the failure backoff
//
// SYNC_BASE_URL (default http://localhost:3000) says where the server is.
import { existsSync } from "node:fs";

if (existsSync(".env.local")) process.loadEnvFile(".env.local");

const secret = (process.env.INTERNAL_API_SECRET ?? "").trim();
if (secret === "") {
  console.error("sync: INTERNAL_API_SECRET is not set.");
  process.exit(1);
}
const base = (process.env.SYNC_BASE_URL ?? "").trim() || "http://localhost:3000";
const force = process.argv.includes("--force") ? "?force=1" : "";

let response;
try {
  response = await fetch(`${base}/api/internal/sync${force}`, { method: "POST", headers: { authorization: `Bearer ${secret}` } });
} catch (error) {
  console.error(`sync: cannot reach ${base} — is the server running? (${error.message})`);
  process.exit(1);
}
if (!response.ok) {
  console.error(`sync: ${base} answered ${response.status} ${await response.text()}`);
  process.exit(1);
}
const { results } = await response.json();
if (results.length === 0) console.log("sync: no verified partners.");
for (const { domain, outcome } of results) {
  const { status, ...detail } = outcome;
  console.log(`${domain.padEnd(40)} ${status}  ${Object.keys(detail).length ? JSON.stringify(detail) : ""}`);
}
// A partner awaiting approval or backing off is not an error; a failed sync is.
process.exit(results.some(({ outcome }) => outcome.status === "failed") ? 1 : 0);
