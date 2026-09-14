import { Readable } from "stream";
import { storage } from "../../lib/storage.js";
import { securityHeaders, serverError, methodNotAllowed } from "../../lib/http.js";
import { loadOwner, roleFor, loadFiles, legacyFile } from "../../lib/owner.js";

// Types safe to render inline; everything else is forced to download.
const INLINE_RE = /^(image\/(png|jpeg|gif|webp|bmp|avif)|text\/plain|application\/pdf|audio\/|video\/)/;

export default async function handler(req, res) {
  securityHeaders(res);
  if (req.method !== "GET") return methodNotAllowed(res);

  try {
    const { kind, id, token, fileId, inline } = req.query;
    const { owner, error, status } = await loadOwner(kind, id);
    if (error) return res.status(status).json({ message: error });
    if (!roleFor(owner, token)) return res.status(401).json({ message: "Unauthorized" });

    let entry = null;
    if (fileId === "legacy") {
      const legacy = legacyFile(owner);
      if (legacy) entry = { ...legacy, pathname: owner.blobUrl };
    } else if (typeof fileId === "string" && /^[a-f0-9]{16}$/.test(fileId)) {
      const state = await loadFiles(kind, id);
      entry = state.files[fileId];
      if (entry && entry.pending) entry = null;
    }
    if (!entry) return res.status(404).json({ message: "File not found" });

    const result = await storage.stream(entry.pathname);
    if (!result) return res.status(502).json({ message: "File unavailable" });

    const type = entry.type || result.contentType || "application/octet-stream";
    const isInline = inline === "1" && INLINE_RE.test(type);
    const disposition = isInline ? "inline" : "attachment";
    res.setHeader("Content-Type", isInline ? type : "application/octet-stream");
    res.setHeader("Content-Disposition", `${disposition}; filename*=UTF-8''${encodeURIComponent(entry.name)}`);
    if (result.size) res.setHeader("Content-Length", String(result.size));
    res.setHeader("Cache-Control", "private, no-store");
    if (isInline) res.setHeader("X-Frame-Options", "SAMEORIGIN");
    res.status(200);
    Readable.fromWeb(result.stream).pipe(res);
  } catch (error) {
    return serverError(res, "File get", error);
  }
}
