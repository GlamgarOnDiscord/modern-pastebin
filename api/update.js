import { kv } from "@vercel/kv";

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ message: "Method Not Allowed" });
  }

  try {
    const { content, pasteId, adminToken } = req.body;

    if (!pasteId) {
      return res.status(400).json({ message: "Missing paste ID" });
    }

    // Verify admin token
    const storedToken = await kv.get(`paste:${pasteId}:adminToken`);
    if (!storedToken) {
      return res.status(404).json({ message: "Paste not found" });
    }

    if (adminToken !== storedToken) {
      return res.status(401).json({ message: "Unauthorized" });
    }

    await kv.set(`paste:${pasteId}:content`, content || "");

    return res.status(200).json({ message: "Saved successfully" });
  } catch (error) {
    console.error("Update Error:", error);
    return res.status(500).json({ message: "Internal Server Error" });
  }
}
