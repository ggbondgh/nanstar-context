import { existsSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

const requiredFiles = [
  "index.html",
  "styles.css",
  "app.js",
  "wrangler.jsonc",
  "migrations/0001_initial_schema.sql",
  "functions/_shared.js",
  "functions/_ai.js",
  "functions/_context.js",
  "functions/api/[[path]].js",
  "assets/vendor/lucide.min.js",
  "assets/vendor/marked.umd.js",
  "assets/vendor/purify.min.js"
];

const failures = [];
for (const file of requiredFiles) {
  if (!existsSync(file)) failures.push(`missing file: ${file}`);
}

for (const file of ["app.js", "functions/_shared.js", "functions/_ai.js", "functions/_context.js", "functions/api/[[path]].js"]) {
  const result = spawnSync(process.execPath, ["--check", file], { encoding: "utf8" });
  if (result.status !== 0) failures.push(`syntax error in ${file}: ${result.stderr.trim()}`);
  const source = readFileSync(file, "utf8");
  if (source.includes(".map(cleanId)")) failures.push(`${file}: do not pass cleanId directly to Array.map; the map index is interpreted as maxLength`);
}

if (existsSync("migrations/0001_initial_schema.sql")) {
  const schema = readFileSync("migrations/0001_initial_schema.sql", "utf8");
  for (const table of ["categories", "documents", "knowledge_blocks", "block_versions", "captures", "proposals", "proposal_operations", "ai_providers", "ai_models", "ai_routes", "ai_runs", "context_presets"]) {
    if (!schema.includes(`CREATE TABLE IF NOT EXISTS ${table}`)) failures.push(`missing schema table: ${table}`);
  }
}

if (existsSync("functions/api/[[path]].js")) {
  const api = readFileSync("functions/api/[[path]].js", "utf8");
  for (const route of ["session", "dashboard", "categories", "documents", "captures", "proposals", "context", "settings", "export", "import"]) {
    if (!api.includes(`segments[0] === "${route}"`)) failures.push(`missing API route: ${route}`);
  }
  if (api.includes("key_ciphertext:") || api.includes("key_iv:")) failures.push("API route may expose encrypted provider key fields");
}

if (failures.length) {
  console.error(failures.join("\n"));
  process.exit(1);
}

console.log(`Smoke check passed (${requiredFiles.length} required files).`);
