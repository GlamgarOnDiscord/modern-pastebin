// Blob storage abstraction: Vercel Blob (private) in production, a disk-backed
// store under .local-blob/ for local development.
//
// Interface:
//   createUploadTarget({ pathname, contentType, maxSize }) -> { url, headers }
//   head(pathname) -> { size, contentType } | null
//   stream(pathname) -> { stream (web ReadableStream), size, contentType } | null
//   remove(pathnames)
//   list(prefix, cursor) -> { pathnames, cursor }

import fs from "fs";
import path from "path";
import crypto from "crypto";
import { Readable } from "stream";

export const isLocalStorage = !process.env.BLOB_READ_WRITE_TOKEN;

const BLOB_API_URL = "https://vercel.com/api/blob";
const BLOB_API_VERSION = "12";
const TOKEN_TTL_MS = 30 * 60 * 1000;

async function createBlobBackend() {
  const blob = await import("@vercel/blob");
  const { generateClientTokenFromReadWriteToken } = await import("@vercel/blob/client");

  return {
    async createUploadTarget({ pathname, contentType, maxSize }) {
      const clientToken = await generateClientTokenFromReadWriteToken({
        pathname,
        maximumSizeInBytes: maxSize,
        allowedContentTypes: [contentType],
        validUntil: Date.now() + TOKEN_TTL_MS,
        addRandomSuffix: false,
        allowOverwrite: true,
      });
      return {
        url: `${BLOB_API_URL}/?pathname=${encodeURIComponent(pathname)}`,
        headers: {
          authorization: `Bearer ${clientToken}`,
          "x-api-version": BLOB_API_VERSION,
          "x-vercel-blob-access": "private",
          "x-content-type": contentType,
        },
      };
    },
    async head(pathname) {
      try {
        const meta = await blob.head(pathname);
        return { size: meta.size, contentType: meta.contentType };
      } catch (e) {
        if (e instanceof blob.BlobNotFoundError) return null;
        throw e;
      }
    },
    async stream(pathname) {
      const result = await blob.get(pathname, { access: "private" });
      if (!result || result.statusCode !== 200) return null;
      return { stream: result.stream, size: result.blob.size, contentType: result.blob.contentType };
    },
    async remove(pathnames) {
      if (pathnames.length) await blob.del(pathnames);
    },
    async list(prefix, cursor) {
      const page = await blob.list({ prefix, cursor, limit: 1000 });
      return { pathnames: page.blobs.map((b) => b.pathname), cursor: page.hasMore ? page.cursor : null };
    },
  };
}

function createLocalBackend() {
  const root = path.resolve(process.cwd(), ".local-blob");
  const secret = crypto.randomBytes(32);

  const resolveSafe = (pathname) => {
    const full = path.resolve(root, pathname);
    if (!full.startsWith(root + path.sep)) throw new Error("Path escapes storage root");
    return full;
  };

  const sign = (params) => crypto.createHmac("sha256", secret).update(params.toString()).digest("hex");

  return {
    async createUploadTarget({ pathname, contentType, maxSize }) {
      const params = new URLSearchParams({ pathname, max: String(maxSize), exp: String(Date.now() + TOKEN_TTL_MS) });
      params.set("sig", sign(params));
      return { url: `/__blob__/put?${params}`, headers: { "x-content-type": contentType } };
    },
    async head(pathname) {
      try {
        const stat = await fs.promises.stat(resolveSafe(pathname));
        const type = await fs.promises.readFile(resolveSafe(pathname) + ".type", "utf8").catch(() => "application/octet-stream");
        return { size: stat.size, contentType: type };
      } catch {
        return null;
      }
    },
    async stream(pathname) {
      const meta = await this.head(pathname);
      if (!meta) return null;
      const nodeStream = fs.createReadStream(resolveSafe(pathname));
      return { stream: Readable.toWeb(nodeStream), size: meta.size, contentType: meta.contentType };
    },
    async remove(pathnames) {
      for (const p of pathnames) {
        await fs.promises.rm(resolveSafe(p), { force: true });
        await fs.promises.rm(resolveSafe(p) + ".type", { force: true });
      }
    },
    async list(prefix) {
      const out = [];
      const walk = async (dir, rel) => {
        let entries = [];
        try { entries = await fs.promises.readdir(dir, { withFileTypes: true }); } catch { return; }
        for (const e of entries) {
          const r = rel ? `${rel}/${e.name}` : e.name;
          if (e.isDirectory()) await walk(path.join(dir, e.name), r);
          else if (!e.name.endsWith(".type") && r.startsWith(prefix)) out.push(r);
        }
      };
      await walk(root, "");
      return { pathnames: out, cursor: null };
    },
    // Local-only: receives the browser PUT that production sends to Vercel Blob.
    async handleLocalPut(req, res, query) {
      const { pathname, max, exp, sig } = query;
      const params = new URLSearchParams({ pathname: pathname || "", max: max || "", exp: exp || "" });
      if (!sig || sig !== sign(params) || Number(exp) < Date.now()) {
        res.writeHead(403, { "Content-Type": "application/json" });
        return res.end(JSON.stringify({ message: "Invalid upload signature" }));
      }
      const full = resolveSafe(pathname);
      await fs.promises.mkdir(path.dirname(full), { recursive: true });
      const contentType = req.headers["x-content-type"] || "application/octet-stream";
      await fs.promises.writeFile(full + ".type", String(contentType));
      let received = 0;
      const limit = Number(max);
      const out = fs.createWriteStream(full);
      req.on("data", (chunk) => {
        received += chunk.length;
        if (received > limit) {
          req.destroy();
          out.destroy();
          fs.promises.rm(full, { force: true });
          res.writeHead(413, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ message: "File too large" }));
        }
      });
      req.pipe(out);
      out.on("finish", () => {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ pathname, url: `/__blob__/${pathname}`, contentType }));
      });
    },
  };
}

export const storage = isLocalStorage ? createLocalBackend() : await createBlobBackend();
