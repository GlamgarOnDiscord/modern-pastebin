import { kv } from "../lib/db.js";
import { securityHeaders } from "../lib/http.js";
import { generateId, generateToken } from "../lib/ids.js";
import { TTL_MAP } from "../lib/limits.js";

export default async function handler(req, res) {
  securityHeaders(res);

  if (req.method !== "POST") {
    return res.status(405).json({ message: "Method Not Allowed" });
  }

  try {
    const { pin, content, allowComments, ttl, burnAfterReading } = req.body;

    // ── Input Validation ──
    const textContent = typeof content === "string" ? content : "";
    if (textContent.length > 100_000) {
      return res.status(400).json({ message: "Content too large (max 100 KB)" });
    }

    if (pin !== null && pin !== undefined && pin !== "") {
      const pinStr = String(pin);
      if (pinStr.length < 4 || pinStr.length > 8 || !/^[a-zA-Z0-9]+$/.test(pinStr)) {
        return res.status(400).json({ message: "PIN must be 4-8 alphanumeric characters" });
      }
    }

    // ── Generate unique paste ID ──
    let pasteId;
    let attempts = 0;
    do {
      pasteId = generateId();
      const existing = await kv.hget(`paste:${pasteId}`, "createdAt");
      if (!existing) break;
      attempts++;
    } while (attempts < 5);

    if (attempts >= 5) {
      return res.status(500).json({ message: "Could not generate unique ID" });
    }

    const adminToken = generateToken();
    const viewerToken = generateToken();
    const now = Date.now();
    const ttlKey = TTL_MAP[ttl] ? ttl : "24h";
    const ttlSeconds = TTL_MAP[ttlKey];

    // ── Store all paste data in ONE Redis Hash ──
    await kv.hset(`paste:${pasteId}`, {
      content: textContent,
      pin: pin || "",
      adminToken,
      viewerToken,
      createdAt: now,
      allowComments: allowComments === true || allowComments === "true" ? "true" : "false",
      comments: "[]",
      ttl: ttlKey,
      burnAfterReading: burnAfterReading === true || burnAfterReading === "true" ? "true" : "false",
      burned: "false",
    });

    // ── Set auto-expiry on the entire hash ──
    await kv.expire(`paste:${pasteId}`, ttlSeconds);

    return res.status(200).json({
      pasteId,
      adminToken,
      viewerToken,
      hasPin: !!(pin && pin !== ""),
      createdAt: now,
      ttl: ttlKey,
      burnAfterReading: burnAfterReading === true || burnAfterReading === "true",
    });
  } catch (error) {
    console.error("Create Error:", error);
    return res.status(500).json({ message: "Internal Server Error" });
  }
}
