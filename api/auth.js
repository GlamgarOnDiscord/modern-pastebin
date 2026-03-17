import { kv } from "@vercel/kv";

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ message: "Method Not Allowed" });
  }

  try {
    const { pin, pasteId } = req.body;

    if (!pasteId) {
      return res.status(400).json({ message: "Missing paste ID" });
    }

    // Check that paste exists
    const createdAt = await kv.get(`paste:${pasteId}:createdAt`);
    if (!createdAt) {
      return res.status(404).json({ message: "Paste not found" });
    }

    // Get the stored PIN for this paste
    const storedPin = await kv.get(`paste:${pasteId}:pin`);

    // If no PIN is set on this paste, grant access directly
    if (!storedPin) {
      const viewerToken = await kv.get(`paste:${pasteId}:viewerToken`);
      return res.status(200).json({
        message: "Success",
        token: viewerToken,
        role: "viewer"
      });
    }

    // Validate PIN
    if (pin === storedPin) {
      const viewerToken = await kv.get(`paste:${pasteId}:viewerToken`);
      return res.status(200).json({
        message: "Success",
        token: viewerToken,
        role: "viewer"
      });
    }

    return res.status(401).json({ message: "Invalid PIN" });
  } catch (error) {
    console.error("Auth Error:", error);
    return res.status(500).json({ message: "Internal Server Error" });
  }
}
