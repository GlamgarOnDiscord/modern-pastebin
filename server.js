const http = require("http");
const fs = require("fs");
const path = require("path");
const url = require("url");
const crypto = require("crypto");

// ==================== IN-MEMORY STORAGE ====================
const store = {};

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
  const isAdmin = token === paste.adminToken;

  if (!isOpenAccess && !isValidToken) {
    return sendJson(res, 401, { message: "Unauthorized" });
  }

  // Viewer tracking (lightweight, no KEYS scan)
  if (token) {
    kv.set(`v:${id}:${token.slice(0, 8)}`, "1", { ex: 30 });
  }

  const viewerCount = 0; // Removed expensive KEYS scan

  // Burn after reading on first non-admin read
  if (paste.burnAfterReading === "true" && !isAdmin) {
    kv.hset(`paste:${id}`, { burned: "true" });
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

  const storedToken = kv.hget(`paste:${pasteId}`, "adminToken");
  if (!storedToken)
    return sendJson(res, 404, { message: "Paste not found" });
  if (adminToken !== storedToken)
    return sendJson(res, 401, { message: "Unauthorized" });

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
    if (pathname === "/api/delete") return await handleDelete(req, res);
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
