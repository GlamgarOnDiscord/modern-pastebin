import { kv } from "../lib/db.js";
import { storage } from "../lib/storage.js";
import { generateId, generateToken } from "../lib/ids.js";
import { securityHeaders, serverError, methodNotAllowed } from "../lib/http.js";
import { TTL_MAP, QUOTAS } from "../lib/limits.js";
import { loadOwner, roleFor, loadFiles, ownerKey, filesKey } from "../lib/owner.js";
import { publicListing } from "../lib/tree.js";

const MAX_NAME = 80;

function flag(v) {
  return v === true || v === "true" ? "true" : "false";
}

async function createDrive(req, res) {
  const { name, pin, ttl, burnAfterReading, allowViewerUpload } = req.body || {};

  const driveName = typeof name === "string" ? name.trim().slice(0, MAX_NAME) : "";

  if (pin !== null && pin !== undefined && pin !== "") {
    const pinStr = String(pin);
    if (pinStr.length < 4 || pinStr.length > 8 || !/^[a-zA-Z0-9]+$/.test(pinStr)) {
      return res.status(400).json({ message: "PIN must be 4-8 alphanumeric characters" });
    }
  }

  let driveId;
  let attempts = 0;
  do {
    driveId = generateId(8);
    if (!(await kv.hget(ownerKey("drive", driveId), "createdAt"))) break;
    attempts++;
  } while (attempts < 5);
  if (attempts >= 5) return res.status(500).json({ message: "Could not generate unique ID" });

  const adminToken = generateToken();
  const viewerToken = generateToken();
  const now = Date.now();
  const ttlKey = TTL_MAP[ttl] ? ttl : "24h";

  await kv.hset(ownerKey("drive", driveId), {
    name: driveName,
    pin: pin || "",
    adminToken,
    viewerToken,
    createdAt: now,
    ttl: ttlKey,
    burnAfterReading: flag(burnAfterReading),
    burned: "false",
    allowViewerUpload: flag(allowViewerUpload),
  });
  await kv.expire(ownerKey("drive", driveId), TTL_MAP[ttlKey]);

  return res.status(200).json({
    driveId, adminToken, viewerToken, name: driveName,
    hasPin: !!pin, createdAt: now, ttl: ttlKey,
    burnAfterReading: flag(burnAfterReading) === "true",
    allowViewerUpload: flag(allowViewerUpload) === "true",
  });
}

async function readDrive(req, res) {
  const { id, token } = req.query;
  const { owner, error, status } = await loadOwner("drive", id);
  if (error) return res.status(status).json({ message: error });

  const role = roleFor(owner, token);
  if (!role) return res.status(401).json({ message: "Unauthorized", hasPin: true });

  const state = await loadFiles("drive", id);

  if (owner.burnAfterReading === "true" && role === "viewer") {
    await kv.hset(ownerKey("drive", id), { burned: "true" });
    await kv.del(filesKey("drive", id));
    const pathnames = Object.values(state.files).map((f) => f.pathname).filter(Boolean);
    storage.remove(pathnames).catch(() => {});
  }

  const listing = publicListing(state);
  return res.status(200).json({
    name: owner.name || "",
    role,
    ttl: owner.ttl || "24h",
    createdAt: owner.createdAt,
    burnAfterReading: owner.burnAfterReading === "true",
    allowViewerUpload: owner.allowViewerUpload === "true",
    quota: QUOTAS.drive,
    ...listing,
  });
}

async function deleteDrive(req, res) {
  const { id, token } = req.query;
  const { owner, error, status } = await loadOwner("drive", id);
  if (error) return res.status(status).json({ message: error });
  if (roleFor(owner, token) !== "admin") return res.status(401).json({ message: "Unauthorized" });

  const state = await loadFiles("drive", id);
  const pathnames = Object.values(state.files).map((f) => f.pathname).filter(Boolean);
  await storage.remove(pathnames).catch(() => {});
  await kv.del(filesKey("drive", id));
  await kv.del(ownerKey("drive", id));
  return res.status(200).json({ message: "Drive deleted" });
}

export default async function handler(req, res) {
  securityHeaders(res);
  try {
    if (req.method === "POST") return await createDrive(req, res);
    if (req.method === "GET") return await readDrive(req, res);
    if (req.method === "DELETE") return await deleteDrive(req, res);
    return methodNotAllowed(res);
  } catch (error) {
    return serverError(res, "Drive", error);
  }
}
