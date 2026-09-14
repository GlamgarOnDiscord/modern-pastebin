import crypto from "crypto";

const ID_CHARS = "ABCDEFGHJKMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789";

export function generateId(length = 6) {
  const bytes = crypto.getRandomValues(new Uint8Array(length));
  return Array.from(bytes, (b) => ID_CHARS[b % ID_CHARS.length]).join("");
}

export function generateToken() {
  return crypto.randomUUID() + "-" + crypto.randomUUID();
}

export function generateFileId() {
  return crypto.randomUUID().replace(/-/g, "").slice(0, 16);
}
