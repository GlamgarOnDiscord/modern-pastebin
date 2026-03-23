import { put, del } from "@vercel/blob";
import { kv } from "@vercel/kv";

export const config = {
  api: { bodyParser: false },
};

const ALLOWED_TYPES = new Set([
  // Generic text
  "text/plain", "text/csv", "text/markdown", "text/xml", "text/yaml",
  // Web
  "text/html", "text/css", "text/javascript", "application/javascript",
  "text/typescript", "application/typescript",
  // Systems languages
  "text/x-rust", "text/x-go", "text/x-c", "text/x-c++src",
  "text/x-csharp", "text/x-java", "text/x-kotlin", "text/x-swift",
  "text/x-objectivec", "text/x-zig", "text/x-nim",
  // Scripting
  "text/x-python", "text/x-ruby", "text/x-php", "text/x-lua",
  "text/x-perl", "text/x-r", "text/x-shellscript", "text/x-powershell",
  "application/dart",
  // Functional / other
  "text/x-elixir", "text/x-haskell", "text/x-erlang",
  "text/x-clojure", "text/x-scala", "text/x-groovy",
  // Frontend frameworks
  "text/x-vue", "text/x-svelte",
  // Data / config
  "application/json", "application/xml", "application/toml",
  "application/sql", "application/graphql",
  "text/x-terraform",
  // Archives
  "application/pdf",
  "application/zip", "application/x-zip-compressed",
  "application/x-tar", "application/gzip", "application/x-gzip",
  // Images
  "image/jpeg", "image/png", "image/gif", "image/webp",
  "image/svg+xml", "image/bmp", "image/tiff", "image/x-icon",
  // Audio / video
  "audio/mpeg", "audio/wav", "audio/ogg", "audio/flac",
  "video/mp4", "video/webm", "video/ogg",
]);

const MAX_FILE_SIZE = 4 * 1024 * 1024;

function securityHeaders(res) {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("X-XSS-Protection", "1; mode=block");
  res.setHeader("Referrer-Policy", "no-referrer");
}

async function validatePasteAdmin(pasteId, adminToken) {
  if (!pasteId || typeof pasteId !== "string" || pasteId.length > 20) return { error: "Invalid paste ID", status: 400 };
  if (!/^[a-zA-Z0-9]+$/.test(pasteId)) return { error: "Invalid paste ID format", status: 400 };
  if (!adminToken) return { error: "Missing admin token", status: 400 };

  const paste = await kv.hgetall(`paste:${pasteId}`);
  if (!paste || !paste.adminToken) return { error: "Paste not found", status: 404 };
  if (adminToken !== paste.adminToken) return { error: "Unauthorized", status: 401 };
  if (paste.burned === "true") return { error: "This paste has been burned", status: 410 };

  return { paste };
}

export default async function handler(req, res) {
  securityHeaders(res);

  const { pasteId, adminToken, fileName, fileType, fileSize } = req.query;

  if (req.method === "DELETE") {
    const { error, status, paste } = await validatePasteAdmin(pasteId, adminToken);
    if (error) return res.status(status).json({ message: error });

    if (paste.blobUrl) {
      await del(paste.blobUrl).catch(() => {});
      await kv.hset(`paste:${pasteId}`, { blobUrl: "", fileName: "", fileSize: "", fileType: "" });
    }
    return res.status(200).json({ message: "File removed" });
  }

  if (req.method !== "PUT") {
    return res.status(405).json({ message: "Method Not Allowed" });
  }

  try {
    const { error, status, paste } = await validatePasteAdmin(pasteId, adminToken);
    if (error) return res.status(status).json({ message: error });

    if (!fileName || typeof fileName !== "string" || fileName.length > 255) {
      return res.status(400).json({ message: "Invalid file name" });
    }
    if (!fileType || !ALLOWED_TYPES.has(fileType)) {
      return res.status(400).json({ message: "File type not allowed" });
    }
    const size = parseInt(fileSize, 10);
    if (isNaN(size) || size <= 0 || size > MAX_FILE_SIZE) {
      return res.status(400).json({ message: "File too large (max 4 MB)" });
    }

    const safeFileName = fileName.replace(/[^a-zA-Z0-9._\-()[\] ]/g, "_").slice(0, 255);

    if (paste.blobUrl) {
      await del(paste.blobUrl).catch(() => {});
    }

    const blob = await put(`pastes/${pasteId}/${safeFileName}`, req, {
      access: "public",
      contentType: fileType,
    });

    await kv.hset(`paste:${pasteId}`, {
      blobUrl: blob.url,
      fileName: safeFileName,
      fileSize: String(size),
      fileType: fileType,
    });

    return res.status(200).json({
      blobUrl: blob.url,
      fileName: safeFileName,
      fileSize: size,
      fileType: fileType,
    });
  } catch (error) {
    console.error("Upload Error:", error);
    return res.status(500).json({ message: "Internal Server Error" });
  }
}
