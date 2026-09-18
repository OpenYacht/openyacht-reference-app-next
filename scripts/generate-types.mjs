// Generates TypeScript types for the wire documents from the vendored JSON
// Schemas, so that no wire type in this repo is written from memory.
//
// Output: federation/generated/*.ts — committed, and checked for drift in CI
// (`pnpm generate:types` followed by `git diff --exit-code`).
//
// One transformation is applied before compiling: every schema object allows
// private `x_`-prefixed extension fields (`patternProperties: {"^x_": true}`).
// The generator can only express that as `[k: string]: unknown`, which turns
// off excess-property checking for every type. The pattern is dropped for
// typing only — Ajv validates against the untouched schemas, extension fields
// included.
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { compile } from "json-schema-to-typescript";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const schemaDir = join(root, "protocol/schemas/v1");
const outDir = join(root, "federation/generated");
const source = JSON.parse(readFileSync(join(root, "protocol/SOURCE.json"), "utf8"));

function dropExtensionPattern(node) {
  if (Array.isArray(node)) return node.map(dropExtensionPattern);
  if (node === null || typeof node !== "object") return node;
  const result = {};
  for (const [key, value] of Object.entries(node)) {
    const isExtensionPattern = key === "patternProperties" && Object.keys(value).length === 1 && value["^x_"] === true;
    if (!isExtensionPattern) result[key] = dropExtensionPattern(value);
  }
  return result;
}

const banner = `// GENERATED FILE — do not edit. Run \`pnpm generate:types\`.
// Source: protocol/schemas/v1 (${source.repository} @ ${source.commit.slice(0, 7)})
// Private \`x_\` extension fields are valid on the wire but deliberately untyped.`;

rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });

// A schema that references another schema file imports that file's root type
// instead of re-declaring it: duplicate names would silently drop out of the
// `export type *` index below.
function externalRefs(node, found = new Set()) {
  if (node === null || typeof node !== "object") return found;
  for (const [key, value] of Object.entries(node)) {
    if (key === "$ref" && typeof value === "string" && value.endsWith(".schema.json")) found.add(value);
    else externalRefs(value, found);
  }
  return found;
}

function rootTypeName(file) {
  const title = JSON.parse(readFileSync(join(schemaDir, file), "utf8")).title;
  return title.replace(/[^A-Za-z0-9]+/g, "");
}

const names = [];
for (const file of readdirSync(schemaDir).sort()) {
  if (!file.endsWith(".schema.json")) continue;
  const name = file.replace(".schema.json", "");
  const schema = dropExtensionPattern(JSON.parse(readFileSync(join(schemaDir, file), "utf8")));
  const external = [...externalRefs(schema)].sort();
  const imports = external.map((ref) => `import type { ${rootTypeName(ref)} } from "./${ref.replace(".schema.json", "")}";`);
  const typescript = await compile(schema, name, {
    bannerComment: [banner, ...imports].join("\n"),
    cwd: schemaDir,
    additionalProperties: false,
    // Off only where another schema file is referenced (and imported above);
    // a schema's own $defs must still be declared.
    declareExternallyReferenced: external.length === 0,
    // minItems/maxItems are enforced by Ajv at runtime; as tuple types they
    // only duplicate the item shape inline.
    ignoreMinAndMaxItems: true,
    style: { printWidth: 100 },
  });
  writeFileSync(join(outDir, `${name}.ts`), typescript);
  names.push(name);
}

writeFileSync(join(outDir, "index.ts"), `${banner}\n${names.map((name) => `export type * from "./${name}";`).join("\n")}\n`);
console.log(`Generated types for ${names.length} schemas into federation/generated/`);
