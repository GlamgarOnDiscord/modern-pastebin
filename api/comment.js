import { kv } from "@vercel/kv";

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ message: "Method Not Allowed" });
  }

  try {
    const { pasteId, token, text } = req.body;

    if (!pasteId || !token || !text) {
      return res.status(400).json({ message: "Missing data" });
    }

    const adminToken = await kv.get(`paste:${pasteId}:adminToken`);
    const viewerToken = await kv.get(`paste:${pasteId}:viewerToken`);

    let author = null;
    if (token === adminToken) author = "admin";
    else if (token === viewerToken) author = "viewer";
    else return res.status(401).json({ message: "Unauthorized" });

    const allowCommentsStr = await kv.get(`paste:${pasteId}:allowComments`);
    const allowComments = allowCommentsStr === "true" || allowCommentsStr === true;
    if (!allowComments) return res.status(403).json({ message: "Comments disabled" });

    let comments = (await kv.get(`paste:${pasteId}:comments`)) || [];
    comments.push({ author, text, timestamp: Date.now() });
    
    await kv.set(`paste:${pasteId}:comments`, comments);

    return res.status(200).json({ message: "Comment added" });
  } catch (error) {
    console.error("Comment Error:", error);
    return res.status(500).json({ message: "Internal Server Error" });
  }
}
