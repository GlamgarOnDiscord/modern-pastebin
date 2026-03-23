const http = require("http");
const fs = require("fs");
const path = require("path");
const url = require("url");
const crypto = require("crypto");

// ==================== IN-MEMORY STORAGE ====================
const store = {};
const blobStore = {}; // pasteId -> { data: Buffer, fileName, fileType }

// TTL map (milliseconds)
const TTL_MAP = {
  "1h": 3600000,
  "6h": 21600000,
  "24h": 86400000,
  "7d": 604800000,
};

// Simulated Redis Hash operations for local dev
const kv = {
  hset(key, fields) {
    if (!store[key]) store[key] = {};
    Object.assign(store[key], fields);
  },
  hget(key, field) {
    return store[key] ? store[key][field] || null : null;
  },
  hgetall(key) {
    return store[key] || null;
  },
  del(key) {
    delete store[key];
  },
  set(key, value, opts) {
    store[key] = { _value: value };
    if (opts && opts.ex) {
      setTimeout(() => delete store[key], opts.ex * 1000);
    }
  },
  get(key) {
    return store[key] ? store[key]._value : null;
  },
  keys(pattern) {
    const prefix = pattern.replace("*", "");
    return Object.keys(store).filter((k) => k.startsWith(prefix));
  },
  expire(key, seconds) {
    setTimeout(() => delete store[key], seconds * 1000);
  },
};

// ==================== HELPERS ====================
function generateId(length = 6) {
  const chars = "ABCDEFGHJKMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789";
  const bytes = crypto.randomBytes(length);
  return Array.from(bytes, (b) => chars[b % chars.length]).join("");
}

function generateToken() {
  return crypto.randomUUID() + "-" + crypto.randomUUID();
}

// Note: XSS prevention is handled client-side via textContent (DOM API).
// No server-side sanitization needed — would cause double-encoding.

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
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "X-XSS-Protection": "1; mode=block",
    "Referrer-Policy": "no-referrer",
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
  if (req.method !== "POST")
    return sendJson(res, 405, { message: "Method Not Allowed" });

  const { pin, content, allowComments, ttl, burnAfterReading } = await parseBody(req);

  // Input validation
  const textContent = typeof content === "string" ? content : "";
  if (textContent.length > 100000) {
    return sendJson(res, 400, { message: "Content too large (max 100 KB)" });
  }

  if (pin !== null && pin !== undefined && pin !== "") {
    const pinStr = String(pin);
    if (
      pinStr.length < 4 ||
      pinStr.length > 8 ||
      !/^[a-zA-Z0-9]+$/.test(pinStr)
    ) {
      return sendJson(res, 400, {
        message: "PIN must be 4-8 alphanumeric characters",
      });
    }
  }

  let pasteId;
  let attempts = 0;
  do {
    pasteId = generateId();
    if (!kv.hget(`paste:${pasteId}`, "createdAt")) break;
    attempts++;
  } while (attempts < 5);

  if (attempts >= 5) {
    return sendJson(res, 500, { message: "Could not generate unique ID" });
  }

  const adminToken = generateToken();
  const viewerToken = generateToken();
  const now = Date.now();
  const ttlKey = TTL_MAP[ttl] ? ttl : "24h";
  const ttlMs = TTL_MAP[ttlKey];

  kv.hset(`paste:${pasteId}`, {
    content: textContent,
    pin: pin || "",
    adminToken,
    viewerToken,
    createdAt: now,
    allowComments:
      allowComments === true || allowComments === "true" ? "true" : "false",
    comments: "[]",
    ttl: ttlKey,
    burnAfterReading:
      burnAfterReading === true || burnAfterReading === "true"
        ? "true"
        : "false",
    burned: "false",
  });

  // Set auto-expiry
  kv.expire(`paste:${pasteId}`, ttlMs / 1000);

  sendJson(res, 200, {
    pasteId,
    adminToken,
    viewerToken,
    hasPin: !!(pin && pin !== ""),
    createdAt: now,
    ttl: ttlKey,
    burnAfterReading:
      burnAfterReading === true || burnAfterReading === "true",
  });
}

async function handleAuth(req, res) {
  if (req.method !== "POST")
    return sendJson(res, 405, { message: "Method Not Allowed" });

  const { pin, pasteId } = await parseBody(req);

  if (!pasteId || typeof pasteId !== "string" || pasteId.length > 20)
    return sendJson(res, 400, { message: "Invalid paste ID" });

  if (!/^[a-zA-Z0-9]+$/.test(pasteId))
    return sendJson(res, 400, { message: "Invalid paste ID format" });

  const paste = kv.hgetall(`paste:${pasteId}`);
  if (!paste || !paste.createdAt)
    return sendJson(res, 404, { message: "Paste not found" });

  if (paste.burned === "true")
    return sendJson(res, 410, { message: "This paste has been burned" });

  if (!paste.pin || paste.pin === "") {
    return sendJson(res, 200, {
      message: "Success",
      token: paste.viewerToken,
      role: "viewer",
    });
  }

  // Timing-safe PIN comparison
  if (pin) {
    const pinBuf = Buffer.from(String(pin));
    const storedBuf = Buffer.from(String(paste.pin));
    if (pinBuf.length === storedBuf.length && crypto.timingSafeEqual(pinBuf, storedBuf)) {
      return sendJson(res, 200, {
        message: "Success",
        token: paste.viewerToken,
        role: "viewer",
      });
    }
  }

  sendJson(res, 401, { message: "Invalid PIN" });
}

function handleContent(req, res) {
  if (req.method !== "GET")
    return sendJson(res, 405, { message: "Method Not Allowed" });

  const parsed = url.parse(req.url, true);
  const { id, token } = parsed.query;

  if (!id || typeof id !== "string" || id.length > 20)
    return sendJson(res, 400, { message: "Invalid paste ID" });

  if (!/^[a-zA-Z0-9]+$/.test(id))
    return sendJson(res, 400, { message: "Invalid paste ID format" });

  const paste = kv.hgetall(`paste:${id}`);
  if (!paste || !paste.createdAt)
    return sendJson(res, 404, { message: "Paste not found" });

  if (paste.burned === "true")
    return sendJson(res, 410, {
      message: "This paste has been burned after reading",
    });

  const isOpenAccess = !paste.pin || paste.pin === "";
  const isValidToken = token === paste.adminToken || token === paste.viewerToken;

  if (!isOpenAccess && !isValidToken) {
    return sendJson(res, 401, { message: "Unauthorized" });
  }

  const viewerCount = 0;

  // Burn after reading: first read destroys the paste for everyone
  if (paste.burnAfterReading === "true") {
    kv.hset(`paste:${id}`, { burned: "true" });
    if (blobStore[id]) delete blobStore[id];
  }

  const allowComments = paste.allowComments === "true";
  let comments = [];
  if (allowComments && paste.comments) {
    try {
      comments =
        typeof paste.comments === "string"
          ? JSON.parse(paste.comments)
          : paste.comments;
    } catch (e) {
      comments = [];
    }
  }

  sendJson(res, 200, {
    content: paste.content || "",
    allowComments,
    comments,
    viewerCount,
    ttl: paste.ttl || "24h",
    burnAfterReading: paste.burnAfterReading === "true",
    createdAt: paste.createdAt,
    blobUrl: paste.blobUrl || "",
    fileName: paste.fileName || "",
    fileSize: paste.fileSize ? parseInt(paste.fileSize, 10) : 0,
    fileType: paste.fileType || "",
  });
}

async function handleUpdate(req, res) {
  if (req.method !== "POST")
    return sendJson(res, 405, { message: "Method Not Allowed" });

  const { content, pasteId, adminToken } = await parseBody(req);

  if (!pasteId || typeof pasteId !== "string" || pasteId.length > 20)
    return sendJson(res, 400, { message: "Invalid paste ID" });

  const textContent = typeof content === "string" ? content : "";
  if (textContent.length > 100000) {
    return sendJson(res, 400, { message: "Content too large (max 100 KB)" });
  }

  const storedPaste = kv.hgetall(`paste:${pasteId}`);
  if (!storedPaste || !storedPaste.adminToken)
    return sendJson(res, 404, { message: "Paste not found" });
  if (adminToken !== storedPaste.adminToken)
    return sendJson(res, 401, { message: "Unauthorized" });
  if (storedPaste.burned === "true")
    return sendJson(res, 410, { message: "This paste has been burned" });

  kv.hset(`paste:${pasteId}`, { content: textContent });
  sendJson(res, 200, { message: "Saved successfully" });
}

async function handleComment(req, res) {
  if (req.method !== "POST")
    return sendJson(res, 405, { message: "Method Not Allowed" });

  const { pasteId, token, text } = await parseBody(req);

  if (!pasteId || !token || !text)
    return sendJson(res, 400, { message: "Missing data" });

  if (typeof text !== "string" || text.trim().length === 0)
    return sendJson(res, 400, { message: "Comment cannot be empty" });

  if (text.length > 500)
    return sendJson(res, 400, {
      message: "Comment too long (max 500 characters)",
    });

  const paste = kv.hgetall(`paste:${pasteId}`);
  if (!paste || !paste.createdAt)
    return sendJson(res, 404, { message: "Paste not found" });

  let author = null;
  if (token === paste.adminToken) author = "admin";
  else if (token === paste.viewerToken) author = "viewer";
  else return sendJson(res, 401, { message: "Unauthorized" });

  if (paste.allowComments !== "true")
    return sendJson(res, 403, { message: "Comments disabled" });

  let comments = [];
  try {
    comments =
      typeof paste.comments === "string"
        ? JSON.parse(paste.comments)
        : paste.comments || [];
  } catch (e) {
    comments = [];
  }

  if (comments.length >= 50)
    return sendJson(res, 400, { message: "Maximum comments reached (50)" });

  comments.push({
    author,
    text: text.trim(),
    timestamp: Date.now(),
  });

  kv.hset(`paste:${pasteId}`, { comments: JSON.stringify(comments) });
  sendJson(res, 200, { message: "Comment added" });
}

const ALLOWED_UPLOAD_TYPES = new Set([
  "text/plain", "text/html", "text/css", "text/javascript", "text/csv",
  "text/markdown", "text/xml",
  "application/json", "application/xml", "application/pdf",
  "application/zip", "application/x-zip-compressed", "application/x-tar",
  "application/gzip", "application/x-gzip",
  "image/jpeg", "image/png", "image/gif", "image/webp", "image/svg+xml",
  "image/bmp", "image/tiff",
  "audio/mpeg", "audio/wav", "audio/ogg", "audio/flac",
  "video/mp4", "video/webm", "video/ogg",
]);

const MAX_UPLOAD_SIZE = 4 * 1024 * 1024;

async function handleUpload(req, res) {
  const parsed = url.parse(req.url, true);
  const { pasteId, adminToken, fileName, fileType, fileSize } = parsed.query;

  if (!pasteId || typeof pasteId !== "string" || pasteId.length > 20)
    return sendJson(res, 400, { message: "Invalid paste ID" });
  if (!/^[a-zA-Z0-9]+$/.test(pasteId))
    return sendJson(res, 400, { message: "Invalid paste ID format" });
  if (!adminToken)
    return sendJson(res, 400, { message: "Missing admin token" });

  const paste = kv.hgetall(`paste:${pasteId}`);
  if (!paste || !paste.adminToken)
    return sendJson(res, 404, { message: "Paste not found" });
  if (adminToken !== paste.adminToken)
    return sendJson(res, 401, { message: "Unauthorized" });
  if (paste.burned === "true")
    return sendJson(res, 410, { message: "This paste has been burned" });

  if (req.method === "DELETE") {
    delete blobStore[pasteId];
    kv.hset(`paste:${pasteId}`, { blobUrl: "", fileName: "", fileSize: "", fileType: "" });
    return sendJson(res, 200, { message: "File removed" });
  }

  if (req.method !== "PUT") return sendJson(res, 405, { message: "Method Not Allowed" });

  if (!fileName || typeof fileName !== "string" || fileName.length > 255)
    return sendJson(res, 400, { message: "Invalid file name" });
  if (!fileType || !ALLOWED_UPLOAD_TYPES.has(fileType))
    return sendJson(res, 400, { message: "File type not allowed" });
  const size = parseInt(fileSize, 10);
  if (isNaN(size) || size <= 0 || size > MAX_UPLOAD_SIZE)
    return sendJson(res, 400, { message: "File too large (max 4 MB)" });

  const safeFileName = fileName.replace(/[^a-zA-Z0-9._\-()[\] ]/g, "_").slice(0, 255);

  const chunks = [];
  let received = 0;
  for await (const chunk of req) {
    received += chunk.length;
    if (received > MAX_UPLOAD_SIZE) return sendJson(res, 400, { message: "File too large (max 4 MB)" });
    chunks.push(chunk);
  }
  const data = Buffer.concat(chunks);

  blobStore[pasteId] = { data, fileName: safeFileName, fileType };
  kv.hset(`paste:${pasteId}`, {
    blobUrl: `/api/file?id=${pasteId}`,
    fileName: safeFileName,
    fileSize: String(data.length),
    fileType: fileType,
  });

  sendJson(res, 200, {
    blobUrl: `/api/file?id=${pasteId}`,
    fileName: safeFileName,
    fileSize: data.length,
    fileType: fileType,
  });
}

function handleFile(req, res) {
  if (req.method !== "GET") return sendJson(res, 405, { message: "Method Not Allowed" });
  const parsed = url.parse(req.url, true);
  const { id } = parsed.query;
  if (!id || !blobStore[id]) {
    res.writeHead(404, { "Content-Type": "text/plain" });
    return res.end("Not Found");
  }
  const { data, fileType, fileName } = blobStore[id];
  res.writeHead(200, {
    "Content-Type": fileType,
    "Content-Disposition": `attachment; filename="${fileName}"`,
    "Content-Length": data.length,
  });
  res.end(data);
}

async function handleDelete(req, res) {
  if (req.method !== "POST")
    return sendJson(res, 405, { message: "Method Not Allowed" });

  const { pasteId, adminToken } = await parseBody(req);

  if (!pasteId || typeof pasteId !== "string" || pasteId.length > 20)
    return sendJson(res, 400, { message: "Invalid paste ID" });

  if (!adminToken)
    return sendJson(res, 400, { message: "Missing admin token" });

  const storedToken = kv.hget(`paste:${pasteId}`, "adminToken");
  if (!storedToken)
    return sendJson(res, 404, { message: "Paste not found" });
  if (adminToken !== storedToken)
    return sendJson(res, 401, { message: "Unauthorized" });

  if (blobStore[pasteId]) delete blobStore[pasteId];
  kv.del(`paste:${pasteId}`);
  sendJson(res, 200, { message: "Paste deleted" });
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
      "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
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
    if (pathname === "/api/delete") return await handleDelete(req, res);
    if (pathname === "/api/upload") return await handleUpload(req, res);
    if (pathname === "/api/file") return handleFile(req, res);
  } catch (err) {
    console.error("API Error:", err);
    return sendJson(res, 500, { message: "Internal Server Error" });
  }

  // Static file serving
  if (pathname === "/view") {
    return serveStatic(res, path.join(PUBLIC_DIR, "view.html"));
  }

  let filePath = path.join(
    PUBLIC_DIR,
    pathname === "/" ? "index.html" : pathname
  );

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
