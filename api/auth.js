import { kv } from "@vercel/kv";
import crypto from "crypto";

function securityHeaders(res) {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("X-XSS-Protection", "1; mode=block");
  res.setHeader("Referrer-Policy", "no-referrer");
}

export default async function handler(req, res) {
  securityHeaders(res);

  if (req.method !== "POST") {
    return res.status(405).json({ message: "Method Not Allowed" });
  }

  try {
    const { pin, pasteId } = req.body;

    if (!pasteId || typeof pasteId !== "string" || pasteId.length > 20) {
      return res.status(400).json({ message: "Invalid paste ID" });
    }

    // Sanitize ID: only allow alphanumeric characters
    if (!/^[a-zA-Z0-9]+$/.test(pasteId)) {
      return res.status(400).json({ message: "Invalid paste ID format" });
    }

    // ── Single HGETALL instead of 2-4 separate GETs ──
    const paste = await kv.hgetall(`paste:${pasteId}`);

    if (!paste || !paste.createdAt) {
      return res.status(404).json({ message: "Paste not found" });
    }

    // ── Burn check ──
    if (paste.burned === "true") {
      return res.status(410).json({ message: "This paste has been burned" });
    }

    // ── If no PIN, grant open access ──
    if (!paste.pin || paste.pin === "") {
      return res.status(200).json({
        message: "Success",
        token: paste.viewerToken,
        role: "viewer",
      });
    }

    // ── Validate PIN (timing-safe comparison to prevent timing attacks) ──
    if (pin) {
      const pinBuf = Buffer.from(String(pin));
      const storedBuf = Buffer.from(String(paste.pin));
      if (pinBuf.length === storedBuf.length && crypto.timingSafeEqual(pinBuf, storedBuf)) {
        return res.status(200).json({
          message: "Success",
          token: paste.viewerToken,
          role: "viewer",
        });
      }
    }

    return res.status(401).json({ message: "Invalid PIN" });
  } catch (error) {
    console.error("Auth Error:", error);
    return res.status(500).json({ message: "Internal Server Error" });
  }
}
