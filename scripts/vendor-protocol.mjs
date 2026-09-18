// Vendors the machine-readable protocol artifacts into ./protocol.
//
// The schemas, registries and OpenAPI document are copied into the repo and
// read from disk. Nothing under ./protocol is ever fetched at request time
// (LS-13: validating or serving a listing must not depend on a third-party
// host, openyacht.org included). Re-run this when the protocol repo changes:
//
//   pnpm vendor:protocol                     # from github.com/OpenYacht/protocol
//   pnpm vendor:protocol -- --from ../openyacht-protocol   # from a local checkout
//
// A local checkout is copied as it stands on disk, so check what it has
// checked out before vendoring from it.
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = "OpenYacht/protocol";
const REF = "main";
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const target = join(root, "protocol");

// Directories are vendored whole; single files are listed by name.
const DIRECTORIES = ["schemas/v1", "registry", "examples/valid", "examples/invalid"];
const FILES = ["openapi/openyacht-v1.yaml", "spec/signing-test-vectors.md", "LICENSE", "LICENSES/MIT.txt", "LICENSES/CC-BY-4.0.txt"];

const fromIndex = process.argv.indexOf("--from");
const localSource = fromIndex === -1 ? null : resolve(process.argv[fromIndex + 1] ?? "");

async function github(path) {
  const response = await fetch(`https://api.github.com/repos/${REPO}/${path}`, {
    headers: { accept: "application/vnd.github+json", "user-agent": "openyacht-vendor-protocol" },
  });
  if (!response.ok) throw new Error(`GitHub API ${response.status} for ${path}`);
  return response.json();
}

async function listDirectory(directory) {
  if (localSource) return readdirSync(join(localSource, directory)).map((name) => `${directory}/${name}`);
  const entries = await github(`contents/${directory}?ref=${REF}`);
  return entries.filter((entry) => entry.type === "file").map((entry) => entry.path);
}

async function readSource(path, commit) {
  if (localSource) return readFileSync(join(localSource, path));
  const response = await fetch(`https://raw.githubusercontent.com/${REPO}/${commit}/${path}`);
  if (!response.ok) throw new Error(`Fetch ${response.status} for ${path}`);
  return Buffer.from(await response.arrayBuffer());
}

async function sourceCommit() {
  if (localSource) return execFileSync("git", ["-C", localSource, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  return (await github(`commits/${REF}`)).sha;
}

const commit = await sourceCommit();
const paths = [...FILES];
for (const directory of DIRECTORIES) paths.push(...(await listDirectory(directory)));
paths.sort();

// Read everything before touching ./protocol, so a failed fetch never leaves
// a half-vendored tree behind.
const contents = new Map();
for (const path of paths) contents.set(path, await readSource(path, commit));

rmSync(target, { recursive: true, force: true });
for (const [path, bytes] of contents) {
  const destination = join(target, path);
  mkdirSync(dirname(destination), { recursive: true });
  writeFileSync(destination, bytes);
}

const registryVersions = {};
for (const path of paths.filter((p) => p.startsWith("registry/") && p.endsWith(".json"))) {
  const version = JSON.parse(contents.get(path).toString("utf8")).version;
  if (typeof version === "string") registryVersions[path.slice("registry/".length)] = version;
}

writeFileSync(
  join(target, "SOURCE.json"),
  `${JSON.stringify({ repository: `https://github.com/${REPO}`, commit, registry_versions: registryVersions, files: paths }, null, 2)}\n`,
);

console.log(`Vendored ${paths.length} files from ${localSource ?? `${REPO}@${REF}`} (${commit.slice(0, 7)}) into protocol/`);
