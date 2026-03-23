import { kv } from "@vercel/kv";

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
    const { content, pasteId, adminToken } = req.body;

    if (!pasteId || typeof pasteId !== "string" || pasteId.length > 20) {
      return res.status(400).json({ message: "Invalid paste ID" });
    }

    const textContent = typeof content === "string" ? content : "";
    if (textContent.length > 100_000) {
      return res.status(400).json({ message: "Content too large (max 100 KB)" });
    }

    // ── Verify admin token and burned status ──
    const paste = await kv.hgetall(`paste:${pasteId}`);
    if (!paste || !paste.adminToken) {
      return res.status(404).json({ message: "Paste not found" });
    }

    if (adminToken !== paste.adminToken) {
      return res.status(401).json({ message: "Unauthorized" });
    }

    if (paste.burned === "true") {
      return res.status(410).json({ message: "This paste has been burned" });
    }

    // ── Update content in the hash ──
    await kv.hset(`paste:${pasteId}`, { content: textContent });

    return res.status(200).json({ message: "Saved successfully" });
  } catch (error) {
    console.error("Update Error:", error);
    return res.status(500).json({ message: "Internal Server Error" });
  }
}
