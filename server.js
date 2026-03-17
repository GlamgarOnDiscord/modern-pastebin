const http = require("http");
const fs = require("fs");
const path = require("path");
const url = require("url");

// ==================== IN-MEMORY STORAGE ====================
const store = {};

const PASTE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

const kv = {
  get(key) {
    return store[key] !== undefined ? store[key] : null;
  },
  set(key, value) {
    store[key] = value;
  },
};

// Auto-cleanup expired pastes every 10 minutes
setInterval(() => {
  const now = Date.now();
  const seen = new Set();
  for (const key of Object.keys(store)) {
    const match = key.match(/^paste:(.+?):/);
    if (match && !seen.has(match[1])) {
      seen.add(match[1]);
      const createdAt = store[`paste:${match[1]}:createdAt`];
      if (createdAt && now - createdAt > PASTE_TTL_MS) {
        for (const k of Object.keys(store)) {
          if (k.startsWith(`paste:${match[1]}:`)) delete store[k];
        }
        console.log(`  ✕ Expired paste ${match[1]}`);
      }
    }
  }
}, 10 * 60 * 1000);

// ==================== HELPERS ====================
function generateId(length = 5) {
  const chars = "ABCDEFGHJKMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789";
  let result = "";
  for (let i = 0; i < length; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return result;
}

function generateToken() {
  const chars =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let result = "";
  for (let i = 0; i < 48; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return result;
}

function parseBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch {
        resolve({});
      }
    });
    req.on("error", reject);
  });
}

function sendJson(res, status, data) {
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
  });
  res.end(JSON.stringify(data));
}

const MIME_TYPES = {
  ".html": "text/html",
  ".css": "text/css",
  ".js": "application/javascript",
  ".json": "application/json",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
};

function serveStatic(res, filePath) {
  const ext = path.extname(filePath);
  const mime = MIME_TYPES[ext] || "application/octet-stream";

  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("Not Found");
      return;
    }
    res.writeHead(200, { "Content-Type": mime });
    res.end(data);
  });
}

// ==================== API HANDLERS ====================
async function handleCreate(req, res) {
  if (req.method !== "POST") return sendJson(res, 405, { message: "Method Not Allowed" });

  const { pin, content, allowComments } = await parseBody(req);

  let pasteId;
  let attempts = 0;
  do {
    pasteId = generateId();
    if (!kv.get(`paste:${pasteId}:createdAt`)) break;
    attempts++;
  } while (attempts < 5);

  if (attempts >= 5) {
    return sendJson(res, 500, { message: "Could not generate unique ID" });
  }

  const adminToken = generateToken();
  const viewerToken = generateToken();
  const now = Date.now();

  kv.set(`paste:${pasteId}:content`, content || "");
  kv.set(`paste:${pasteId}:pin`, pin || null);
  kv.set(`paste:${pasteId}:adminToken`, adminToken);
  kv.set(`paste:${pasteId}:viewerToken`, viewerToken);
  kv.set(`paste:${pasteId}:createdAt`, now);
  kv.set(`paste:${pasteId}:allowComments`, String(allowComments === true || allowComments === "true"));
  kv.set(`paste:${pasteId}:comments`, JSON.stringify([]));

  sendJson(res, 200, { pasteId, adminToken, viewerToken, hasPin: !!pin, createdAt: now });
}

async function handleAuth(req, res) {
  if (req.method !== "POST") return sendJson(res, 405, { message: "Method Not Allowed" });

  const { pin, pasteId } = await parseBody(req);

  if (!pasteId) return sendJson(res, 400, { message: "Missing paste ID" });

  const createdAt = kv.get(`paste:${pasteId}:createdAt`);
  if (!createdAt) return sendJson(res, 404, { message: "Paste not found" });

  const storedPin = kv.get(`paste:${pasteId}:pin`);

  if (!storedPin) {
    const viewerToken = kv.get(`paste:${pasteId}:viewerToken`);
    return sendJson(res, 200, { message: "Success", token: viewerToken, role: "viewer" });
  }

  if (pin === storedPin) {
    const viewerToken = kv.get(`paste:${pasteId}:viewerToken`);
    return sendJson(res, 200, { message: "Success", token: viewerToken, role: "viewer" });
  }

  sendJson(res, 401, { message: "Invalid PIN" });
}

function handleContent(req, res) {
  if (req.method !== "GET") return sendJson(res, 405, { message: "Method Not Allowed" });

  const parsed = url.parse(req.url, true);
  const { id, token } = parsed.query;

  if (!id) return sendJson(res, 400, { message: "Missing paste ID" });

  const createdAt = kv.get(`paste:${id}:createdAt`);
  if (!createdAt) return sendJson(res, 404, { message: "Paste not found" });

  const adminToken = kv.get(`paste:${id}:adminToken`);
  const viewerToken = kv.get(`paste:${id}:viewerToken`);
  const storedPin = kv.get(`paste:${id}:pin`);

  const isOpenAccess = !storedPin;
  const isValidToken = token === adminToken || token === viewerToken;

  if (!isOpenAccess && !isValidToken) {
    return sendJson(res, 401, { message: "Unauthorized" });
  }

  if (token) {
    kv.set(`paste:${id}:viewers:${token}`, Date.now());
  }

  let viewerCount = 0;
  const now = Date.now();
  for (const k of Object.keys(store)) {
    if (k.startsWith(`paste:${id}:viewers:`)) {
      if (now - store[k] > 10000) {
        delete store[k];
      } else {
        viewerCount++;
      }
    }
  }

  const allowCommentsStr = kv.get(`paste:${id}:allowComments`);
  const allowComments = allowCommentsStr === "true" || allowCommentsStr === true;
  let comments = [];
  if (allowComments) {
    const rawComments = kv.get(`paste:${id}:comments`);
    try { comments = rawComments ? JSON.parse(rawComments) : []; } catch(e) {}
  }

  const content = kv.get(`paste:${id}:content`) || "";
  sendJson(res, 200, { content, allowComments, comments, viewerCount });
}

async function handleUpdate(req, res) {
  if (req.method !== "POST") return sendJson(res, 405, { message: "Method Not Allowed" });

  const { content, pasteId, adminToken } = await parseBody(req);

  if (!pasteId) return sendJson(res, 400, { message: "Missing paste ID" });

  const storedToken = kv.get(`paste:${pasteId}:adminToken`);
  if (!storedToken) return sendJson(res, 404, { message: "Paste not found" });
  if (adminToken !== storedToken) return sendJson(res, 401, { message: "Unauthorized" });

  kv.set(`paste:${pasteId}:content`, content || "");
  sendJson(res, 200, { message: "Saved successfully" });
}

async function handleComment(req, res) {
  if (req.method !== "POST") return sendJson(res, 405, { message: "Method Not Allowed" });

  const { pasteId, token, text } = await parseBody(req);

  if (!pasteId || !token || !text) return sendJson(res, 400, { message: "Missing data" });

  const adminToken = kv.get(`paste:${pasteId}:adminToken`);
  const viewerToken = kv.get(`paste:${pasteId}:viewerToken`);

  let author = null;
  if (token === adminToken) author = "admin";
  else if (token === viewerToken) author = "viewer";
  else return sendJson(res, 401, { message: "Unauthorized" });

  const allowCommentsStr = kv.get(`paste:${pasteId}:allowComments`);
  const allowComments = allowCommentsStr === "true" || allowCommentsStr === true;
  if (!allowComments) return sendJson(res, 403, { message: "Comments disabled" });

  let comments = [];
  const rawComments = kv.get(`paste:${pasteId}:comments`);
  try { comments = rawComments ? JSON.parse(rawComments) : []; } catch(e) {}

  comments.push({ author, text, timestamp: Date.now() });
  kv.set(`paste:${pasteId}:comments`, JSON.stringify(comments));

  sendJson(res, 200, { message: "Comment added" });
}

// ==================== SERVER ====================
const PORT = 3000;
const PUBLIC_DIR = path.join(__dirname, "public");

const server = http.createServer(async (req, res) => {
  const parsed = url.parse(req.url, true);
  const pathname = parsed.pathname;

  // CORS preflight
  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    });
    return res.end();
  }

  // API Routes
  try {
    if (pathname === "/api/create") return await handleCreate(req, res);
    if (pathname === "/api/auth") return await handleAuth(req, res);
    if (pathname === "/api/content") return handleContent(req, res);
    if (pathname === "/api/update") return await handleUpdate(req, res);
    if (pathname === "/api/comment") return await handleComment(req, res);
  } catch (err) {
    console.error("API Error:", err);
    return sendJson(res, 500, { message: "Internal Server Error" });
  }

  // Static file serving
  if (pathname === "/view") {
    return serveStatic(res, path.join(PUBLIC_DIR, "view.html"));
  }

  let filePath = path.join(PUBLIC_DIR, pathname === "/" ? "index.html" : pathname);

  // Security: prevent directory traversal
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    return res.end("Forbidden");
  }

  serveStatic(res, filePath);
});

server.listen(PORT, () => {
  console.log(`\n  ✦ Scribble is running at http://localhost:${PORT}\n`);
});
