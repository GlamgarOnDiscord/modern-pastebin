import { kv } from "../lib/db.js";
import { securityHeaders } from "../lib/http.js";
import { storage } from "../lib/storage.js";
import { loadFiles, filesKey } from "../lib/owner.js";

export default async function handler(req, res) {
  securityHeaders(res);

  if (req.method !== "POST") {
    return res.status(405).json({ message: "Method Not Allowed" });
  }

  try {
    const { pasteId, adminToken } = req.body;

    if (!pasteId || typeof pasteId !== "string" || pasteId.length > 20) {
      return res.status(400).json({ message: "Invalid paste ID" });
    }

    if (!adminToken) {
      return res.status(400).json({ message: "Missing admin token" });
    }

    // ── Verify admin token ──
    const paste = await kv.hgetall(`paste:${pasteId}`);
    if (!paste || !paste.adminToken) {
      return res.status(404).json({ message: "Paste not found" });
    }

    if (adminToken !== paste.adminToken) {
      return res.status(401).json({ message: "Unauthorized" });
    }

    // ── Delete all attached blobs ──
    const fileState = await loadFiles("paste", pasteId);
    const pathnames = Object.values(fileState.files).map((f) => f.pathname);
    if (paste.blobUrl) pathnames.push(paste.blobUrl);
    await storage.remove(pathnames.filter(Boolean)).catch(() => {});
    await kv.del(filesKey("paste", pasteId));

    // ── Delete the entire paste hash ──
    await kv.del(`paste:${pasteId}`);

    return res.status(200).json({ message: "Paste deleted" });
  } catch (error) {
    console.error("Delete Error:", error);
    return res.status(500).json({ message: "Internal Server Error" });
  }
}
