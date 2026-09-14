// Shared access logic for the two kinds of file owners: pastes and drives.
import { kv } from "./db.js";
import { KINDS } from "./limits.js";
import { isValidId } from "./http.js";
import { parseState } from "./tree.js";

export function ownerKey(kind, id) {
  return `${kind}:${id}`;
}

export function filesKey(kind, id) {
  return `files:${kind}:${id}`;
}

export function blobPrefix(kind, id) {
  return `${kind}/${id}/`;
}

// Returns { owner } or { error, status }.
export async function loadOwner(kind, id) {
  if (!KINDS.has(kind)) return { error: "Invalid kind", status: 400 };
  if (!isValidId(id)) return { error: "Invalid ID", status: 400 };
  const owner = await kv.hgetall(ownerKey(kind, id));
  if (!owner || !owner.createdAt) return { error: `${kind === "drive" ? "Drive" : "Paste"} not found`, status: 404 };
  if (owner.burned === "true") return { error: "This content has been burned", status: 410 };
  return { owner };
}

export function roleFor(owner, token) {
  if (token && token === owner.adminToken) return "admin";
  if (token && token === owner.viewerToken) return "viewer";
  if (!owner.pin) return "viewer";
  return null;
}

export async function loadFiles(kind, id) {
  return parseState(await kv.hgetall(filesKey(kind, id)));
}

// Keeps the files hash expiring together with its owner.
export async function syncFilesTtl(kind, id) {
  const ttl = await kv.ttl(ownerKey(kind, id));
  if (ttl > 0) await kv.expire(filesKey(kind, id), ttl);
}

export async function writeFilesDiff(kind, id, diff) {
  const key = filesKey(kind, id);
  const fields = {};
  for (const [fileId, entry] of Object.entries(diff.set)) fields[fileId] = JSON.stringify(entry);
  if (diff.folders) fields.folders = JSON.stringify(diff.folders);
  if (Object.keys(fields).length) await kv.hset(key, fields);
  if (diff.del.length) await kv.hdel(key, ...diff.del);
  await syncFilesTtl(kind, id);
}

// Legacy single attachment stored directly on the paste hash (pre-2.1).
export function legacyFile(owner) {
  if (!owner.blobUrl) return null;
  return {
    fileId: "legacy", path: "", name: owner.fileName || "file", size: Number(owner.fileSize) || 0,
    type: owner.fileType || "application/octet-stream", createdAt: owner.createdAt, by: "admin",
  };
}
