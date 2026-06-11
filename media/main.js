"use strict";

(function () {
  const vscode = acquireVsCodeApi();
  const previousState = vscode.getState();
  let model = previousState && previousState.model ? previousState.model : {
    notes: [],
    active: undefined,
    workspaceAvailable: false,
    defaultScope: "workspace",
    currentNoteOnly: false,
    compactLayout: false
  };

  const pendingSaves = new Map();
  const inFlightSaves = new Set();
  const saveStatusByKey = new Map();
  let queuedState = undefined;
  let dragDepth = 0;

  const elements = {
    app: document.querySelector(".app"),
    notesPanel: document.getElementById("notesPanel"),
    emptyState: document.getElementById("emptyState"),
    dropOverlay: document.getElementById("dropOverlay"),
    emptyProjectNote: document.getElementById("emptyProjectNote"),
    emptyGlobalNote: document.getElementById("emptyGlobalNote"),
    emptyExternalNote: document.getElementById("emptyExternalNote")
  };

  elements.emptyProjectNote.addEventListener("click", () => createNote("workspace"));
  elements.emptyGlobalNote.addEventListener("click", () => createNote("global"));
  elements.emptyExternalNote.addEventListener("click", addExternalFileNote);

  elements.app.addEventListener("dragenter", handleDragEnter, true);
  elements.app.addEventListener("dragover", handleDragOver, true);
  elements.app.addEventListener("dragleave", handleDragLeave, true);
  elements.app.addEventListener("drop", handleDrop, true);

  window.addEventListener("message", (event) => {
    const message = event.data;
    if (!message || typeof message.type !== "string") {
      return;
    }

    if (message.type === "state") {
      receiveState(message.state);
      return;
    }

    if (message.type === "saved") {
      inFlightSaves.delete(message.key);
      setNoteStatus(message.key, "Saved", false);
      updateNoteTimestamp(message.key, message.updatedAt);
      maybeApplyQueuedState();
      return;
    }

    if (message.type === "error") {
      setActiveStatus(message.message || "Save failed", true);
    }
  });

  window.addEventListener("blur", () => {
    flushAllPendingSaves();
    maybeApplyQueuedState();
  });

  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") {
      flushAllPendingSaves();
    }
  });

  render();
  vscode.postMessage({ type: "ready" });

  function receiveState(state) {
    if (!state) {
      return;
    }

    if (hasLocalEdits() || focusedEditableKey()) {
      queuedState = state;
      return;
    }

    applyState(state);
  }

  function applyState(state) {
    model = state;
    vscode.setState({ model });
    render();
  }

  function maybeApplyQueuedState() {
    if (!queuedState || hasLocalEdits() || focusedEditableKey()) {
      return;
    }

    const state = queuedState;
    queuedState = undefined;
    applyState(state);
  }

  function createNote(scope) {
    flushAllPendingSaves();
    vscode.postMessage({ type: "createNote", scope });
  }

  function addExternalFileNote() {
    flushAllPendingSaves();
    vscode.postMessage({ type: "addExternalFileNote" });
  }

  function render() {
    const hasNotes = model.notes.length > 0;
    elements.app.classList.toggle("current-only", Boolean(model.currentNoteOnly));
    elements.app.classList.toggle("compact-layout", Boolean(model.compactLayout));
    elements.notesPanel.hidden = !hasNotes;
    elements.emptyState.hidden = hasNotes;
    elements.emptyProjectNote.disabled = !model.workspaceAvailable;

    if (!hasNotes) {
      elements.notesPanel.textContent = "";
      return;
    }

    const notes = notesToRender();
    elements.notesPanel.textContent = "";
    for (const note of notes) {
      elements.notesPanel.appendChild(renderNoteCard(note));
    }
  }

  function renderNoteCard(note) {
    const key = noteKey(note);
    const card = document.createElement("article");
    card.className = "note-card";
    card.dataset.noteKey = key;
    card.classList.toggle("active", isActive(note));
    card.classList.toggle("file-backed", note.sourceKind === "file");
    card.classList.toggle("source-error", Boolean(note.sourceError));
    card.addEventListener("focusin", () => makeActive(note));
    card.addEventListener("click", () => makeActive(note));

    const header = document.createElement("div");
    header.className = "note-header";

    const titleInput = document.createElement("input");
    titleInput.className = "title-input";
    titleInput.type = "text";
    titleInput.value = note.title || "";
    titleInput.placeholder = "Untitled note";
    titleInput.setAttribute("aria-label", "Note title");
    titleInput.addEventListener("input", () => {
      note.title = titleInput.value;
      scheduleSave(note);
    });

    const scopeSelect = document.createElement("select");
    scopeSelect.className = "scope-select";
    scopeSelect.setAttribute("aria-label", "Note scope");
    scopeSelect.append(createScopeOption("workspace", "Project", !model.workspaceAvailable));
    scopeSelect.append(createScopeOption("global", "Global", false));
    scopeSelect.value = note.scope;
    scopeSelect.addEventListener("change", () => {
      flushPendingSave(key);
      vscode.postMessage({
        type: "moveNote",
        scope: note.scope,
        id: note.id,
        targetScope: scopeSelect.value
      });
    });

    header.append(titleInput, scopeSelect);

    const meta = document.createElement("div");
    meta.className = "note-meta";
    meta.append(
      renderBadge(scopeLabel(note.scope), note.scope),
      renderBadge(note.sourceKind === "file" ? "File" : "Internal", note.sourceKind === "file" ? "file" : "internal")
    );

    const source = document.createElement("span");
    source.className = "source-label";
    source.textContent = sourceText(note);
    source.title = sourceText(note);
    meta.appendChild(source);

    const updated = document.createElement("span");
    updated.className = "updated-label";
    updated.textContent = updatedText(note.updatedAt);
    meta.appendChild(updated);

    const contentInput = document.createElement("div");
    contentInput.className = "content-input";
    contentInput.setAttribute("contenteditable", "plaintext-only");
    contentInput.setAttribute("role", "textbox");
    contentInput.setAttribute("aria-multiline", "true");
    contentInput.setAttribute("aria-label", `${displayTitle(note)} content`);
    contentInput.dataset.placeholder = "Write a note...";
    contentInput.spellcheck = true;
    contentInput.textContent = typeof note.content === "string" ? note.content : "";
    contentInput.addEventListener("input", () => {
      note.content = contentInput.textContent || "";
      scheduleSave(note);
    });
    contentInput.addEventListener("blur", () => {
      flushPendingSave(key);
      maybeApplyQueuedState();
    });

    const footer = document.createElement("div");
    footer.className = "note-footer";

    const status = document.createElement("span");
    status.className = "save-status";
    const storedStatus = saveStatusByKey.get(key);
    if (storedStatus) {
      status.textContent = storedStatus.text;
      status.classList.toggle("error", Boolean(storedStatus.isError));
    } else if (note.sourceError) {
      status.textContent = "Cannot read source file";
      status.classList.add("error");
      status.title = note.sourceError;
    }

    const actions = document.createElement("div");
    actions.className = "note-actions";

    const deleteButton = document.createElement("button");
    deleteButton.type = "button";
    deleteButton.className = "danger";
    deleteButton.textContent = "Delete";
    deleteButton.addEventListener("click", (event) => {
      event.stopPropagation();
      clearPendingSave(key);
      vscode.postMessage({ type: "deleteNote", scope: note.scope, id: note.id });
    });

    actions.appendChild(deleteButton);
    footer.append(status, actions);

    card.append(header, meta, contentInput, footer);
    return card;
  }

  function createScopeOption(value, label, disabled) {
    const option = document.createElement("option");
    option.value = value;
    option.textContent = label;
    option.disabled = Boolean(disabled);
    return option;
  }

  function renderBadge(text, variant) {
    const badge = document.createElement("span");
    badge.className = `meta-badge ${variant || ""}`.trim();
    badge.textContent = text;
    return badge;
  }

  function notesToRender() {
    if (!model.currentNoteOnly) {
      return model.notes;
    }

    const note = activeNote();
    return note ? [note] : [];
  }

  function makeActive(note) {
    if (!note || isActive(note)) {
      return;
    }

    model.active = { scope: note.scope, id: note.id };
    vscode.setState({ model });
    updateActiveCards(note);
    vscode.postMessage({ type: "selectNote", scope: note.scope, id: note.id });
  }

  function updateActiveCards(active) {
    for (const card of elements.notesPanel.querySelectorAll(".note-card")) {
      card.classList.toggle("active", card.dataset.noteKey === noteKey(active));
    }
  }

  function scheduleSave(note) {
    const key = noteKey(note);
    const existing = pendingSaves.get(key);
    if (existing) {
      window.clearTimeout(existing.timer);
    }

    const snapshot = {
      scope: note.scope,
      id: note.id,
      title: note.title,
      content: note.content
    };

    const timer = window.setTimeout(() => sendPendingSave(key), 350);
    pendingSaves.set(key, { timer, snapshot });
    setNoteStatus(key, "Saving...", false);
    vscode.setState({ model });
  }

  function flushAllPendingSaves() {
    for (const key of Array.from(pendingSaves.keys())) {
      flushPendingSave(key);
    }
  }

  function flushPendingSave(key) {
    const pending = pendingSaves.get(key);
    if (!pending) {
      return;
    }

    window.clearTimeout(pending.timer);
    sendPendingSave(key);
  }

  function sendPendingSave(key) {
    const pending = pendingSaves.get(key);
    if (!pending) {
      return;
    }

    pendingSaves.delete(key);
    inFlightSaves.add(key);
    vscode.postMessage({
      type: "updateNote",
      scope: pending.snapshot.scope,
      id: pending.snapshot.id,
      changes: {
        title: pending.snapshot.title,
        content: pending.snapshot.content
      }
    });
  }

  function clearPendingSave(key) {
    const pending = pendingSaves.get(key);
    if (pending) {
      window.clearTimeout(pending.timer);
      pendingSaves.delete(key);
    }

    inFlightSaves.delete(key);
    saveStatusByKey.delete(key);
  }

  function setNoteStatus(key, text, isError) {
    saveStatusByKey.set(key, { text, isError: Boolean(isError) });
    const status = elements.notesPanel.querySelector(`[data-note-key="${cssEscape(key)}"] .save-status`);
    if (status) {
      status.textContent = text;
      status.classList.toggle("error", Boolean(isError));
    }
  }

  function setActiveStatus(text, isError) {
    const note = activeNote();
    if (note) {
      setNoteStatus(noteKey(note), text, isError);
    }
  }

  function updateNoteTimestamp(key, updatedAt) {
    const note = model.notes.find((item) => noteKey(item) === key);
    if (note && typeof updatedAt === "string") {
      note.updatedAt = updatedAt;
      vscode.setState({ model });
    }
  }

  function hasLocalEdits() {
    return pendingSaves.size > 0 || inFlightSaves.size > 0;
  }

  function activeNote() {
    if (!model.active) {
      return model.notes[0];
    }

    return model.notes.find((note) => note.scope === model.active.scope && note.id === model.active.id) || model.notes[0];
  }

  function isActive(note) {
    const active = activeNote();
    return Boolean(active && noteKey(active) === noteKey(note));
  }

  function focusedEditableKey() {
    const activeElement = document.activeElement;
    if (!activeElement || !activeElement.closest) {
      return undefined;
    }

    if (!activeElement.classList.contains("content-input") && !activeElement.classList.contains("title-input")) {
      return undefined;
    }

    const card = activeElement.closest(".note-card");
    return card ? card.dataset.noteKey : undefined;
  }

  function noteKey(note) {
    return `${note.scope}:${note.id}`;
  }

  function displayTitle(note) {
    const title = typeof note.title === "string" ? note.title.trim() : "";
    return title || "Untitled note";
  }

  function scopeLabel(scope) {
    return scope === "workspace" ? "Project" : "Global";
  }

  function sourceText(note) {
    if (note.sourceKind === "file") {
      return note.sourceLabel || note.sourceUri || "External file";
    }

    return "Saved in extension storage";
  }

  function updatedText(value) {
    if (typeof value !== "string") {
      return "";
    }

    const date = new Date(value);
    if (Number.isNaN(date.getTime())) {
      return "";
    }

    return `Updated ${date.toLocaleString()}`;
  }

  function handleDragEnter(event) {
    event.preventDefault();
    dragDepth += 1;
    showDropOverlay();
  }

  function handleDragOver(event) {
    event.preventDefault();
    if (event.dataTransfer) {
      event.dataTransfer.dropEffect = "copy";
    }
    showDropOverlay();
  }

  function handleDragLeave(event) {
    event.preventDefault();
    dragDepth = Math.max(0, dragDepth - 1);
    if (dragDepth === 0) {
      hideDropOverlay();
    }
  }

  function handleDrop(event) {
    event.preventDefault();
    dragDepth = 0;
    hideDropOverlay();
    flushAllPendingSaves();

    const uris = collectDroppedUris(event.dataTransfer);
    vscode.postMessage({
      type: "addExternalFileNotesFromUris",
      uris,
      useActiveEditorFallback: isProbableResourceDrop(event.dataTransfer)
    });
  }

  function showDropOverlay() {
    elements.app.classList.add("drag-active");
    elements.dropOverlay.hidden = false;
  }

  function hideDropOverlay() {
    elements.app.classList.remove("drag-active");
    elements.dropOverlay.hidden = true;
  }

  function collectDroppedUris(dataTransfer) {
    const values = new Set();
    if (!dataTransfer) {
      return [];
    }

    addCandidateText(getTransferData(dataTransfer, "text/uri-list"), values);
    addCandidateText(getTransferData(dataTransfer, "text/plain"), values);

    for (const file of Array.from(dataTransfer.files || [])) {
      if (typeof file.path === "string" && file.path.length > 0) {
        values.add(file.path);
      }
    }

    for (const item of Array.from(dataTransfer.items || [])) {
      const file = item.getAsFile ? item.getAsFile() : undefined;
      if (file && typeof file.path === "string" && file.path.length > 0) {
        values.add(file.path);
      }
    }

    for (const type of Array.from(dataTransfer.types || [])) {
      if (type === "Files" || type === "text/uri-list" || type === "text/plain") {
        continue;
      }

      addCandidateText(getTransferData(dataTransfer, type), values);
    }

    return Array.from(values);
  }

  function getTransferData(dataTransfer, type) {
    try {
      return dataTransfer.getData(type);
    } catch (error) {
      return "";
    }
  }

  function addCandidateText(text, values) {
    if (!text || typeof text !== "string") {
      return;
    }

    const trimmed = text.trim();
    if (!trimmed) {
      return;
    }

    try {
      collectStrings(JSON.parse(trimmed), values, 0);
      return;
    } catch (error) {
      // Plain drag payloads are usually URI lists or file paths.
    }

    for (const line of trimmed.replace(/\0/g, "\n").split(/\r?\n/)) {
      const candidate = line.trim();
      if (candidate && !candidate.startsWith("#")) {
        values.add(candidate);
      }
    }
  }

  function collectStrings(value, values, depth) {
    if (depth > 6 || value === null || value === undefined) {
      return;
    }

    if (typeof value === "string") {
      addCandidateText(value, values);
      return;
    }

    if (Array.isArray(value)) {
      for (const item of value) {
        collectStrings(item, values, depth + 1);
      }
      return;
    }

    if (typeof value === "object") {
      for (const item of Object.values(value)) {
        collectStrings(item, values, depth + 1);
      }
    }
  }

  function isProbableResourceDrop(dataTransfer) {
    if (!dataTransfer) {
      return false;
    }

    if ((dataTransfer.files && dataTransfer.files.length > 0) || (dataTransfer.items && dataTransfer.items.length > 0)) {
      return true;
    }

    return Array.from(dataTransfer.types || []).some((type) => {
      const normalized = type.toLowerCase();
      return normalized.includes("code")
        || normalized.includes("file")
        || normalized.includes("resource")
        || normalized.includes("uri");
    });
  }

  function cssEscape(value) {
    if (window.CSS && typeof window.CSS.escape === "function") {
      return window.CSS.escape(value);
    }

    return value.replace(/["\\]/g, "\\$&");
  }
}());
