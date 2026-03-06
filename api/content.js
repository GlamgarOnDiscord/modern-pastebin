import { kv } from "@vercel/kv";

export default async function handler(req, res) {
  if (req.method !== "GET") {
    return res.status(405).json({ message: "Method Not Allowed" });
  }

  try {
    const { id, token } = req.query;

    if (!id) {
      return res.status(400).json({ message: "Missing paste ID" });
    }

    // Check paste exists
    const createdAt = await kv.get(`paste:${id}:createdAt`);
    if (!createdAt) {
      return res.status(404).json({ message: "Paste not found" });
    }

    // Validate token — must be either the admin token or the viewer token
    const adminToken = await kv.get(`paste:${id}:adminToken`);
    const viewerToken = await kv.get(`paste:${id}:viewerToken`);
    const storedPin = await kv.get(`paste:${id}:pin`);

    // If paste has no PIN, allow open access without a token
    const isOpenAccess = !storedPin;
    const isValidToken = token === adminToken || token === viewerToken;

    if (!isOpenAccess && !isValidToken) {
      return res.status(401).json({ message: "Unauthorized" });
    }

    const content = (await kv.get(`paste:${id}:content`)) || "";

    return res.status(200).json({ content });
  } catch (error) {
    console.error("Content GET Error:", error);
    return res
      .status(500)
      .json({ message: "Internal Server Error" });
  }
}
