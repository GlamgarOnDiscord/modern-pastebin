import { kv } from "@vercel/kv";

function securityHeaders(res) {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("X-XSS-Protection", "1; mode=block");
  res.setHeader("Referrer-Policy", "no-referrer");
}

export default async function handler(req, res) {
  securityHeaders(res);

  if (req.method !== "GET") {
    return res.status(405).json({ message: "Method Not Allowed" });
  }

  try {
    const { id, token } = req.query;

    if (!id || typeof id !== "string" || id.length > 20) {
      return res.status(400).json({ message: "Invalid paste ID" });
    }

    // Sanitize ID: only allow alphanumeric characters
    if (!/^[a-zA-Z0-9]+$/.test(id)) {
      return res.status(400).json({ message: "Invalid paste ID format" });
    }

    // ── Single HGETALL — 1 DB request for all paste data ──
    const paste = await kv.hgetall(`paste:${id}`);

    if (!paste || !paste.createdAt) {
      return res.status(404).json({ message: "Paste not found" });
    }

    // ── Burn after reading check ──
    if (paste.burned === "true") {
      return res.status(410).json({ message: "This paste has been burned after reading" });
    }

    // ── Auth check ──
    const isOpenAccess = !paste.pin || paste.pin === "";
    const isValidToken = token && (token === paste.adminToken || token === paste.viewerToken);

    if (!isOpenAccess && !isValidToken) {
      return res.status(401).json({ message: "Unauthorized" });
    }

    const viewerCount = 0;

    // ── Burn after reading: first read destroys the paste for everyone ──
    if (paste.burnAfterReading === "true") {
      await kv.hset(`paste:${id}`, { burned: "true" });
    }

    const allowComments = paste.allowComments === "true";
    let comments = [];
    if (allowComments && paste.comments) {
      try {
        comments = typeof paste.comments === "string" ? JSON.parse(paste.comments) : paste.comments;
      } catch (e) {
        comments = [];
      }
    }

    return res.status(200).json({
      content: paste.content || "",
      allowComments,
      comments,
      viewerCount,
      ttl: paste.ttl || "24h",
      burnAfterReading: paste.burnAfterReading === "true",
      createdAt: paste.createdAt,
    });
  } catch (error) {
    console.error("Content GET Error:", error);
    return res.status(500).json({ message: "Internal Server Error" });
  }
}
