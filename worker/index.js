const MAX_BODY_BYTES = 14 * 1024 * 1024;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === "POST" && url.pathname === "/api/vision") {
      return handleVision(request, env);
    }

    if (request.method === "GET" && url.pathname === "/api/health") {
      return jsonResponse({
        ok: true,
        googleAuth: env.GOOGLE_VISION_API_KEY ? "API key" : "not configured",
      });
    }

    return env.ASSETS.fetch(request);
  },
};

async function handleVision(request, env) {
  const body = await readJsonBody(request);
  const imageBase64 = String(body.imageBase64 || "").replace(/^data:image\/\w+;base64,/, "");
  const apiKey = String(env.GOOGLE_VISION_API_KEY || body.googleApiKey || "").trim();

  if (!imageBase64) {
    return jsonResponse({ error: "Missing image data" }, 400);
  }

  if (!apiKey) {
    return jsonResponse({ error: "Google Vision auth is not configured." }, 401);
  }

  const googleUrl = new URL("https://vision.googleapis.com/v1/images:annotate");
  googleUrl.searchParams.set("key", apiKey);

  const googleResponse = await fetch(googleUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json; charset=utf-8",
    },
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
    return jsonResponse(
      {
        error: apiError?.message || googleResponse.statusText || "Google Vision request failed",
        details: apiError || result,
      },
      googleResponse.status || 502,
    );
  }

  const annotation = result.responses?.[0]?.fullTextAnnotation;
  const text = annotation?.text || result.responses?.[0]?.textAnnotations?.[0]?.description || "";

  return jsonResponse({
    text,
    words: collectWords(annotation),
    auth: "API key",
  });
}

async function readJsonBody(request) {
  const contentLength = Number(request.headers.get("content-length") || 0);
  if (contentLength > MAX_BODY_BYTES) {
    throw new Error("Upload is too large.");
  }

  const text = await request.text();
  if (text.length > MAX_BODY_BYTES) {
    throw new Error("Upload is too large.");
  }

  try {
    return text ? JSON.parse(text) : {};
  } catch {
    throw new Error("Invalid JSON request body.");
  }
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

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
    },
  });
}
