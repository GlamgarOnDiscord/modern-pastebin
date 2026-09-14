import { kv } from "../../lib/db.js";
import { storage } from "../../lib/storage.js";
import { generateFileId } from "../../lib/ids.js";
import { securityHeaders, serverError, methodNotAllowed } from "../../lib/http.js";
import { MAX_FILE_SIZE } from "../../lib/limits.js";
import { loadOwner, roleFor, loadFiles, filesKey, blobPrefix, syncFilesTtl } from "../../lib/owner.js";
import { normalizePath, sanitizeName, checkQuota, TreeError } from "../../lib/tree.js";

const CONTENT_TYPE_RE = /^[\w.+-]+\/[\w.+-]+$/;

export default async function handler(req, res) {
  securityHeaders(res);
  if (req.method !== "POST") return methodNotAllowed(res);

  try {
    const { kind, id, token, path, name, size, type } = req.body || {};
    const { owner, error, status } = await loadOwner(kind, id);
    if (error) return res.status(status).json({ message: error });

    const role = roleFor(owner, token);
    const canUpload = role === "admin" || (role === "viewer" && kind === "drive" && owner.allowViewerUpload === "true");
    if (!canUpload) return res.status(401).json({ message: "Unauthorized" });

    const contentType = typeof type === "string" && CONTENT_TYPE_RE.test(type) && type.length <= 100
      ? type : "application/octet-stream";
    const fileSize = Number(size);

    const state = await loadFiles(kind, id);
    const folder = normalizePath(path);
    const safeName = sanitizeName(name);
    checkQuota(state, kind, fileSize);

    const fileId = generateFileId();
    const pathname = `${blobPrefix(kind, id)}${fileId}/${safeName}`;
    const entry = {
      path: folder, name: safeName, size: fileSize, type: contentType,
      pathname, createdAt: Date.now(), by: role, pending: true,
    };
    await kv.hset(filesKey(kind, id), { [fileId]: JSON.stringify(entry) });
    await syncFilesTtl(kind, id);

    const upload = await storage.createUploadTarget({ pathname, contentType, maxSize: Math.min(fileSize, MAX_FILE_SIZE) });
    return res.status(200).json({ fileId, upload });
  } catch (error) {
    if (error instanceof TreeError) return res.status(error.status).json({ message: error.message });
    return serverError(res, "Upload token", error);
  }
}
