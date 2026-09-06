import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sourcePath = path.join(rootDir, "wrangler.jsonc");
const outputPath = path.join(rootDir, "wrangler.generated.jsonc");
const outputDir = path.dirname(outputPath);
const reminderStoreKvId = String(process.env.REMINDER_STORE_KV_ID || "").trim();

if (!reminderStoreKvId) {
  throw new Error(
    "Missing REMINDER_STORE_KV_ID. Create a KV namespace with `npx.cmd wrangler kv namespace create REMINDER_STORE`, then set REMINDER_STORE_KV_ID before deploy.",
  );
}

const config = JSON.parse(await readFile(sourcePath, "utf8"));
const existingKvNamespaces = Array.isArray(config.kv_namespaces) ? config.kv_namespaces : [];
const existingCrons = Array.isArray(config.triggers?.crons) ? config.triggers.crons : [];

config.main = pathFromGeneratedConfig(config.main);
if (config.assets?.directory) {
  config.assets.directory = pathFromGeneratedConfig(config.assets.directory);
}

config.kv_namespaces = [
  ...existingKvNamespaces.filter((namespace) => namespace?.binding !== "REMINDER_STORE"),
  {
    binding: "REMINDER_STORE",
    id: reminderStoreKvId,
  },
];

config.triggers = {
  ...(config.triggers || {}),
  crons: [...new Set([...existingCrons.filter((cron) => cron !== "1 * * * *"), "* * * * *"])],
};

const vapidSubject = String(process.env.VAPID_SUBJECT || "").trim();
if (vapidSubject) {
  config.vars = {
    ...(config.vars || {}),
    VAPID_SUBJECT: vapidSubject,
  };
}

await mkdir(path.dirname(outputPath), { recursive: true });
await writeFile(outputPath, `${JSON.stringify(config, null, 2)}\n`);

console.log(`Prepared ${path.relative(rootDir, outputPath)} with REMINDER_STORE binding.`);

function pathFromGeneratedConfig(value) {
  const source = path.isAbsolute(value) ? value : path.resolve(rootDir, value);
  return path.relative(outputDir, source).replace(/\\/g, "/") || ".";
}
