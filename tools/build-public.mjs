import { cp, mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const publicDir = path.join(rootDir, "public");

const staticEntries = [
  "index.html",
  "app.js",
  "styles.css",
  "site.webmanifest",
  "assets",
];

await rm(publicDir, { recursive: true, force: true });
await mkdir(publicDir, { recursive: true });

for (const entry of staticEntries) {
  await cp(path.join(rootDir, entry), path.join(publicDir, entry), {
    recursive: true,
  });
}
