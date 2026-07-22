import { cp, copyFile, mkdir, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const output = join(projectRoot, "dist");
if (dirname(output) !== projectRoot) throw new Error("Refusing to build outside the project root");

await rm(output, { recursive: true, force: true });
await mkdir(output, { recursive: true });
for (const file of ["index.html", "styles.css", "app.js", "_headers"]) {
  await copyFile(join(projectRoot, file), join(output, file));
}
await cp(join(projectRoot, "assets"), join(output, "assets"), { recursive: true });
console.log("Static site built in dist/.");
