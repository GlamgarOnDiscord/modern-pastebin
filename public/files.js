// Shared file manager for pastes (flat list) and drives (explorer).
// Usage: const fm = ScribbleFiles.mount(container, options)
//   options: { kind, id, token, role, mode: "flat"|"explorer", allowUpload,
//              listing, toast, onChange }
// Methods: setListing, setAuth, enqueue(files), flushStaged, refresh, destroy

(function () {
  "use strict";

  const CONCURRENCY = 3;
  const MAX_FILE_SIZE = 100 * 1024 * 1024;
  const FFLATE_URL = "https://cdn.jsdelivr.net/npm/fflate@0.8.2/umd/index.js";

  const EXT_MIME = {
    js: "text/javascript", mjs: "text/javascript", cjs: "text/javascript", jsx: "text/javascript",
    ts: "text/typescript", tsx: "text/typescript", html: "text/html", htm: "text/html",
    css: "text/css", scss: "text/css", less: "text/css", rs: "text/x-rust", go: "text/x-go",
    c: "text/x-c", h: "text/x-c", cpp: "text/x-c++src", cc: "text/x-c++src", hpp: "text/x-c++src",
    cs: "text/x-csharp", java: "text/x-java", kt: "text/x-kotlin", swift: "text/x-swift",
    py: "text/x-python", rb: "text/x-ruby", php: "text/x-php", lua: "text/x-lua", pl: "text/x-perl",
    r: "text/x-r", sh: "text/x-shellscript", bash: "text/x-shellscript", zsh: "text/x-shellscript",
    ps1: "text/x-powershell", json: "application/json", yaml: "text/yaml", yml: "text/yaml",
    toml: "application/toml", ini: "text/plain", cfg: "text/plain", env: "text/plain", xml: "text/xml",
    svg: "image/svg+xml", csv: "text/csv", tsv: "text/csv", sql: "application/sql", graphql: "application/graphql",
    md: "text/markdown", mdx: "text/markdown", txt: "text/plain", log: "text/plain",
    zip: "application/zip", gz: "application/gzip", tar: "application/x-tar", "7z": "application/x-7z-compressed",
    png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp",
    bmp: "image/bmp", ico: "image/x-icon", avif: "image/avif", pdf: "application/pdf",
    mp3: "audio/mpeg", wav: "audio/wav", ogg: "audio/ogg", flac: "audio/flac", m4a: "audio/mp4",
    mp4: "video/mp4", webm: "video/webm", mov: "video/quicktime", mkv: "video/x-matroska",
    dockerfile: "text/plain", makefile: "text/plain", lock: "text/plain", prisma: "text/plain",
    vue: "text/x-vue", svelte: "text/x-svelte", tf: "text/x-terraform",
  };

  const TEXT_TYPE_RE = /^(text\/|application\/(json|xml|toml|sql|graphql|javascript|typescript|x-sh))/;
  const HLJS_LANG = {
    js: "javascript", mjs: "javascript", cjs: "javascript", jsx: "javascript", ts: "typescript", tsx: "typescript",
    py: "python", rb: "ruby", go: "go", rs: "rust", java: "java", c: "c", h: "c", cpp: "cpp", cc: "cpp", hpp: "cpp",
    cs: "csharp", php: "php", sh: "bash", bash: "bash", zsh: "bash", json: "json", yaml: "yaml", yml: "yaml",
    xml: "xml", html: "xml", css: "css", scss: "scss", sql: "sql", md: "markdown", lua: "lua", kt: "kotlin",
    swift: "swift", toml: "ini", ini: "ini",
  };

  function ext(name) {
    const i = name.lastIndexOf(".");
    return i === -1 ? name.toLowerCase() : name.slice(i + 1).toLowerCase();
  }

  function mimeFor(file) {
    if (file.type && file.type !== "application/octet-stream") return file.type;
    return EXT_MIME[ext(file.name)] || "application/octet-stream";
  }

  function formatBytes(bytes) {
    if (bytes < 1024) return bytes + " B";
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + " KB";
    if (bytes < 1024 * 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(1) + " MB";
    return (bytes / (1024 * 1024 * 1024)).toFixed(2) + " GB";
  }

  function iconFor(type, isFolder) {
    if (isFolder) return "folder";
    if (type.startsWith("image/")) return "image";
    if (type.startsWith("video/")) return "video";
    if (type.startsWith("audio/")) return "audio";
    if (type === "application/pdf") return "pdf";
    if (/zip|tar|gzip|7z|rar/.test(type)) return "archive";
    if (TEXT_TYPE_RE.test(type)) return "code";
    return "file";
  }

  const ICONS = {
    folder: '<path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>',
    image: '<rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/>',
    video: '<polygon points="23 7 16 12 23 17 23 7"/><rect x="1" y="5" width="15" height="14" rx="2"/>',
    audio: '<path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/>',
    pdf: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="9" y1="15" x2="15" y2="15"/>',
    archive: '<path d="M21 8v13H3V8"/><path d="M1 3h22v5H1z"/><path d="M10 12h4"/>',
    code: '<polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/>',
    file: '<path d="M13 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/><polyline points="13 2 13 9 20 9"/>',
    download: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/>',
    eye: '<path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/>',
    trash: '<polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>',
    edit: '<path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/>',
    plus: '<line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>',
    upload: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/>',
    close: '<line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>',
    retry: '<polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/>',
    move: '<polyline points="5 9 2 12 5 15"/><polyline points="9 5 12 2 15 5"/><polyline points="15 19 12 22 9 19"/><polyline points="19 9 22 12 19 15"/><line x1="2" y1="12" x2="22" y2="12"/><line x1="12" y1="2" x2="12" y2="22"/>',
  };

  function svg(name, size) {
    const s = size || 14;
    return `<svg width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name]}</svg>`;
  }

  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    return e;
  }

  function iconButton(name, title, onClick, extraCls) {
    const b = el("button", "fm-icon-btn" + (extraCls ? " " + extraCls : ""));
    b.type = "button";
    b.title = title;
    b.innerHTML = svg(name, 13);
    b.addEventListener("click", (e) => { e.stopPropagation(); onClick(e); });
    return b;
  }

  // Walks dropped DataTransfer items, including directories, into [{file, relativePath}].
  async function collectDropped(dataTransfer) {
    const out = [];
    const items = dataTransfer.items ? Array.from(dataTransfer.items) : [];
    const entries = items.map((it) => (it.webkitGetAsEntry ? it.webkitGetAsEntry() : null));
    if (!entries.some(Boolean)) {
      for (const f of Array.from(dataTransfer.files || [])) out.push({ file: f, relativePath: "" });
      return out;
    }
    const readEntries = (reader) => new Promise((resolve) => reader.readEntries(resolve, () => resolve([])));
    const walk = async (entry, prefix) => {
      if (entry.isFile) {
        const file = await new Promise((resolve) => entry.file(resolve, () => resolve(null)));
        if (file) out.push({ file, relativePath: prefix });
      } else if (entry.isDirectory) {
        const reader = entry.createReader();
        let batch;
        do {
          batch = await readEntries(reader);
          for (const child of batch) await walk(child, prefix ? `${prefix}/${entry.name}` : entry.name);
        } while (batch.length);
      }
    };
    for (const entry of entries) if (entry) await walk(entry, "");
    return out;
  }

  let fflatePromise = null;
  function loadFflate() {
    if (window.fflate) return Promise.resolve(window.fflate);
    if (!fflatePromise) {
      fflatePromise = new Promise((resolve, reject) => {
        const s = document.createElement("script");
        s.src = FFLATE_URL;
        s.onload = () => resolve(window.fflate);
        s.onerror = () => reject(new Error("Could not load zip library"));
        document.head.appendChild(s);
      });
    }
    return fflatePromise;
  }

  function mount(container, options) {
    const state = {
      kind: options.kind,
      id: options.id || null,
      token: options.token || null,
      role: options.role || "viewer",
      mode: options.mode || "flat",
      allowUpload: options.allowUpload !== false,
      files: [],
      folders: [],
      totalSize: 0,
      quota: options.quota || null,
      cwd: "",
      selected: new Set(),
      uploads: [],       // { key, file, folder, status, progress, error, fileId }
      staged: [],        // files chosen before the owner exists
      active: 0,
    };
    const toast = options.toast || (() => {});
    const onChange = options.onChange || (() => {});

    container.classList.add("fm", state.mode === "explorer" ? "fm-explorer" : "fm-flat");
    container.innerHTML = "";

    const toolbar = el("div", "fm-toolbar");
    const crumbs = el("div", "fm-crumbs");
    const dropZone = el("div", "fm-dropzone");
    const list = el("div", "fm-list");
    const footer = el("div", "fm-footer");
    const fileInput = document.createElement("input");
    fileInput.type = "file";
    fileInput.multiple = true;
    fileInput.hidden = true;
    const dirInput = document.createElement("input");
    dirInput.type = "file";
    dirInput.hidden = true;
    dirInput.setAttribute("webkitdirectory", "");

    container.append(toolbar, crumbs, dropZone, list, footer, fileInput, dirInput);

    const canUpload = () => state.allowUpload && (state.role === "admin" || state.role === "viewer-upload") && !!(state.id || state.mode === "flat");
    const isAdmin = () => state.role === "admin";
    const authQuery = () => `kind=${state.kind}&id=${encodeURIComponent(state.id)}${state.token ? "&token=" + encodeURIComponent(state.token) : ""}`;
    const fileUrl = (f, inline) => `/api/files/get?${authQuery()}&fileId=${f.fileId}${inline ? "&inline=1" : ""}`;

    // ── Rendering ──

    function render() {
      renderToolbar();
      renderCrumbs();
      renderDropZone();
      renderList();
      renderFooter();
    }

    function renderToolbar() {
      toolbar.innerHTML = "";
      if (state.mode !== "explorer") { toolbar.hidden = true; return; }
      toolbar.hidden = false;

      if (canUpload()) {
        const up = el("button", "fm-btn fm-btn-primary");
        up.type = "button";
        up.innerHTML = svg("upload", 13) + "<span>Upload</span>";
        up.addEventListener("click", () => fileInput.click());
        toolbar.appendChild(up);

        const upDir = el("button", "fm-btn");
        upDir.type = "button";
        upDir.innerHTML = svg("folder", 13) + "<span>Upload folder</span>";
        upDir.addEventListener("click", () => dirInput.click());
        toolbar.appendChild(upDir);
      }
      if (isAdmin()) {
        const mk = el("button", "fm-btn");
        mk.type = "button";
        mk.innerHTML = svg("plus", 13) + "<span>New folder</span>";
        mk.addEventListener("click", newFolder);
        toolbar.appendChild(mk);
      }

      const spacer = el("div", "fm-spacer");
      toolbar.appendChild(spacer);

      if (state.selected.size) {
        const count = el("span", "fm-sel-count", `${state.selected.size} selected`);
        toolbar.appendChild(count);
        const zipSel = el("button", "fm-btn");
        zipSel.type = "button";
        zipSel.innerHTML = svg("download", 13) + "<span>Zip selection</span>";
        zipSel.addEventListener("click", () => downloadZip(selectedFiles(), "selection"));
        toolbar.appendChild(zipSel);
        if (isAdmin()) {
          const delSel = el("button", "fm-btn fm-btn-danger");
          delSel.type = "button";
          delSel.innerHTML = svg("trash", 13) + "<span>Delete</span>";
          delSel.addEventListener("click", deleteSelection);
          toolbar.appendChild(delSel);
        }
        const clear = el("button", "fm-btn");
        clear.type = "button";
        clear.innerHTML = svg("close", 13);
        clear.title = "Clear selection";
        clear.addEventListener("click", () => { state.selected.clear(); render(); });
        toolbar.appendChild(clear);
      } else if (state.files.length) {
        const zipAll = el("button", "fm-btn");
        zipAll.type = "button";
        zipAll.innerHTML = svg("download", 13) + `<span>${state.cwd ? "Zip folder" : "Zip all"}</span>`;
        zipAll.addEventListener("click", () => downloadZip(filesUnder(state.cwd), state.cwd ? baseName(state.cwd) : "drive"));
        toolbar.appendChild(zipAll);
      }
    }

    function renderCrumbs() {
      crumbs.innerHTML = "";
      if (state.mode !== "explorer") { crumbs.hidden = true; return; }
      crumbs.hidden = false;
      const parts = state.cwd ? state.cwd.split("/") : [];
      const root = el("button", "fm-crumb" + (parts.length ? "" : " active"), "root");
      root.type = "button";
      root.addEventListener("click", () => navigate(""));
      makeDropTarget(root, "");
      crumbs.appendChild(root);
      let acc = "";
      parts.forEach((p, i) => {
        crumbs.appendChild(el("span", "fm-crumb-sep", "/"));
        acc = acc ? `${acc}/${p}` : p;
        const target = acc;
        const b = el("button", "fm-crumb" + (i === parts.length - 1 ? " active" : ""), p);
        b.type = "button";
        b.addEventListener("click", () => navigate(target));
        makeDropTarget(b, target);
        crumbs.appendChild(b);
      });
    }

    function renderDropZone() {
      dropZone.innerHTML = "";
      const show = canUpload() && (state.mode === "flat" || (!currentEntries().length && !state.uploads.length));
      dropZone.hidden = !show;
      if (!show) return;
      const inner = el("div", "fm-dropzone-inner");
      inner.innerHTML = svg("upload", 18) + `<span><strong>Drop files${state.mode === "explorer" ? " or folders" : ""}</strong> here, paste from clipboard, or <u>browse</u></span><small>Up to 100 MB per file</small>`;
      dropZone.appendChild(inner);
      dropZone.onclick = () => fileInput.click();
    }

    function currentEntries() {
      if (state.mode === "flat") return state.files.map((f) => ({ type: "file", file: f }));
      const folders = state.folders.filter((f) => parentOf(f) === state.cwd && f !== "");
      const files = state.files.filter((f) => f.path === state.cwd);
      return [
        ...folders.map((path) => ({ type: "folder", path, name: baseName(path) })),
        ...files.map((file) => ({ type: "file", file })),
      ];
    }

    function renderList() {
      list.innerHTML = "";
      const entries = currentEntries();
      const uploadsHere = state.uploads.filter((u) => state.mode === "flat" || u.folder === state.cwd || u.status === "error");

      if (!entries.length && !uploadsHere.length) {
        list.hidden = state.mode === "flat" && !state.staged.length;
        if (state.mode === "explorer" && !canUpload()) {
          const empty = el("div", "fm-empty", "Empty folder");
          list.appendChild(empty);
          list.hidden = false;
        }
      } else {
        list.hidden = false;
      }

      if (state.mode === "explorer" && state.cwd) {
        const up = el("div", "fm-row fm-row-up");
        up.innerHTML = `<span class="fm-icon">${svg("folder")}</span><span class="fm-name">..</span>`;
        up.addEventListener("click", () => navigate(parentOf(state.cwd)));
        makeDropTarget(up, parentOf(state.cwd));
        list.appendChild(up);
      }

      for (const entry of entries) {
        list.appendChild(entry.type === "folder" ? folderRow(entry) : fileRow(entry.file));
      }
      for (const u of uploadsHere) list.appendChild(uploadRow(u));
      for (const s of state.staged) list.appendChild(stagedRow(s));
    }

    function folderRow(entry) {
      const row = el("div", "fm-row fm-row-folder");
      row.draggable = isAdmin();
      row.dataset.path = entry.path;
      const check = selectBox(`d:${entry.path}`);
      if (check) row.appendChild(check);
      row.insertAdjacentHTML("beforeend", `<span class="fm-icon fm-icon-folder">${svg("folder")}</span>`);
      row.appendChild(el("span", "fm-name", entry.name));
      const count = state.files.filter((f) => f.path === entry.path || f.path.startsWith(entry.path + "/")).length;
      row.appendChild(el("span", "fm-meta", `${count} file${count === 1 ? "" : "s"}`));
      const actions = el("div", "fm-actions");
      actions.appendChild(iconButton("download", "Download as zip", () => downloadZip(filesUnder(entry.path), entry.name)));
      if (isAdmin()) {
        actions.appendChild(iconButton("edit", "Rename", () => renameFolder(entry.path)));
        actions.appendChild(iconButton("trash", "Delete folder", () => deleteFolder(entry.path), "fm-icon-btn-danger"));
      }
      row.appendChild(actions);
      row.addEventListener("click", () => navigate(entry.path));
      makeDropTarget(row, entry.path);
      if (isAdmin()) row.addEventListener("dragstart", (e) => { e.dataTransfer.setData("application/x-fm", JSON.stringify({ path: entry.path })); e.dataTransfer.effectAllowed = "move"; });
      return row;
    }

    function fileRow(f) {
      const row = el("div", "fm-row fm-row-file");
      row.draggable = isAdmin() && state.mode === "explorer";
      const check = selectBox(`f:${f.fileId}`);
      if (check) row.appendChild(check);
      row.insertAdjacentHTML("beforeend", `<span class="fm-icon">${svg(iconFor(f.type, false))}</span>`);
      const name = el("span", "fm-name", f.name);
      name.title = f.name;
      row.appendChild(name);
      const meta = el("span", "fm-meta", formatBytes(f.size) + (f.by === "viewer" ? " · viewer" : ""));
      row.appendChild(meta);
      const actions = el("div", "fm-actions");
      if (canPreview(f)) actions.appendChild(iconButton("eye", "Preview", () => openPreview(f)));
      const dl = el("a", "fm-icon-btn");
      dl.href = fileUrl(f, false);
      dl.download = f.name;
      dl.title = "Download";
      dl.innerHTML = svg("download", 13);
      dl.addEventListener("click", (e) => e.stopPropagation());
      actions.appendChild(dl);
      if (isAdmin() && f.fileId !== "legacy") {
        actions.appendChild(iconButton("edit", "Rename", () => renameFile(f)));
        actions.appendChild(iconButton("trash", "Delete", () => deleteFile(f), "fm-icon-btn-danger"));
      }
      row.appendChild(actions);
      row.addEventListener("click", () => { if (canPreview(f)) openPreview(f); else window.open(fileUrl(f, false), "_blank"); });
      if (row.draggable) row.addEventListener("dragstart", (e) => { e.dataTransfer.setData("application/x-fm", JSON.stringify({ fileId: f.fileId })); e.dataTransfer.effectAllowed = "move"; });
      return row;
    }

    function uploadRow(u) {
      const row = el("div", "fm-row fm-row-upload fm-status-" + u.status);
      row.insertAdjacentHTML("beforeend", `<span class="fm-icon">${svg(iconFor(mimeFor(u.file), false))}</span>`);
      const name = el("span", "fm-name", u.folder && state.mode === "flat" ? `${u.folder}/${u.file.name}` : u.file.name);
      row.appendChild(name);
      const meta = el("span", "fm-meta");
      if (u.status === "error") meta.textContent = u.error || "Failed";
      else if (u.status === "queued") meta.textContent = "Queued";
      else if (u.status === "done") meta.textContent = "Done";
      else meta.textContent = `${Math.round(u.progress * 100)}% · ${formatBytes(u.file.size)}`;
      row.appendChild(meta);
      const actions = el("div", "fm-actions");
      if (u.status === "error") actions.appendChild(iconButton("retry", "Retry", () => retryUpload(u)));
      if (u.status !== "done") actions.appendChild(iconButton("close", "Cancel", () => cancelUpload(u)));
      row.appendChild(actions);
      if (u.status === "uploading" || u.status === "queued") {
        const bar = el("div", "fm-progress");
        const fill = el("div", "fm-progress-fill");
        fill.style.width = `${Math.round(u.progress * 100)}%`;
        bar.appendChild(fill);
        row.appendChild(bar);
      }
      return row;
    }

    function stagedRow(s) {
      const row = el("div", "fm-row fm-row-staged");
      row.insertAdjacentHTML("beforeend", `<span class="fm-icon">${svg(iconFor(mimeFor(s.file), false))}</span>`);
      row.appendChild(el("span", "fm-name", s.relativePath ? `${s.relativePath}/${s.file.name}` : s.file.name));
      row.appendChild(el("span", "fm-meta", formatBytes(s.file.size) + " · ready"));
      const actions = el("div", "fm-actions");
      actions.appendChild(iconButton("close", "Remove", () => { state.staged = state.staged.filter((x) => x !== s); render(); }));
      row.appendChild(actions);
      return row;
    }

    function selectBox(key) {
      if (state.mode !== "explorer") return null;
      const wrap = el("label", "fm-check");
      const cb = document.createElement("input");
      cb.type = "checkbox";
      cb.checked = state.selected.has(key);
      cb.addEventListener("click", (e) => e.stopPropagation());
      cb.addEventListener("change", () => { if (cb.checked) state.selected.add(key); else state.selected.delete(key); renderToolbar(); });
      wrap.appendChild(cb);
      wrap.addEventListener("click", (e) => e.stopPropagation());
      return wrap;
    }

    function renderFooter() {
      footer.innerHTML = "";
      const show = state.files.length > 0 || state.uploads.length > 0;
      footer.hidden = !show;
      if (!show) return;
      const n = state.files.length;
      let text = `${n} file${n === 1 ? "" : "s"} · ${formatBytes(state.totalSize)}`;
      if (state.quota) text += ` / ${formatBytes(state.quota.maxTotal)}`;
      footer.appendChild(el("span", "fm-footer-text", text));
      const active = state.uploads.filter((u) => u.status === "uploading" || u.status === "queued").length;
      if (active) footer.appendChild(el("span", "fm-footer-text fm-footer-active", `${active} uploading`));
      if (state.mode === "flat" && state.files.length > 1) {
        const zip = el("button", "fm-btn fm-btn-sm");
        zip.type = "button";
        zip.innerHTML = svg("download", 12) + "<span>Zip all</span>";
        zip.addEventListener("click", () => downloadZip(state.files, `paste-${state.id}`));
        footer.appendChild(zip);
      }
    }

    // ── Navigation & selection ──

    function navigate(path) {
      state.cwd = path;
      state.selected.clear();
      render();
    }

    function parentOf(p) { const i = p.lastIndexOf("/"); return i === -1 ? "" : p.slice(0, i); }
    function baseName(p) { const i = p.lastIndexOf("/"); return i === -1 ? p : p.slice(i + 1); }
    function filesUnder(folder) {
      return state.files.filter((f) => !folder || f.path === folder || f.path.startsWith(folder + "/"));
    }
    function selectedFiles() {
      const out = new Map();
      for (const key of state.selected) {
        if (key.startsWith("f:")) {
          const f = state.files.find((x) => x.fileId === key.slice(2));
          if (f) out.set(f.fileId, f);
        } else {
          for (const f of filesUnder(key.slice(2))) out.set(f.fileId, f);
        }
      }
      return [...out.values()];
    }

    // ── Drag & drop ──

    let dragDepth = 0;
    container.addEventListener("dragenter", (e) => {
      if (!canUpload() || hasInternalDrag(e)) return;
      e.preventDefault();
      dragDepth++;
      container.classList.add("fm-dragover");
    });
    container.addEventListener("dragover", (e) => {
      if (!canUpload() && !hasInternalDrag(e)) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = hasInternalDrag(e) ? "move" : "copy";
    });
    container.addEventListener("dragleave", () => {
      dragDepth = Math.max(0, dragDepth - 1);
      if (!dragDepth) container.classList.remove("fm-dragover");
    });
    container.addEventListener("drop", async (e) => {
      dragDepth = 0;
      container.classList.remove("fm-dragover");
      if (hasInternalDrag(e)) return;
      if (!canUpload()) return;
      e.preventDefault();
      const dropped = await collectDropped(e.dataTransfer);
      enqueue(dropped);
    });

    function hasInternalDrag(e) {
      return Array.from(e.dataTransfer.types || []).includes("application/x-fm");
    }

    function makeDropTarget(node, targetPath) {
      if (!isAdmin() || state.mode !== "explorer") return;
      node.addEventListener("dragover", (e) => {
        if (!hasInternalDrag(e)) return;
        e.preventDefault();
        e.stopPropagation();
        node.classList.add("fm-drop-target");
      });
      node.addEventListener("dragleave", () => node.classList.remove("fm-drop-target"));
      node.addEventListener("drop", async (e) => {
        if (!hasInternalDrag(e)) return;
        e.preventDefault();
        e.stopPropagation();
        node.classList.remove("fm-drop-target");
        let payload;
        try { payload = JSON.parse(e.dataTransfer.getData("application/x-fm")); } catch { return; }
        if (payload.fileId) await runOps([{ op: "move", fileId: payload.fileId, to: targetPath }]);
        else if (payload.path && payload.path !== targetPath) await runOps([{ op: "move", path: payload.path, to: targetPath }]);
      });
    }

    fileInput.addEventListener("change", () => {
      enqueue(Array.from(fileInput.files).map((file) => ({ file, relativePath: "" })));
      fileInput.value = "";
    });
    dirInput.addEventListener("change", () => {
      enqueue(Array.from(dirInput.files).map((file) => {
        const rel = file.webkitRelativePath || "";
        const dir = rel.includes("/") ? rel.slice(0, rel.lastIndexOf("/")) : "";
        return { file, relativePath: dir };
      }));
      dirInput.value = "";
    });

    function onPaste(e) {
      if (!canUpload()) return;
      const target = e.target;
      if (target && (target.tagName === "TEXTAREA" || target.tagName === "INPUT")) return;
      const files = Array.from(e.clipboardData ? e.clipboardData.files : []);
      if (!files.length) return;
      e.preventDefault();
      enqueue(files.map((file) => ({ file, relativePath: "" })));
    }
    document.addEventListener("paste", onPaste);

    // ── Upload queue ──

    function enqueue(items) {
      const accepted = [];
      for (const it of items) {
        const file = it.file || it;
        if (!file || !file.size) { toast(`${file ? file.name : "File"} is empty`, "error"); continue; }
        if (file.size > MAX_FILE_SIZE) { toast(`${file.name}: too large (max 100 MB)`, "error"); continue; }
        accepted.push({ file, relativePath: state.mode === "explorer" ? (it.relativePath || "") : "" });
      }
      if (!accepted.length) return;
      if (!state.id) {
        state.staged.push(...accepted);
        render();
        return;
      }
      for (const a of accepted) {
        const folder = joinFolder(state.cwd, a.relativePath);
        state.uploads.push({ key: Math.random().toString(36).slice(2), file: a.file, folder, status: "queued", progress: 0, error: null, fileId: null, xhr: null });
      }
      render();
      pump();
    }

    function joinFolder(base, rel) {
      const parts = [base, rel].filter(Boolean);
      return parts.join("/");
    }

    function pump() {
      while (state.active < CONCURRENCY) {
        const next = state.uploads.find((u) => u.status === "queued");
        if (!next) break;
        state.active++;
        uploadOne(next).finally(() => { state.active--; pump(); });
      }
    }

    async function uploadOne(u) {
      u.status = "uploading";
      u.progress = 0;
      renderList(); renderFooter();
      try {
        const tokenRes = await fetch("/api/files/token", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ kind: state.kind, id: state.id, token: state.token, path: u.folder, name: u.file.name, size: u.file.size, type: mimeFor(u.file) }),
        });
        const tokenData = await tokenRes.json().catch(() => ({}));
        if (!tokenRes.ok) throw new Error(tokenData.message || "Upload refused");
        u.fileId = tokenData.fileId;

        await putWithProgress(tokenData.upload, u);

        let committed = null;
        for (let attempt = 0; attempt < 2 && !committed; attempt++) {
          const commitRes = await fetch("/api/files/commit", {
            method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ kind: state.kind, id: state.id, token: state.token, fileId: u.fileId }),
          });
          const commitData = await commitRes.json().catch(() => ({}));
          if (commitRes.ok) committed = commitData.file;
          else if (attempt === 1 || commitRes.status !== 409) throw new Error(commitData.message || "Commit failed");
        }
        u.status = "done";
        state.files.push(committed);
        state.totalSize += committed.size;
        if (state.mode === "explorer" && committed.path) ensureFolder(committed.path);
        setTimeout(() => { state.uploads = state.uploads.filter((x) => x !== u); render(); }, 800);
        onChange(listing());
      } catch (err) {
        if (u.status === "cancelled") return;
        u.status = "error";
        u.error = err.message || "Upload failed";
        toast(`${u.file.name}: ${u.error}`, "error");
      }
      render();
    }

    function putWithProgress(target, u) {
      return new Promise((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        u.xhr = xhr;
        xhr.open("PUT", target.url, true);
        for (const [k, v] of Object.entries(target.headers || {})) xhr.setRequestHeader(k, v);
        xhr.upload.onprogress = (e) => {
          if (e.lengthComputable) { u.progress = e.loaded / e.total; renderList(); }
        };
        xhr.onload = () => {
          u.xhr = null;
          if (xhr.status >= 200 && xhr.status < 300) resolve();
          else reject(new Error(xhr.status === 413 ? "File too large" : `Upload failed (${xhr.status})`));
        };
        xhr.onerror = () => { u.xhr = null; reject(new Error("Network error during upload")); };
        xhr.onabort = () => { u.xhr = null; reject(new Error("Cancelled")); };
        xhr.send(u.file);
      });
    }

    function retryUpload(u) {
      u.status = "queued";
      u.error = null;
      u.progress = 0;
      render();
      pump();
    }

    function cancelUpload(u) {
      if (u.xhr) { u.status = "cancelled"; u.xhr.abort(); }
      state.uploads = state.uploads.filter((x) => x !== u);
      render();
    }

    function ensureFolder(path) {
      let p = path;
      while (p) {
        if (!state.folders.includes(p)) state.folders.push(p);
        p = parentOf(p);
      }
      state.folders.sort();
    }

    // ── Server operations ──

    async function runOps(ops) {
      try {
        const r = await fetch("/api/files/op", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ kind: state.kind, id: state.id, token: state.token, ops }),
        });
        const d = await r.json().catch(() => ({}));
        if (!r.ok) { toast(d.message || "Operation failed", "error"); return false; }
        applyListing(d);
        state.selected.clear();
        render();
        onChange(listing());
        return true;
      } catch {
        toast("Network error", "error");
        return false;
      }
    }

    function newFolder() {
      const name = prompt("Folder name");
      if (!name) return;
      const path = state.cwd ? `${state.cwd}/${name.trim()}` : name.trim();
      runOps([{ op: "mkdir", path }]);
    }
    function renameFolder(path) {
      const name = prompt("Rename folder", baseName(path));
      if (!name || name === baseName(path)) return;
      runOps([{ op: "rename", path, name }]);
    }
    function renameFile(f) {
      const name = prompt("Rename file", f.name);
      if (!name || name === f.name) return;
      runOps([{ op: "rename", fileId: f.fileId, name }]);
    }
    async function deleteFile(f) {
      if (!confirm(`Delete "${f.name}"?`)) return;
      if (await runOps([{ op: "delete", fileId: f.fileId }])) toast("File deleted");
    }
    async function deleteFolder(path) {
      const n = filesUnder(path).length;
      if (!confirm(`Delete folder "${baseName(path)}"${n ? ` and its ${n} file(s)` : ""}?`)) return;
      if (await runOps([{ op: "delete", path }])) toast("Folder deleted");
    }
    async function deleteSelection() {
      const ops = [];
      for (const key of state.selected) ops.push(key.startsWith("f:") ? { op: "delete", fileId: key.slice(2) } : { op: "delete", path: key.slice(2) });
      if (!ops.length || !confirm(`Delete ${ops.length} item(s)?`)) return;
      if (await runOps(ops)) toast("Deleted");
    }

    // ── Preview ──

    function canPreview(f) {
      const t = f.type || "";
      return t.startsWith("image/") && t !== "image/svg+xml" || t.startsWith("video/") || t.startsWith("audio/") || t === "application/pdf" || (TEXT_TYPE_RE.test(t) && f.size <= 2 * 1024 * 1024);
    }

    let overlay = null;
    function openPreview(f) {
      closePreview();
      overlay = el("div", "fm-preview-overlay");
      const box = el("div", "fm-preview-box");
      const head = el("div", "fm-preview-head");
      head.appendChild(el("span", "fm-preview-title", f.name));
      head.appendChild(el("span", "fm-meta", formatBytes(f.size)));
      const dl = el("a", "fm-btn fm-btn-sm");
      dl.href = fileUrl(f, false);
      dl.download = f.name;
      dl.innerHTML = svg("download", 12) + "<span>Download</span>";
      head.appendChild(dl);
      head.appendChild(iconButton("close", "Close", closePreview));
      box.appendChild(head);
      const body = el("div", "fm-preview-body");
      box.appendChild(body);
      overlay.appendChild(box);
      overlay.addEventListener("click", (e) => { if (e.target === overlay) closePreview(); });
      document.body.appendChild(overlay);
      document.addEventListener("keydown", escClose);

      const t = f.type || "";
      const src = fileUrl(f, true);
      if (t.startsWith("image/")) {
        const img = document.createElement("img");
        img.src = src; img.alt = f.name;
        body.appendChild(img);
      } else if (t.startsWith("video/")) {
        const v = document.createElement("video");
        v.src = src; v.controls = true; v.autoplay = true;
        body.appendChild(v);
      } else if (t.startsWith("audio/")) {
        const a = document.createElement("audio");
        a.src = src; a.controls = true; a.autoplay = true;
        body.appendChild(a);
      } else if (t === "application/pdf") {
        const fr = document.createElement("iframe");
        fr.src = src; fr.title = f.name;
        body.appendChild(fr);
      } else {
        const pre = document.createElement("pre");
        const code = document.createElement("code");
        code.textContent = "Loading...";
        pre.appendChild(code);
        body.appendChild(pre);
        fetch(fileUrl(f, false)).then((r) => r.text()).then((text) => {
          code.textContent = text;
          const lang = HLJS_LANG[ext(f.name)];
          if (window.hljs && lang && text.length < 300000) {
            code.className = "hljs language-" + lang;
            try { window.hljs.highlightElement(code); } catch { /* keep plain text */ }
          }
        }).catch(() => { code.textContent = "Could not load file."; });
      }
    }
    function escClose(e) { if (e.key === "Escape") closePreview(); }
    function closePreview() {
      if (overlay) { overlay.remove(); overlay = null; }
      document.removeEventListener("keydown", escClose);
    }

    // ── Zip download (client-side, store only) ──

    async function downloadZip(files, name) {
      if (!files.length) { toast("Nothing to download", "error"); return; }
      let fflate;
      try { fflate = await loadFflate(); } catch (e) { toast(e.message, "error"); return; }
      toast(`Zipping ${files.length} file(s)...`);

      const base = files.length > 1 || state.mode === "explorer" ? commonPrefix(files) : "";
      const chunks = [];
      let writable = null;
      if (window.showSaveFilePicker) {
        try {
          const handle = await window.showSaveFilePicker({ suggestedName: `${name}.zip`, types: [{ description: "Zip archive", accept: { "application/zip": [".zip"] } }] });
          writable = await handle.createWritable();
        } catch (e) {
          if (e && e.name === "AbortError") return;
        }
      }

      const zip = new fflate.Zip();
      let failed = false;
      const done = new Promise((resolve, reject) => {
        zip.ondata = (err, chunk, final) => {
          if (err) { failed = true; return reject(err); }
          if (writable) writable.write(chunk).catch(reject);
          else chunks.push(chunk);
          if (final) resolve();
        };
      });

      const seen = new Set();
      for (const f of files) {
        let rel = f.path && f.path.startsWith(base) ? f.path.slice(base.length).replace(/^\//, "") : f.path;
        let entryName = rel ? `${rel}/${f.name}` : f.name;
        let i = 1;
        while (seen.has(entryName)) entryName = rel ? `${rel}/${f.name} (${i++})` : `${f.name} (${i++})`;
        seen.add(entryName);
        const entry = new fflate.ZipPassThrough(entryName);
        zip.add(entry);
        try {
          const res = await fetch(fileUrl(f, false));
          if (!res.ok) throw new Error(`${f.name}: download failed`);
          const reader = res.body.getReader();
          for (;;) {
            const { value, done: end } = await reader.read();
            if (end) break;
            entry.push(value);
          }
          entry.push(new Uint8Array(0), true);
        } catch (e) {
          toast(e.message, "error");
          entry.push(new Uint8Array(0), true);
        }
        if (failed) break;
      }
      zip.end();
      try { await done; } catch (e) { toast("Zip failed", "error"); if (writable) await writable.abort(); return; }

      if (writable) { await writable.close(); toast("Zip saved"); return; }
      const blob = new Blob(chunks, { type: "application/zip" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url; a.download = `${name}.zip`;
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 5000);
      toast("Zip downloaded");
    }

    function commonPrefix(files) {
      if (state.mode === "flat") return "";
      return state.cwd;
    }

    // ── Public API ──

    function applyListing(l) {
      state.files = (l.files || []).map((f) => ({ ...f, path: f.path || "" }));
      state.folders = (l.folders || []).slice();
      state.totalSize = l.totalSize || state.files.reduce((s, f) => s + f.size, 0);
      if (l.quota) state.quota = l.quota;
      if (state.cwd && !state.folders.includes(state.cwd)) state.cwd = "";
    }
    function listing() { return { files: state.files, folders: state.folders, totalSize: state.totalSize }; }

    const api = {
      setListing(l) { applyListing(l); render(); },
      setAuth({ id, token, role, allowUpload }) {
        if (id !== undefined) state.id = id;
        if (token !== undefined) state.token = token;
        if (role !== undefined) state.role = role;
        if (allowUpload !== undefined) state.allowUpload = allowUpload;
        render();
      },
      enqueue(files) { enqueue(Array.from(files).map((f) => (f.file ? f : { file: f, relativePath: "" }))); },
      hasStaged() { return state.staged.length > 0; },
      stagedCount() { return state.staged.length; },
      async flushStaged() {
        const items = state.staged.splice(0);
        enqueue(items);
        await new Promise((resolve) => {
          const check = () => { if (!state.uploads.some((u) => u.status === "queued" || u.status === "uploading")) resolve(); else setTimeout(check, 200); };
          check();
        });
      },
      isBusy() { return state.uploads.some((u) => u.status === "queued" || u.status === "uploading"); },
      reset() { state.files = []; state.folders = []; state.staged = []; state.uploads = []; state.totalSize = 0; state.cwd = ""; state.selected.clear(); render(); },
      navigate,
      destroy() { document.removeEventListener("paste", onPaste); closePreview(); container.innerHTML = ""; },
    };

    if (options.listing) applyListing(options.listing);
    render();
    return api;
  }

  window.ScribbleFiles = { mount, formatBytes, mimeFor };
})();
