import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sourcePath = path.join(rootDir, "wrangler.jsonc");
const outputPath = path.join(rootDir, "wrangler.generated.jsonc");
const outputDir = path.dirname(outputPath);

const config = JSON.parse(await readFile(sourcePath, "utf8"));
const existingD1Databases = Array.isArray(config.d1_databases) ? config.d1_databases : [];
const existingCrons = Array.isArray(config.triggers?.crons) ? config.triggers.crons : [];
const reminderDb = existingD1Databases.find((database) => database?.binding === "REMINDER_DB");

if (!reminderDb?.database_name || !reminderDb?.database_id) {
  throw new Error(
    "Missing REMINDER_DB D1 binding. Create it with `npx.cmd wrangler d1 create schedule-photo-reader-reminders`, then add it to wrangler.jsonc.",
  );
}

config.main = pathFromGeneratedConfig(config.main);
if (config.assets?.directory) {
  config.assets.directory = pathFromGeneratedConfig(config.assets.directory);
}

config.d1_databases = existingD1Databases.map((database) => ({
  ...database,
  ...(database.migrations_dir
    ? {
        migrations_dir: pathFromGeneratedConfig(database.migrations_dir),
      }
    : {}),
}));

if (Array.isArray(config.kv_namespaces)) {
  config.kv_namespaces = config.kv_namespaces.filter((namespace) => namespace?.binding !== "REMINDER_STORE");
  if (!config.kv_namespaces.length) delete config.kv_namespaces;
}

config.triggers = {
  ...(config.triggers || {}),
  crons: [
    ...new Set(
      [...existingCrons.filter((cron) => !["1 * * * *", "* * * * *"].includes(cron)), "*/15 * * * *"],
    ),
  ],
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

console.log(`Prepared ${path.relative(rootDir, outputPath)} with REMINDER_DB binding.`);

function pathFromGeneratedConfig(value) {
  const source = path.isAbsolute(value) ? value : path.resolve(rootDir, value);
  return path.relative(outputDir, source).replace(/\\/g, "/") || ".";
}
