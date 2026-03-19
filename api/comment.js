import { kv } from "@vercel/kv";

function securityHeaders(res) {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("X-XSS-Protection", "1; mode=block");
  res.setHeader("Referrer-Policy", "no-referrer");
}

// Note: XSS prevention is handled client-side via textContent (DOM API).
// Server-side sanitization is NOT needed and would cause double-encoding.


export default async function handler(req, res) {
  securityHeaders(res);

  if (req.method !== "POST") {
    return res.status(405).json({ message: "Method Not Allowed" });
  }

  try {
    const { pasteId, token, text } = req.body;

    if (!pasteId || !token || !text) {
      return res.status(400).json({ message: "Missing data" });
    }

    if (typeof text !== "string" || text.trim().length === 0) {
      return res.status(400).json({ message: "Comment cannot be empty" });
    }

    if (text.length > 500) {
      return res.status(400).json({ message: "Comment too long (max 500 characters)" });
    }

    // ── Single HGETALL instead of 4 separate GETs ──
    const paste = await kv.hgetall(`paste:${pasteId}`);

    if (!paste || !paste.createdAt) {
      return res.status(404).json({ message: "Paste not found" });
    }

    // ── Auth ──
    let author = null;
    if (token === paste.adminToken) author = "admin";
    else if (token === paste.viewerToken) author = "viewer";
    else return res.status(401).json({ message: "Unauthorized" });

    // ── Check comments enabled ──
    if (paste.allowComments !== "true") {
      return res.status(403).json({ message: "Comments disabled" });
    }

    // ── Parse existing comments ──
    let comments = [];
    try {
      comments = typeof paste.comments === "string" ? JSON.parse(paste.comments) : (paste.comments || []);
    } catch (e) {
      comments = [];
    }

    // ── Limit comments per paste ──
    if (comments.length >= 50) {
      return res.status(400).json({ message: "Maximum comments reached (50)" });
    }

    // ── Add sanitized comment ──
    comments.push({
      author,
      text: text.trim(),
      timestamp: Date.now(),
    });

    await kv.hset(`paste:${pasteId}`, { comments: JSON.stringify(comments) });

    return res.status(200).json({ message: "Comment added" });
  } catch (error) {
    console.error("Comment Error:", error);
    return res.status(500).json({ message: "Internal Server Error" });
  }
}
