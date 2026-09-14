import { kv } from "../../lib/db.js";
import { storage } from "../../lib/storage.js";
import { securityHeaders } from "../../lib/http.js";

// Deletes blobs whose owner (paste or drive) has expired or been deleted.
export default async function handler(req, res) {
  securityHeaders(res);
  const auth = req.headers.authorization || "";
  if (!process.env.CRON_SECRET || auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ message: "Unauthorized" });
  }

  const report = { scanned: 0, deleted: 0 };
  const ownerAlive = new Map();

  // "pastes/" is the legacy single-attachment prefix.
  for (const [kind, prefix] of [["paste", "paste/"], ["drive", "drive/"], ["paste", "pastes/"]]) {
    let cursor;
    do {
      const page = await storage.list(prefix, cursor);
      cursor = page.cursor;
      const orphans = [];
      for (const pathname of page.pathnames) {
        report.scanned++;
        const id = pathname.split("/")[1];
        if (!id) continue;
        const key = `${kind}:${id}`;
        if (!ownerAlive.has(key)) ownerAlive.set(key, (await kv.exists(key)) === 1);
        if (!ownerAlive.get(key)) orphans.push(pathname);
      }
      if (orphans.length) {
        await storage.remove(orphans);
        report.deleted += orphans.length;
      }
    } while (cursor);
  }

  return res.status(200).json(report);
}
