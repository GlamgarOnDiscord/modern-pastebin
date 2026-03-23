import { kv } from "@vercel/kv";

function securityHeaders(res) {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "no-referrer");
}

export default async function handler(req, res) {
  securityHeaders(res);

  if (req.method !== "GET") {
    return res.status(405).json({ message: "Method Not Allowed" });
  }

  try {
    const { pasteId, token } = req.query;

    if (!pasteId || typeof pasteId !== "string" || pasteId.length > 20) {
      return res.status(400).json({ message: "Invalid paste ID" });
    }
    if (!/^[a-zA-Z0-9]+$/.test(pasteId)) {
      return res.status(400).json({ message: "Invalid paste ID format" });
    }

    const paste = await kv.hgetall(`paste:${pasteId}`);
    if (!paste || !paste.createdAt) {
      return res.status(404).json({ message: "Paste not found" });
    }
    if (paste.burned === "true") {
      return res.status(410).json({ message: "This paste has been burned" });
    }
    if (!paste.blobUrl) {
      return res.status(404).json({ message: "No file attached" });
    }

    const isOpenAccess = !paste.pin || paste.pin === "";
    const isValidToken = token && (token === paste.adminToken || token === paste.viewerToken);
    if (!isOpenAccess && !isValidToken) {
      return res.status(401).json({ message: "Unauthorized" });
    }

    // Fetch private blob server-side using the store token
    const blobRes = await fetch(paste.blobUrl, {
      headers: { Authorization: `Bearer ${process.env.BLOB_READ_WRITE_TOKEN}` },
    });

    if (!blobRes.ok) {
      return res.status(502).json({ message: "File unavailable" });
    }

    res.setHeader("Content-Type", paste.fileType || "application/octet-stream");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="${encodeURIComponent(paste.fileName)}"`
    );
    if (paste.fileSize) res.setHeader("Content-Length", paste.fileSize);
    res.setHeader("Cache-Control", "private, no-store");

    const { Readable } = await import("stream");
    Readable.fromWeb(blobRes.body).pipe(res);
  } catch (error) {
    console.error("Download Error:", error);
    return res.status(500).json({ message: "Internal Server Error" });
  }
}
