import { kv } from "../../lib/db.js";
import { storage } from "../../lib/storage.js";
import { securityHeaders, serverError, methodNotAllowed } from "../../lib/http.js";
import { MAX_FILE_SIZE, QUOTAS } from "../../lib/limits.js";
import { loadOwner, roleFor, loadFiles, filesKey, syncFilesTtl } from "../../lib/owner.js";
import { usage } from "../../lib/tree.js";

function publicEntry(fileId, e) {
  return { fileId, path: e.path || "", name: e.name, size: e.size, type: e.type, createdAt: e.createdAt, by: e.by };
}

export default async function handler(req, res) {
  securityHeaders(res);
  if (req.method !== "POST") return methodNotAllowed(res);

  try {
    const { kind, id, token, fileId } = req.body || {};
    const { owner, error, status } = await loadOwner(kind, id);
    if (error) return res.status(status).json({ message: error });
    if (!roleFor(owner, token)) return res.status(401).json({ message: "Unauthorized" });
    if (typeof fileId !== "string" || !/^[a-f0-9]{16}$/.test(fileId)) return res.status(400).json({ message: "Invalid file ID" });

    const state = await loadFiles(kind, id);
    const entry = state.files[fileId];
    if (!entry) return res.status(404).json({ message: "Upload not found" });
    if (!entry.pending) return res.status(200).json({ file: publicEntry(fileId, entry) });

    const meta = await storage.head(entry.pathname);
    if (!meta) return res.status(409).json({ message: "Upload not received" });

    const others = { files: Object.fromEntries(Object.entries(state.files).filter(([k]) => k !== fileId)) };
    const { total } = usage(others);
    if (meta.size > MAX_FILE_SIZE || total + meta.size > QUOTAS[kind].maxTotal) {
      await storage.remove([entry.pathname]).catch(() => {});
      await kv.hdel(filesKey(kind, id), fileId);
      return res.status(413).json({ message: "Storage quota exceeded" });
    }

    const committed = { ...entry, size: meta.size, type: meta.contentType || entry.type };
    delete committed.pending;
    await kv.hset(filesKey(kind, id), { [fileId]: JSON.stringify(committed) });
    await syncFilesTtl(kind, id);

    return res.status(200).json({ file: publicEntry(fileId, committed) });
  } catch (error) {
    return serverError(res, "Upload commit", error);
  }
}
