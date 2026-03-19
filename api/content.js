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

    // Batch fetch most metadata to save Redis requests quota
    const [createdAt, adminToken, viewerToken, storedPin, contentData, allowCommentsStr, commentsData] = await kv.mget(
      `paste:${id}:createdAt`,
      `paste:${id}:adminToken`,
      `paste:${id}:viewerToken`,
      `paste:${id}:pin`,
      `paste:${id}:content`,
      `paste:${id}:allowComments`,
      `paste:${id}:comments`
    );

    if (!createdAt) {
      return res.status(404).json({ message: "Paste not found" });
    }

    // If paste has no PIN, allow open access without a token
    const isOpenAccess = !storedPin;
    const isValidToken = token === adminToken || token === viewerToken;

    if (!isOpenAccess && !isValidToken) {
      return res.status(401).json({ message: "Unauthorized" });
    }

    // Update viewer token expiry with a longer duration (30s) since polling is slower
    if (token) {
      await kv.set(`paste:${id}:viewers:${token}`, "1", { ex: 30 });
    }
    
    let viewerCount = 0;
    try {
      const keys = await kv.keys(`paste:${id}:viewers:*`);
      viewerCount = keys.length;
    } catch(e) {}

    const content = contentData || "";
    const allowComments = allowCommentsStr === "true" || allowCommentsStr === true;
    const comments = allowComments ? (commentsData || []) : [];

    return res.status(200).json({ content, allowComments, comments, viewerCount });
  } catch (error) {
    console.error("Content GET Error:", error);
    return res
      .status(500)
      .json({ message: "Internal Server Error" });
  }
}
