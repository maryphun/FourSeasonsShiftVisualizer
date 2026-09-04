import crypto from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const rootDir = path.dirname(fileURLToPath(import.meta.url));
const localConfigPath = path.join(rootDir, "server.local-config.mjs");
const port = Number(process.env.PORT || 5177);
const host = process.env.HOST || "127.0.0.1";
const maxBodyBytes = 14 * 1024 * 1024;

const mimeTypes = new Map([
  [".html", "text/html; charset=utf-8"],
  [".css", "text/css; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".mjs", "text/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".png", "image/png"],
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".webp", "image/webp"],
  [".svg", "image/svg+xml"],
  [".ttf", "font/ttf"],
]);

const server = http.createServer(async (request, response) => {
  try {
    if (request.method === "POST" && request.url === "/api/vision") {
      await handleVision(request, response);
      return;
    }

    if (request.method === "GET" && request.url === "/api/health") {
      sendJson(response, 200, {
        ok: true,
        googleAuth: await describeConfiguredAuth(),
      });
      return;
    }

    if (request.method === "GET" || request.method === "HEAD") {
      await serveStatic(request, response);
      return;
    }

    sendJson(response, 405, { error: "Method not allowed" });
  } catch (error) {
    console.error(error);
    sendJson(response, 500, { error: error.message || "Server error" });
  }
});

server.listen(port, host, async () => {
  console.log(`Schedule Photo Reader running at http://${host}:${port}`);
  console.log(`Google auth: ${await describeConfiguredAuth()}`);
});

async function handleVision(request, response) {
  const body = await readJsonBody(request);
  const imageBase64 = String(body.imageBase64 || "").replace(/^data:image\/\w+;base64,/, "");

  if (!imageBase64) {
    sendJson(response, 400, { error: "Missing image data" });
    return;
  }

  const auth = await getAuth({
    oneOffApiKey: body.googleApiKey,
    oneOffToken: body.googleOAuthToken,
  });
  if (!auth.apiKey && !auth.bearerToken) {
    sendJson(response, 401, {
      error:
        "Google Vision auth is not configured. Paste the key into server.local-config.mjs, or set GOOGLE_OAUTH_TOKEN, GOOGLE_APPLICATION_CREDENTIALS, or GOOGLE_API_KEY before starting the server.",
    });
    return;
  }

  const url = new URL("https://vision.googleapis.com/v1/images:annotate");
  if (auth.apiKey) url.searchParams.set("key", auth.apiKey);

  const headers = {
    "Content-Type": "application/json; charset=utf-8",
  };
  if (auth.bearerToken) headers.Authorization = `Bearer ${auth.bearerToken}`;
  if (auth.projectId) headers["x-goog-user-project"] = auth.projectId;

  const googleResponse = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify({
      requests: [
        {
          image: {
            content: imageBase64,
          },
          features: [
            {
              type: "DOCUMENT_TEXT_DETECTION",
              maxResults: 1,
            },
          ],
        },
      ],
    }),
  });

  const result = await googleResponse.json();
  const apiError = result.error || result.responses?.[0]?.error;

  if (!googleResponse.ok || apiError) {
    sendJson(response, googleResponse.status || 502, {
      error: apiError?.message || googleResponse.statusText || "Google Vision request failed",
      details: apiError || result,
    });
    return;
  }

  const annotation = result.responses?.[0]?.fullTextAnnotation;
  const text = annotation?.text || result.responses?.[0]?.textAnnotations?.[0]?.description || "";

  sendJson(response, 200, {
    text,
    words: collectWords(annotation),
    auth: auth.kind,
  });
}

async function serveStatic(request, response) {
  const requestUrl = new URL(request.url || "/", `http://${host}:${port}`);
  const pathname = decodeURIComponent(requestUrl.pathname);
  const relativePath = pathname === "/" ? "index.html" : pathname.slice(1);
  const resolvedPath = path.resolve(rootDir, relativePath);

  if (!resolvedPath.startsWith(rootDir)) {
    sendText(response, 403, "Forbidden");
    return;
  }

  const fileStat = await stat(resolvedPath).catch(() => null);
  if (!fileStat?.isFile()) {
    sendText(response, 404, "Not found");
    return;
  }

  const contentType = mimeTypes.get(path.extname(resolvedPath).toLowerCase()) || "application/octet-stream";
  response.writeHead(200, {
    "Content-Type": contentType,
    "Cache-Control": "no-store",
  });

  if (request.method === "HEAD") {
    response.end();
    return;
  }

  createReadStream(resolvedPath).pipe(response);
}

function readJsonBody(request) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];

    request.on("data", (chunk) => {
      size += chunk.length;
      if (size > maxBodyBytes) {
        reject(new Error("Upload is too large for this local test server."));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });

    request.on("end", () => {
      try {
        const text = Buffer.concat(chunks).toString("utf8");
        resolve(text ? JSON.parse(text) : {});
      } catch {
        reject(new Error("Invalid JSON request body."));
      }
    });

    request.on("error", reject);
  });
}

function collectWords(annotation) {
  const words = [];

  for (const page of annotation?.pages || []) {
    for (const block of page.blocks || []) {
      for (const paragraph of block.paragraphs || []) {
        for (const word of paragraph.words || []) {
          const vertices = normalizeVertices(word.boundingBox?.vertices || []);
          words.push({
            text: (word.symbols || []).map((symbol) => symbol.text || "").join(""),
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

function normalizeVertices(vertices) {
  return [0, 1, 2, 3].map((index) => ({
    x: Number(vertices[index]?.x || 0),
    y: Number(vertices[index]?.y || 0),
  }));
}

async function getAuth({ oneOffApiKey = "", oneOffToken = "" } = {}) {
  const localConfig = await loadLocalConfig();
  const projectId = firstUsefulValue(
    localConfig.GOOGLE_CLOUD_PROJECT,
    localConfig.googleCloudProject,
    process.env.GOOGLE_CLOUD_PROJECT,
  );

  if (oneOffApiKey) {
    return {
      kind: "one-off browser API key",
      apiKey: oneOffApiKey,
      projectId,
    };
  }

  if (oneOffToken) {
    return {
      kind: "one-off browser token",
      bearerToken: oneOffToken,
      projectId,
    };
  }

  const bearerToken = firstUsefulValue(
    localConfig.GOOGLE_OAUTH_TOKEN,
    localConfig.googleOAuthToken,
    process.env.GOOGLE_OAUTH_TOKEN,
    process.env.GCLOUD_ACCESS_TOKEN,
  );
  if (bearerToken) {
    return {
      kind: "bearer token",
      bearerToken,
      projectId,
    };
  }

  if (process.env.GOOGLE_APPLICATION_CREDENTIALS) {
    const credentials = JSON.parse(await readFile(process.env.GOOGLE_APPLICATION_CREDENTIALS, "utf8"));
    return {
      kind: "service account",
      bearerToken: await getServiceAccountAccessToken(credentials),
      projectId: projectId || credentials.project_id,
    };
  }

  const apiKey = firstUsefulValue(
    localConfig.GOOGLE_VISION_API_KEY,
    localConfig.googleVisionApiKey,
    process.env.GOOGLE_VISION_API_KEY,
    process.env.GOOGLE_API_KEY,
  );
  if (apiKey) {
    return {
      kind: "API key",
      apiKey,
      projectId,
    };
  }

  return { kind: "none" };
}

async function loadLocalConfig() {
  const configStat = await stat(localConfigPath).catch(() => null);
  if (!configStat?.isFile()) return {};

  try {
    const moduleUrl = `${pathToFileURL(localConfigPath).href}?mtime=${configStat.mtimeMs}`;
    const module = await import(moduleUrl);
    return {
      ...(isPlainObject(module.default) ? module.default : {}),
      ...module,
    };
  } catch (error) {
    throw new Error(`Could not load server.local-config.mjs: ${error.message}`);
  }
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

async function describeConfiguredAuth() {
  const localConfig = await loadLocalConfig();
  const bearerToken = firstUsefulValue(
    localConfig.GOOGLE_OAUTH_TOKEN,
    localConfig.googleOAuthToken,
    process.env.GOOGLE_OAUTH_TOKEN,
    process.env.GCLOUD_ACCESS_TOKEN,
  );
  const apiKey = firstUsefulValue(
    localConfig.GOOGLE_VISION_API_KEY,
    localConfig.googleVisionApiKey,
    process.env.GOOGLE_VISION_API_KEY,
    process.env.GOOGLE_API_KEY,
  );

  if (bearerToken) return "bearer token";
  if (process.env.GOOGLE_APPLICATION_CREDENTIALS) return "service account";
  if (apiKey) return "API key";
  return "not configured";
}

function firstUsefulValue(...values) {
  const placeholders = new Set([
    "PASTE_GOOGLE_VISION_API_KEY_HERE",
    "PASTE_GOOGLE_CLOUD_PROJECT_ID_HERE",
    "YOUR_GOOGLE_VISION_API_KEY",
    "YOUR_GOOGLE_CLOUD_PROJECT_ID",
  ]);

  for (const value of values) {
    const text = String(value || "").trim();
    if (text && !placeholders.has(text)) return text;
  }

  return "";
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function sendJson(response, status, value) {
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  response.end(JSON.stringify(value, null, 2));
}

function sendText(response, status, value) {
  response.writeHead(status, {
    "Content-Type": "text/plain; charset=utf-8",
    "Cache-Control": "no-store",
  });
  response.end(value);
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
