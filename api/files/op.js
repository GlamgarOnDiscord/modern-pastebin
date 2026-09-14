import { storage } from "../../lib/storage.js";
import { securityHeaders, serverError, methodNotAllowed } from "../../lib/http.js";
import { loadOwner, roleFor, loadFiles, writeFilesDiff } from "../../lib/owner.js";
import { applyOps, publicListing, TreeError } from "../../lib/tree.js";

export default async function handler(req, res) {
  securityHeaders(res);
  if (req.method !== "POST") return methodNotAllowed(res);

  try {
    const { kind, id, token, ops } = req.body || {};
    const { owner, error, status } = await loadOwner(kind, id);
    if (error) return res.status(status).json({ message: error });
    if (roleFor(owner, token) !== "admin") return res.status(401).json({ message: "Unauthorized" });

    const state = await loadFiles(kind, id);
    const { state: next, diff } = applyOps(state, ops);
    await writeFilesDiff(kind, id, diff);
    if (diff.blobsToDelete.length) {
      await storage.remove(diff.blobsToDelete).catch((e) => console.error("Blob delete:", e));
    }

    return res.status(200).json(publicListing(next));
  } catch (error) {
    if (error instanceof TreeError) return res.status(error.status).json({ message: error.message });
    return serverError(res, "File op", error);
  }
}
