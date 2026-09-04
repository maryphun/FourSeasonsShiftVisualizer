import { mkdir, readFile, writeFile } from "node:fs/promises";
import crypto from "node:crypto";
import path from "node:path";

const imagePath = process.argv[2] || "C:\\Users\\phunm\\Downloads\\IMG_5315.JPG";
const outputDir = path.resolve("vision-test-output");
const apiKey = process.env.GOOGLE_VISION_API_KEY || process.env.GOOGLE_API_KEY;
const bearerToken = process.env.GOOGLE_OAUTH_TOKEN || process.env.GCLOUD_ACCESS_TOKEN;
const serviceAccountPath = process.env.GOOGLE_APPLICATION_CREDENTIALS;

if (!apiKey && !bearerToken && !serviceAccountPath) {
  console.error(
    [
      "Missing Google Vision credentials.",
      "",
      "Recommended test with a service account JSON key:",
      '$env:GOOGLE_APPLICATION_CREDENTIALS="C:\\path\\to\\service-account.json"',
      `node tools/google-vision-test.mjs "${imagePath}"`,
      "",
      "Or use a bearer token from gcloud:",
      '$env:GOOGLE_OAUTH_TOKEN="YOUR_TOKEN"',
      `node tools/google-vision-test.mjs "${imagePath}"`,
      "",
      "Some projects may still accept API keys:",
      '$env:GOOGLE_API_KEY="YOUR_KEY"',
      `node tools/google-vision-test.mjs "${imagePath}"`,
    ].join("\n"),
  );
  process.exit(1);
}

const imageBytes = await readFile(imagePath);
const requestBody = {
  requests: [
    {
      image: {
        content: imageBytes.toString("base64"),
      },
      features: [
        {
          type: "DOCUMENT_TEXT_DETECTION",
          maxResults: 1,
        },
      ],
    },
  ],
};

const url = new URL("https://vision.googleapis.com/v1/images:annotate");
const auth = await getAuth();
if (auth.apiKey) url.searchParams.set("key", auth.apiKey);

const headers = {
  "Content-Type": "application/json; charset=utf-8",
};

if (auth.bearerToken) headers.Authorization = `Bearer ${auth.bearerToken}`;
if (auth.projectId) headers["x-goog-user-project"] = auth.projectId;

const response = await fetch(url, {
  method: "POST",
  headers,
  body: JSON.stringify(requestBody),
});

const result = await response.json();
await mkdir(outputDir, { recursive: true });
await writeFile(path.join(outputDir, "vision-response.json"), JSON.stringify(result, null, 2));

if (!response.ok || result.error || result.responses?.[0]?.error) {
  const apiError = result.error || result.responses?.[0]?.error;
  console.error(`Google Vision request failed: ${apiError?.message || response.statusText}`);
  if (auth.apiKey) {
    console.error("");
    console.error("This project/key rejected API-key auth. Use a service account JSON instead:");
    console.error('$env:GOOGLE_APPLICATION_CREDENTIALS="C:\\path\\to\\service-account.json"');
  }
  process.exit(1);
}

const annotation = result.responses?.[0]?.fullTextAnnotation;
const fullText = annotation?.text || result.responses?.[0]?.textAnnotations?.[0]?.description || "";
const words = collectWords(annotation);

await writeFile(path.join(outputDir, "vision-text.txt"), fullText);
await writeFile(path.join(outputDir, "vision-words.csv"), wordsToCsv(words));

const previewLines = fullText
  .split(/\r?\n/)
  .map((line) => line.trim())
  .filter(Boolean)
  .slice(0, 12);

console.log(`Image: ${imagePath}`);
console.log(`Output: ${outputDir}`);
console.log(`Auth: ${auth.kind}`);
console.log(`Text characters: ${fullText.length}`);
console.log(`Words: ${words.length}`);
console.log("");
console.log("First OCR lines:");
previewLines.forEach((line) => console.log(`  ${line}`));

function collectWords(annotation) {
  const words = [];

  for (const page of annotation?.pages || []) {
    for (const block of page.blocks || []) {
      for (const paragraph of block.paragraphs || []) {
        for (const word of paragraph.words || []) {
          const text = (word.symbols || []).map((symbol) => symbol.text || "").join("");
          const vertices = normalizeVertices(word.boundingBox?.vertices || []);
          words.push({
            text,
            confidence: word.confidence ?? "",
            x0: Math.min(...vertices.map((vertex) => vertex.x)),
            y0: Math.min(...vertices.map((vertex) => vertex.y)),
            x1: Math.max(...vertices.map((vertex) => vertex.x)),
            y1: Math.max(...vertices.map((vertex) => vertex.y)),
          });
        }
      }
    }
  }

  return words;
}

async function getAuth() {
  if (bearerToken) {
    return {
      kind: "bearer token",
      bearerToken,
      projectId: process.env.GOOGLE_CLOUD_PROJECT,
    };
  }

  if (serviceAccountPath) {
    const credentials = JSON.parse(await readFile(serviceAccountPath, "utf8"));
    return {
      kind: "service account",
      bearerToken: await getServiceAccountAccessToken(credentials),
      projectId: process.env.GOOGLE_CLOUD_PROJECT || credentials.project_id,
    };
  }

  return {
    kind: "API key",
    apiKey,
    projectId: process.env.GOOGLE_CLOUD_PROJECT,
  };
}

async function getServiceAccountAccessToken(credentials) {
  const now = Math.floor(Date.now() / 1000);
  const header = {
    alg: "RS256",
    typ: "JWT",
    kid: credentials.private_key_id,
  };
  const claimSet = {
    iss: credentials.client_email,
    scope: "https://www.googleapis.com/auth/cloud-vision",
    aud: "https://oauth2.googleapis.com/token",
    exp: now + 3600,
    iat: now,
  };
  const unsignedJwt = `${base64UrlJson(header)}.${base64UrlJson(claimSet)}`;
  const signature = crypto
    .createSign("RSA-SHA256")
    .update(unsignedJwt)
    .sign(credentials.private_key);
  const assertion = `${unsignedJwt}.${base64Url(signature)}`;
  const body = new URLSearchParams({
    grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
    assertion,
  });

  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body,
  });
  const result = await response.json();

  if (!response.ok || !result.access_token) {
    throw new Error(`Could not get Google access token: ${result.error_description || result.error || response.statusText}`);
  }

  return result.access_token;
}

function base64UrlJson(value) {
  return base64Url(Buffer.from(JSON.stringify(value), "utf8"));
}

function base64Url(value) {
  return Buffer.from(value)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function normalizeVertices(vertices) {
  return [0, 1, 2, 3].map((index) => ({
    x: Number(vertices[index]?.x || 0),
    y: Number(vertices[index]?.y || 0),
  }));
}

function wordsToCsv(words) {
  const rows = [["text", "confidence", "x0", "y0", "x1", "y1"], ...words.map((word) => [
    word.text,
    word.confidence,
    word.x0,
    word.y0,
    word.x1,
    word.y1,
  ])];

  return rows.map((row) => row.map(csvCell).join(",")).join("\n");
}

function csvCell(value) {
  const text = String(value ?? "");
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}
