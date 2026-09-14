import { test } from "node:test";
import assert from "node:assert/strict";
import {
  normalizePath, sanitizeName, applyOps, checkQuota, parseState, allFolders, publicListing, TreeError,
} from "../lib/tree.js";

function state() {
  return {
    files: {
      a: { path: "", name: "root.txt", size: 10, type: "text/plain", pathname: "drive/x/a/root.txt" },
      b: { path: "src", name: "app.js", size: 20, type: "text/javascript", pathname: "drive/x/b/app.js" },
      c: { path: "src/lib", name: "util.js", size: 30, type: "text/javascript", pathname: "drive/x/c/util.js" },
      p: { path: "", name: "pending.bin", size: 5, pathname: "drive/x/p/pending.bin", pending: true },
    },
    folders: ["docs"],
  };
}

test("normalizePath: normalizes and rejects traversal", () => {
  assert.equal(normalizePath(""), "");
  assert.equal(normalizePath("/src//lib/"), "src/lib");
  assert.equal(normalizePath("src\\lib"), "src/lib");
  assert.throws(() => normalizePath("../etc"), TreeError);
  assert.throws(() => normalizePath("a/./b"), TreeError);
  assert.throws(() => normalizePath("a/b<c"), TreeError);
  assert.throws(() => normalizePath("a/".repeat(11) + "b"), TreeError);
});

test("sanitizeName: strips bad characters", () => {
  assert.equal(sanitizeName("  hello:world?.txt "), "hello_world_.txt");
  assert.throws(() => sanitizeName(".."), TreeError);
  assert.throws(() => sanitizeName(""), TreeError);
});

test("allFolders: includes implied parents", () => {
  assert.deepEqual(allFolders(state()), ["docs", "src", "src/lib"]);
});

test("publicListing hides pending entries and sums size", () => {
  const l = publicListing(state());
  assert.equal(l.files.length, 3);
  assert.equal(l.totalSize, 60);
});

test("checkQuota enforces limits including pending", () => {
  const s = state();
  checkQuota(s, "paste", 100);
  assert.throws(() => checkQuota(s, "paste", 101 * 1024 * 1024), /too large/);
  const full = { files: {}, folders: [] };
  for (let i = 0; i < 20; i++) full.files[i] = { name: `f${i}`, size: 1 };
  assert.throws(() => checkQuota(full, "paste", 1), /Too many/);
  const big = { files: { z: { name: "z", size: 199 * 1024 * 1024 } }, folders: [] };
  assert.throws(() => checkQuota(big, "paste", 2 * 1024 * 1024), /quota/);
});

test("rename file and conflict", () => {
  const { state: s, diff } = applyOps(state(), [{ op: "rename", fileId: "a", name: "new.txt" }]);
  assert.equal(s.files.a.name, "new.txt");
  assert.deepEqual(Object.keys(diff.set), ["a"]);
  const s2 = state();
  s2.files.d = { path: "", name: "taken.txt", size: 1 };
  assert.throws(() => applyOps(s2, [{ op: "rename", fileId: "a", name: "taken.txt" }]), /exists/);
});

test("rename folder cascades to descendants", () => {
  const { state: s, diff } = applyOps(state(), [{ op: "rename", path: "src", name: "source" }]);
  assert.equal(s.files.b.path, "source");
  assert.equal(s.files.c.path, "source/lib");
  assert.ok(diff.folders.includes("source"));
  assert.ok(!diff.folders.includes("src"));
  assert.deepEqual(Object.keys(diff.set).sort(), ["b", "c"]);
});

test("move file and folder, reject cycles", () => {
  const { state: s } = applyOps(state(), [
    { op: "move", fileId: "a", to: "docs" },
    { op: "move", path: "src/lib", to: "docs" },
  ]);
  assert.equal(s.files.a.path, "docs");
  assert.equal(s.files.c.path, "docs/lib");
  assert.throws(() => applyOps(state(), [{ op: "move", path: "src", to: "src/lib" }]), /into itself/);
  assert.throws(() => applyOps(state(), [{ op: "move", fileId: "a", to: "nope" }]), /not found/);
});

test("delete folder removes descendants and returns blobs", () => {
  const { state: s, diff } = applyOps(state(), [{ op: "delete", path: "src" }]);
  assert.deepEqual(Object.keys(s.files).sort(), ["a", "p"]);
  assert.deepEqual(diff.del.sort(), ["b", "c"]);
  assert.deepEqual(diff.blobsToDelete.sort(), ["drive/x/b/app.js", "drive/x/c/util.js"]);
  assert.throws(() => applyOps(state(), [{ op: "delete", path: "" }]), /root/);
});

test("mkdir and parseState roundtrip", () => {
  const hash = { folders: JSON.stringify(["docs"]), a: JSON.stringify({ path: "", name: "x", size: 1 }), junk: "not json" };
  const s = parseState(hash);
  assert.deepEqual(Object.keys(s.files), ["a"]);
  const { state: s2 } = applyOps(s, [{ op: "mkdir", path: "docs/img" }]);
  assert.ok(s2.folders.includes("docs/img"));
  assert.throws(() => applyOps(s2, [{ op: "mkdir", path: "docs/img" }]), /exists/);
});
