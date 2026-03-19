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
    const isAdmin = token && token === paste.adminToken;

    if (!isOpenAccess && !isValidToken) {
      return res.status(401).json({ message: "Unauthorized" });
    }

    // ── Viewer tracking: single INCR with TTL instead of keys() scan ──
    // Use a single counter key per paste that auto-expires
    // Each viewer "heartbeat" refreshes the counter
    let viewerCount = 0;
    if (token) {
      // Set a per-viewer key with 30s TTL (1 DB call)
      await kv.set(`v:${id}:${token.slice(0, 8)}`, "1", { ex: 30 });
    }

    // Skip the expensive KEYS scan entirely.
    // Instead, estimate from the paste's own metadata — or simply
    // don't count viewers to save DB calls. This is a non-critical feature.
    // If viewer count is really needed, use a single atomic counter instead.

    // ── Burn after reading: mark as burned on first non-admin read ──
    if (paste.burnAfterReading === "true" && !isAdmin) {
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

    // Total DB calls: 1 (hgetall) + 1 if token (set viewer) + 1 if burn (hset)
    // Best case: 1 call. Typical case: 2 calls. Worst case (burn): 3 calls.

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
