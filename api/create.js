import { kv } from "@vercel/kv";

function generateId(length = 5) {
  const chars = "ABCDEFGHJKMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789";
  let result = "";
  for (let i = 0; i < length; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return result;
}

function generateToken() {
  const chars =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let result = "";
  for (let i = 0; i < 48; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return result;
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ message: "Method Not Allowed" });
  }

  try {
    const { pin, content, allowComments } = req.body;

    // Generate unique paste ID (retry if collision)
    let pasteId;
    let attempts = 0;
    do {
      pasteId = generateId();
      const existing = await kv.get(`paste:${pasteId}:createdAt`);
      if (!existing) break;
      attempts++;
    } while (attempts < 5);

    if (attempts >= 5) {
      return res.status(500).json({ message: "Could not generate unique ID" });
    }

    const adminToken = generateToken();
    const viewerToken = generateToken();
    const now = Date.now();

    // Store all paste data in KV
    await Promise.all([
      kv.set(`paste:${pasteId}:content`, content || ""),
      kv.set(`paste:${pasteId}:pin`, pin || null),
      kv.set(`paste:${pasteId}:adminToken`, adminToken),
      kv.set(`paste:${pasteId}:viewerToken`, viewerToken),
      kv.set(`paste:${pasteId}:createdAt`, now),
      kv.set(`paste:${pasteId}:allowComments`, allowComments === true || allowComments === "true" ? "true" : "false"),
      kv.set(`paste:${pasteId}:comments`, []),
    ]);

    return res.status(200).json({
      pasteId,
      adminToken,
      viewerToken,
      hasPin: !!pin,
      createdAt: now,
    });
  } catch (error) {
    console.error("Create Error:", error);
    return res.status(500).json({ message: "Internal Server Error" });
  }
}
