import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
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

const buildVersion = process.env.APP_VERSION || buildVersionNumber();
const publicIndexPath = path.join(publicDir, "index.html");
let publicIndex = await readFile(publicIndexPath, "utf8");
publicIndex = publicIndex
  .replace(/(<meta\s+name="app-version"\s+content=")[^"]+(")/, `$1${buildVersion}$2`)
  .replace(/(styles\.css\?v=)[^"']+/, `$1${buildVersion}`)
  .replace(/(app\.js\?v=)[^"']+/, `$1${buildVersion}`);
await writeFile(publicIndexPath, publicIndex);

function buildVersionNumber(date = new Date()) {
  return date.toISOString().replace(/\D/g, "").slice(0, 14);
}
