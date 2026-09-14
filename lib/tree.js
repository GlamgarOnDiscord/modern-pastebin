// Pure functions over the file tree state of a paste or drive.
// State shape: { files: { [fileId]: Entry }, folders: string[] }
// Entry: { path, name, size, type, pathname, createdAt, by, pending? }
// `path` is the containing folder ("" = root); folders are "/"-joined paths.

import {
  MAX_PATH_DEPTH, MAX_SEGMENT_LENGTH, MAX_PATH_LENGTH,
  MAX_FILE_SIZE, QUOTAS,
} from "./limits.js";

export class TreeError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

const SEGMENT_RE = /^[A-Za-z0-9._\-()[\] ]+$/;

export function sanitizeName(raw) {
  if (typeof raw !== "string") throw new TreeError("Invalid name");
  const name = raw.trim().replace(/[^A-Za-z0-9._\-()[\] ]/g, "_").slice(0, MAX_SEGMENT_LENGTH).trim();
  if (!name || name === "." || name === "..") throw new TreeError("Invalid name");
  return name;
}

export function normalizePath(raw) {
  if (raw === undefined || raw === null || raw === "") return "";
  if (typeof raw !== "string") throw new TreeError("Invalid path");
  if (raw.length > MAX_PATH_LENGTH) throw new TreeError("Path too long");
  const segments = raw.split(/[\\/]+/).map((s) => s.trim()).filter(Boolean);
  if (segments.length > MAX_PATH_DEPTH) throw new TreeError("Path too deep");
  for (const s of segments) {
    if (s === "." || s === ".." || s.length > MAX_SEGMENT_LENGTH || !SEGMENT_RE.test(s)) {
      throw new TreeError("Invalid path segment");
    }
  }
  return segments.join("/");
}

export function joinPath(dir, name) {
  return dir ? `${dir}/${name}` : name;
}

export function parentOf(path) {
  const i = path.lastIndexOf("/");
  return i === -1 ? "" : path.slice(0, i);
}

export function baseName(path) {
  const i = path.lastIndexOf("/");
  return i === -1 ? path : path.slice(i + 1);
}

function isWithin(path, folder) {
  return path === folder || path.startsWith(folder + "/");
}

export function parseState(hash) {
  const state = { files: {}, folders: [] };
  if (!hash) return state;
  for (const [field, value] of Object.entries(hash)) {
    if (field === "folders") {
      try {
        const parsed = typeof value === "string" ? JSON.parse(value) : value;
        if (Array.isArray(parsed)) state.folders = parsed.filter((p) => typeof p === "string");
      } catch { /* ignore corrupt folders */ }
      continue;
    }
    try {
      const entry = typeof value === "string" ? JSON.parse(value) : value;
      if (entry && typeof entry === "object" && typeof entry.name === "string") state.files[field] = entry;
    } catch { /* ignore corrupt entry */ }
  }
  return state;
}

export function allFolders(state) {
  const set = new Set(state.folders);
  for (const entry of Object.values(state.files)) {
    let p = entry.path || "";
    while (p) {
      set.add(p);
      p = parentOf(p);
    }
  }
  for (const f of [...set]) {
    let p = parentOf(f);
    while (p) {
      set.add(p);
      p = parentOf(p);
    }
  }
  return [...set].sort();
}

export function usage(state) {
  let count = 0;
  let total = 0;
  for (const entry of Object.values(state.files)) {
    count++;
    total += Number(entry.size) || 0;
  }
  return { count, total };
}

export function checkQuota(state, kind, size) {
  const quota = QUOTAS[kind];
  if (!quota) throw new TreeError("Invalid kind");
  if (!Number.isInteger(size) || size <= 0) throw new TreeError("Invalid file size");
  if (size > MAX_FILE_SIZE) throw new TreeError("File too large (max 100 MB)", 413);
  const { count, total } = usage(state);
  if (count + 1 > quota.maxFiles) throw new TreeError(`Too many files (max ${quota.maxFiles})`, 413);
  if (total + size > quota.maxTotal) throw new TreeError("Storage quota exceeded", 413);
}

function nameTaken(state, dir, name, ignoreFileId) {
  for (const [id, entry] of Object.entries(state.files)) {
    if (id !== ignoreFileId && (entry.path || "") === dir && entry.name === name) return true;
  }
  return allFolders(state).includes(joinPath(dir, name));
}

function cloneState(state) {
  return {
    files: Object.fromEntries(Object.entries(state.files).map(([k, v]) => [k, { ...v }])),
    folders: [...state.folders],
  };
}

// Applies a list of operations and returns the new state plus a diff usable
// for minimal KV writes and blob deletions.
export function applyOps(input, ops) {
  if (!Array.isArray(ops) || ops.length === 0 || ops.length > 200) throw new TreeError("Invalid operations");
  const state = cloneState(input);
  const touched = new Set();
  const removed = new Set();
  const blobsToDelete = [];
  let foldersChanged = false;

  const rewriteFolder = (from, to) => {
    for (const [id, entry] of Object.entries(state.files)) {
      const p = entry.path || "";
      if (isWithin(p, from)) {
        entry.path = to + p.slice(from.length);
        touched.add(id);
      }
    }
    state.folders = state.folders.map((f) => (isWithin(f, from) ? to + f.slice(from.length) : f));
    if (!state.folders.includes(to)) state.folders.push(to);
    foldersChanged = true;
  };

  for (const op of ops) {
    if (!op || typeof op !== "object") throw new TreeError("Invalid operation");
    switch (op.op) {
      case "mkdir": {
        const path = normalizePath(op.path);
        if (!path) throw new TreeError("Invalid folder path");
        if (nameTaken(state, parentOf(path), baseName(path))) throw new TreeError("Name already exists", 409);
        state.folders.push(path);
        foldersChanged = true;
        break;
      }
      case "rename": {
        const name = sanitizeName(op.name);
        if (op.fileId) {
          const entry = state.files[op.fileId];
          if (!entry) throw new TreeError("File not found", 404);
          if (entry.name === name) break;
          if (nameTaken(state, entry.path || "", name, op.fileId)) throw new TreeError("Name already exists", 409);
          entry.name = name;
          touched.add(op.fileId);
        } else {
          const from = normalizePath(op.path);
          if (!from || !allFolders(state).includes(from)) throw new TreeError("Folder not found", 404);
          const to = joinPath(parentOf(from), name);
          if (to === from) break;
          if (nameTaken(state, parentOf(from), name)) throw new TreeError("Name already exists", 409);
          rewriteFolder(from, to);
        }
        break;
      }
      case "move": {
        const to = normalizePath(op.to);
        if (to && !allFolders(state).includes(to)) throw new TreeError("Target folder not found", 404);
        if (op.fileId) {
          const entry = state.files[op.fileId];
          if (!entry) throw new TreeError("File not found", 404);
          if ((entry.path || "") === to) break;
          if (nameTaken(state, to, entry.name, op.fileId)) throw new TreeError("Name already exists", 409);
          entry.path = to;
          touched.add(op.fileId);
        } else {
          const from = normalizePath(op.path);
          if (!from || !allFolders(state).includes(from)) throw new TreeError("Folder not found", 404);
          if (isWithin(to, from)) throw new TreeError("Cannot move a folder into itself");
          const dest = joinPath(to, baseName(from));
          if (dest === from) break;
          if (nameTaken(state, to, baseName(from))) throw new TreeError("Name already exists", 409);
          rewriteFolder(from, dest);
        }
        break;
      }
      case "delete": {
        if (op.fileId) {
          const entry = state.files[op.fileId];
          if (!entry) throw new TreeError("File not found", 404);
          blobsToDelete.push(entry.pathname);
          delete state.files[op.fileId];
          removed.add(op.fileId);
          touched.delete(op.fileId);
        } else {
          const folder = normalizePath(op.path);
          if (!folder) throw new TreeError("Cannot delete root");
          for (const [id, entry] of Object.entries(state.files)) {
            if (isWithin(entry.path || "", folder)) {
              blobsToDelete.push(entry.pathname);
              delete state.files[id];
              removed.add(id);
              touched.delete(id);
            }
          }
          state.folders = state.folders.filter((f) => !isWithin(f, folder));
          foldersChanged = true;
        }
        break;
      }
      default:
        throw new TreeError("Unknown operation");
    }
  }

  state.folders = [...new Set(state.folders)].sort();
  const set = {};
  for (const id of touched) if (state.files[id]) set[id] = state.files[id];
  return {
    state,
    diff: { set, del: [...removed], folders: foldersChanged ? state.folders : null, blobsToDelete: blobsToDelete.filter(Boolean) },
  };
}

export function publicListing(state) {
  const files = Object.entries(state.files)
    .filter(([, e]) => !e.pending)
    .map(([fileId, e]) => ({
      fileId, path: e.path || "", name: e.name, size: Number(e.size) || 0,
      type: e.type || "application/octet-stream", createdAt: e.createdAt, by: e.by || "admin",
    }))
    .sort((a, b) => (a.path + "/" + a.name).localeCompare(b.path + "/" + b.name));
  const totalSize = files.reduce((sum, f) => sum + f.size, 0);
  return { files, folders: allFolders(state), totalSize };
}
