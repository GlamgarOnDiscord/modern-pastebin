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
    const { pasteId, adminToken } = req.body;

    if (!pasteId || typeof pasteId !== "string" || pasteId.length > 20) {
      return res.status(400).json({ message: "Invalid paste ID" });
    }

    if (!adminToken) {
      return res.status(400).json({ message: "Missing admin token" });
    }

    // ── Verify admin token ──
    const storedToken = await kv.hget(`paste:${pasteId}`, "adminToken");
    if (!storedToken) {
      return res.status(404).json({ message: "Paste not found" });
    }

    if (adminToken !== storedToken) {
      return res.status(401).json({ message: "Unauthorized" });
    }

    // ── Delete the entire paste hash ──
    await kv.del(`paste:${pasteId}`);

    return res.status(200).json({ message: "Paste deleted" });
  } catch (error) {
    console.error("Delete Error:", error);
    return res.status(500).json({ message: "Internal Server Error" });
  }
}
