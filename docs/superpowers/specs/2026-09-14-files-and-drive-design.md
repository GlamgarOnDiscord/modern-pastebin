# Files & Drive — Design

Date: 2026-09-14
Status: approved

## Goals

1. Replace the single-attachment system on pastes with a multi-file system
   (flat list, drag & drop, per-file progress and removal, viewer previews).
2. Add a standalone "Drive" entity at `/drive`: created like a paste (name,
   PIN, TTL, burn-after-reading, optional viewer upload), exposes admin and
   viewer links, and offers a file explorer with virtual folders.
3. Support files up to 100 MB via direct client-to-Blob upload.
4. Remove the duplicated local-dev implementation in `server.js`.

## Non-goals

- User accounts, quotas per user, sharing between drives.
- Server-side compression or archive generation.
- Editing files in place.

## Upload path

Client-direct upload to Vercel Blob:

1. Client calls `POST /api/files/token` with `{kind, id, token, path, name, size, type}`.
   Server validates role and quotas, returns a client upload token scoped to
   pathname `{kind}/{id}/{fileId}/{safeName}`.
2. Client uploads with `@vercel/blob/client` `upload()` (progress events).
3. Client calls `POST /api/files/commit` with the blob URL and metadata.
   Server runs `head(url)`, checks the pathname prefix and size, then writes the
   entry to KV.

The `onUploadCompleted` webhook is not used (does not fire on localhost).

Assumption to verify at first implementation step: `@vercel/blob` 2.3.1
supports `access: 'private'` for client tokens. Fallback: public blobs with
unguessable pathnames (UUID segment) and the streaming proxy unchanged.

## Data model (Vercel KV)

- `paste:{id}` — unchanged, except the legacy `blobUrl/fileName/fileSize/fileType`
  fields are no longer written. If present, they are read as one legacy file
  (`fileId = "legacy"`) until the paste expires.
- `drive:{id}` — hash: `name, pin, adminToken, viewerToken, createdAt, ttl,
  burnAfterReading, burned, allowViewerUpload`.
- `files:{kind}:{id}` — hash. Field `fileId` → JSON
  `{path, name, size, type, blobUrl, createdAt, by}` where `path` is the
  folder (`""` for root, `"src/app"` otherwise), `by` is `admin|viewer`.
  Field `folders` → JSON array of folder paths (keeps empty folders).
  Same TTL as the owner hash; refreshed whenever the owner TTL is set.

Quotas (constants in `lib/limits.js`):

| | per file | files | total |
|---|---|---|---|
| paste | 100 MB | 20 | 200 MB |
| drive | 100 MB | 200 | 1 GB |

Path rules: segments `[A-Za-z0-9._\-()\[\] ]`, no `.`/`..` segments, max depth
10, max 255 chars per segment, max 1024 total.

## API

All handlers: security headers, alphanumeric id check (≤ 20 chars), JSON errors.

- `api/drive.js`
  - `POST` `{name, pin, ttl, burnAfterReading, allowViewerUpload}` → `{driveId, adminToken, viewerToken, ...}`
  - `GET ?id&token` → `{name, role: admin|viewer, ttl, allowViewerUpload, createdAt, files, folders, totalSize}`. Burns on first viewer read if `burnAfterReading`.
  - `DELETE ?id&token` (admin) → deletes blobs, `files:` and `drive:` hashes.
- `api/files/token.js` `POST` — role admin, or viewer when drive `allowViewerUpload`. Checks quotas against current `files:` hash.
- `api/files/commit.js` `POST` — verifies blob, writes entry, returns the entry.
- `api/files/op.js` `POST` `{kind, id, token, ops: [{op: rename|move|delete|mkdir, ...}]}` — admin only; `delete` removes blobs; `move`/`rename` on a folder rewrites all descendant paths.
- `api/files/get.js` `GET ?kind&id&fileId&token[&inline=1]` — streams the private blob; `inline=1` sets `Content-Disposition: inline` for previews.
- `api/cron/cleanup.js` `GET` — guarded by `CRON_SECRET`; lists blobs under `paste/` and `drive/`, deletes any whose owner hash no longer exists. Scheduled daily in `vercel.json`.
- Removed: `api/upload.js`, `api/download.js`. `api/content.js` returns `files` (array) instead of `hasFile/fileName/...`. `api/delete.js` deletes all blobs of the paste.

## Shared libraries

- `lib/db.js` — exports `kv`: real `@vercel/kv` when `KV_REST_API_URL` is set, else an in-memory hash store with TTL (local dev).
- `lib/storage.js` — `put/head/del/list/stream/clientToken`: real `@vercel/blob` when `BLOB_READ_WRITE_TOKEN` is set, else disk-backed store under `.local-blob/` and a local upload endpoint the client shim targets.
- `lib/tree.js` — pure functions: `normalizePath`, `validateName`, `applyOps(state, ops)`, `checkQuota(state, kind, size)`. Unit tested.
- `lib/http.js` — `securityHeaders`, `parseId`, `jsonError`.
- `lib/auth.js` — `loadOwner(kind, id)`, `roleFor(owner, token)`.

## Frontend

- `public/files.js` (shared, no framework):
  - Upload queue: concurrency 3, per-file progress, retry once on failure, cancel.
  - Sources: input multi-select, drag & drop (folders via `webkitGetAsEntry`), clipboard paste.
  - Tree model + rendering, breadcrumb, multi-select, context actions.
  - Preview modal: images, text/code (highlight.js already loaded), PDF (`<iframe>`), audio/video.
  - "Download all" / "Download folder": client-side zip with `fflate` (CDN), streaming each file from `/api/files/get`, store-only (no compression).
- `public/drive.html` — three states in one page: create form; success (links, copy buttons); explorer (admin or viewer, viewer upload zone if enabled). Route `/drive` and `/drive?id=X&token=Y`.
- `public/index.html` / `public/view.html` — replace the single-file block with the shared flat-list component (drop zone + chips with progress; viewer shows list + previews + zip).
- `vercel.json` — rewrite `/drive` → `/drive.html`, cron entry.

## Local dev

`server.js` becomes a thin adapter: static files + routing `/api/*` to the ESM
handlers in `api/` via dynamic `import()`, with a request shim (`req.query`,
`req.body` parsed for JSON, raw stream otherwise) and response shim
(`status().json()`, `setHeader`, streaming). `lib/db.js` and `lib/storage.js`
choose local backends when env vars are absent.

## Error handling

- Upload: token refused (quota, type, path) → toast with server message, file
  stays in the queue marked failed with retry.
- Commit failure after a successful blob upload → client retries commit once;
  the daily cron removes any leftover orphan.
- Burned/expired owner → 410/404, explorer shows the existing empty state.

## Testing

- `node --test test/tree.test.js` for `lib/tree.js` (path normalization,
  traversal rejection, rename/move cascade, quotas, delete).
- Manual: local server flow (create paste with 3 files, create drive, nested
  folders, viewer upload, zip download), then production smoke test.
