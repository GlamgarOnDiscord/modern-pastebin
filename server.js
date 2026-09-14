// Local development server: serves public/ and routes /api/* to the same
// serverless handlers Vercel runs, through a small req/res shim.
// Storage and KV fall back to local backends when env vars are absent.

import http from "http";
import fs from "fs";
import path from "path";
import { fileURLToPath, pathToFileURL } from "url";
import { storage, isLocalStorage } from "./lib/storage.js";
import { isLocalKv } from "./lib/db.js";

const PORT = Number(process.env.PORT) || 3000;
const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(ROOT, "public");
const API_DIR = path.join(ROOT, "api");

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css",
  ".js": "application/javascript",
  ".json": "application/json",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
};

const PAGE_ALIASES = { "/": "index.html", "/view": "view.html", "/drive": "drive.html" };

const handlerCache = new Map();

async function loadHandler(apiPath) {
  if (!/^[a-z]+(\/[a-z]+)?$/.test(apiPath)) return null;
  const file = path.join(API_DIR, `${apiPath}.js`);
  if (!fs.existsSync(file)) return null;
  if (!handlerCache.has(file)) {
    handlerCache.set(file, import(pathToFileURL(file).href).then((m) => m.default));
  }
  return handlerCache.get(file);
}

function readJsonBody(req) {
  return new Promise((resolve) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      try { resolve(body ? JSON.parse(body) : {}); } catch { resolve({}); }
    });
    req.on("error", () => resolve({}));
  });
}

function shimResponse(res) {
  res.status = (code) => { res.statusCode = code; return res; };
  res.json = (data) => {
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify(data));
    return res;
  };
  res.send = (data) => { res.end(data); return res; };
  return res;
}

function serveStatic(res, filePath) {
  const mime = MIME_TYPES[path.extname(filePath)] || "application/octet-stream";
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { "Content-Type": "text/plain" });
      return res.end("Not Found");
    }
    res.writeHead(200, { "Content-Type": mime });
    res.end(data);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const pathname = url.pathname;
  const query = Object.fromEntries(url.searchParams);

  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    });
    return res.end();
  }

  if (pathname === "/__blob__/put" && isLocalStorage) {
    return storage.handleLocalPut(req, res, query);
  }

  if (pathname.startsWith("/api/")) {
    try {
      const handler = await loadHandler(pathname.slice(5));
      if (!handler) {
        res.writeHead(404, { "Content-Type": "application/json" });
        return res.end(JSON.stringify({ message: "Not Found" }));
      }
      req.query = query;
      req.body = (req.headers["content-type"] || "").includes("application/json") ? await readJsonBody(req) : {};
      return await handler(req, shimResponse(res));
    } catch (err) {
      console.error("API Error:", err);
      if (!res.headersSent) {
        res.writeHead(500, { "Content-Type": "application/json" });
        return res.end(JSON.stringify({ message: "Internal Server Error" }));
      }
      return res.end();
    }
  }

  const relative = PAGE_ALIASES[pathname] || pathname;
  const filePath = path.join(PUBLIC_DIR, relative);
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    return res.end("Forbidden");
  }
  serveStatic(res, filePath);
});

server.listen(PORT, () => {
  console.log(`\n  Scribble is running at http://localhost:${PORT}`);
  console.log(`  KV: ${isLocalKv ? "in-memory" : "Vercel KV"}  Blob: ${isLocalStorage ? ".local-blob/" : "Vercel Blob"}\n`);
});
