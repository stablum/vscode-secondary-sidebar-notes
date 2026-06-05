"use strict";

(function () {
  const vscode = acquireVsCodeApi();
  const previousState = vscode.getState();
  let model = previousState && previousState.model ? previousState.model : {
    notes: [],
    active: undefined,
    workspaceAvailable: false,
    defaultScope: "workspace",
    currentNoteOnly: false
  };
  let pendingSave = undefined;
  let pendingSnapshot = undefined;
  let lastSavedKey = undefined;

  const elements = {
    app: document.querySelector(".app"),
    tabs: document.getElementById("tabs"),
    editor: document.getElementById("editor"),
    emptyState: document.getElementById("emptyState"),
    titleInput: document.getElementById("titleInput"),
    scopeSelect: document.getElementById("scopeSelect"),
    contentInput: document.getElementById("contentInput"),
    saveStatus: document.getElementById("saveStatus"),
    newProjectNote: document.getElementById("newProjectNote"),
    newGlobalNote: document.getElementById("newGlobalNote"),
    focusToggle: document.getElementById("focusToggle"),
    refreshNotes: document.getElementById("refreshNotes"),
    deleteNote: document.getElementById("deleteNote"),
    openStorage: document.getElementById("openStorage"),
    emptyProjectNote: document.getElementById("emptyProjectNote"),
    emptyGlobalNote: document.getElementById("emptyGlobalNote")
  };

  elements.newProjectNote.addEventListener("click", () => createNote("workspace"));
  elements.newGlobalNote.addEventListener("click", () => createNote("global"));
  elements.focusToggle.addEventListener("click", () => {
    const enabled = !Boolean(model.currentNoteOnly);
    flushPendingSave();
    model.currentNoteOnly = enabled;
    vscode.setState({ model });
    renderMode();
    vscode.postMessage({ type: "setCurrentNoteOnly", value: enabled });
  });
  elements.emptyProjectNote.addEventListener("click", () => createNote("workspace"));
  elements.emptyGlobalNote.addEventListener("click", () => createNote("global"));
  elements.refreshNotes.addEventListener("click", () => {
    flushPendingSave();
    vscode.postMessage({ type: "refresh" });
  });
  elements.openStorage.addEventListener("click", () => {
    flushPendingSave();
    vscode.postMessage({ type: "openStorage" });
  });
  elements.deleteNote.addEventListener("click", () => {
    const note = activeNote();
    if (note) {
      clearPendingSave();
      vscode.postMessage({ type: "deleteNote", scope: note.scope, id: note.id });
    }
  });

  elements.titleInput.addEventListener("input", () => {
    const note = activeNote();
    if (!note) {
      return;
    }

    note.title = elements.titleInput.value;
    renderTabs();
    scheduleSave(note);
  });

  elements.contentInput.addEventListener("input", () => {
    const note = activeNote();
    if (!note) {
      return;
    }

    note.content = elements.contentInput.value;
    scheduleSave(note);
  });

  elements.scopeSelect.addEventListener("change", () => {
    const note = activeNote();
    if (!note) {
      return;
    }

    flushPendingSave();
    vscode.postMessage({
      type: "moveNote",
      scope: note.scope,
      id: note.id,
      targetScope: elements.scopeSelect.value
    });
  });

  window.addEventListener("message", (event) => {
    const message = event.data;
    if (!message || typeof message.type !== "string") {
      return;
    }

    if (message.type === "state") {
      model = message.state;
      vscode.setState({ model });
      clearPendingSave();
      render();
      return;
    }

    if (message.type === "saved") {
      lastSavedKey = message.key;
      setSaveStatus("Saved");
      return;
    }

    if (message.type === "error") {
      setSaveStatus(message.message || "Save failed", true);
    }
  });

  window.addEventListener("blur", flushPendingSave);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") {
      flushPendingSave();
    }
  });

  render();
  vscode.postMessage({ type: "ready" });

  function createNote(scope) {
    flushPendingSave();
    vscode.postMessage({ type: "createNote", scope });
  }

  function render() {
    const hasNotes = model.notes.length > 0;
    elements.editor.hidden = !hasNotes;
    elements.emptyState.hidden = hasNotes;
    elements.newProjectNote.disabled = !model.workspaceAvailable;
    elements.emptyProjectNote.disabled = !model.workspaceAvailable;
    elements.scopeSelect.querySelector("option[value='workspace']").disabled = !model.workspaceAvailable;

    renderMode();
    renderTabs();

    const note = activeNote();
    if (!note) {
      setSaveStatus("");
      return;
    }

    elements.titleInput.value = note.title;
    elements.scopeSelect.value = note.scope;
    elements.contentInput.value = note.content;
    setSaveStatus(lastSavedKey === noteKey(note) ? "Saved" : "");
  }

  function renderTabs() {
    const active = activeNote();
    const visibleNotes = model.currentNoteOnly && active ? [active] : model.notes;
    elements.tabs.textContent = "";
    elements.tabs.setAttribute("aria-label", model.currentNoteOnly ? "Current note" : "Notes");

    for (const note of visibleNotes) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "tab";
      button.title = `${scopeLabel(note.scope)}: ${displayTitle(note)}`;
      button.dataset.key = noteKey(note);
      button.setAttribute("aria-selected", active && noteKey(active) === noteKey(note) ? "true" : "false");

      const badge = document.createElement("span");
      badge.className = `scope-badge ${note.scope}`;
      badge.textContent = note.scope === "workspace" ? "P" : "G";

      const label = document.createElement("span");
      label.className = "tab-label";
      label.textContent = displayTitle(note);

      button.append(badge, label);
      button.addEventListener("click", () => selectNote(note));
      elements.tabs.appendChild(button);
    }
  }

  function renderMode() {
    const currentNoteOnly = Boolean(model.currentNoteOnly);
    elements.app.classList.toggle("current-only", currentNoteOnly);
    const label = currentNoteOnly ? "Show all note tabs" : "Show only the current note";
    elements.focusToggle.title = label;
    elements.focusToggle.setAttribute("aria-label", label);
    elements.focusToggle.setAttribute("aria-pressed", String(currentNoteOnly));
  }

  function selectNote(note) {
    flushPendingSave();
    model.active = { scope: note.scope, id: note.id };
    vscode.setState({ model });
    render();
    vscode.postMessage({ type: "selectNote", scope: note.scope, id: note.id });
  }

  function scheduleSave(note) {
    pendingSnapshot = {
      scope: note.scope,
      id: note.id,
      title: note.title,
      content: note.content
    };

    if (pendingSave) {
      window.clearTimeout(pendingSave);
    }

    setSaveStatus("Saving...");
    pendingSave = window.setTimeout(sendPendingSave, 350);
    vscode.setState({ model });
  }

  function flushPendingSave() {
    if (pendingSave) {
      window.clearTimeout(pendingSave);
      sendPendingSave();
    }
  }

  function sendPendingSave() {
    if (!pendingSnapshot) {
      return;
    }

    const snapshot = pendingSnapshot;
    clearPendingSave();
    vscode.postMessage({
      type: "updateNote",
      scope: snapshot.scope,
      id: snapshot.id,
      changes: {
        title: snapshot.title,
        content: snapshot.content
      }
    });
  }

  function clearPendingSave() {
    if (pendingSave) {
      window.clearTimeout(pendingSave);
    }

    pendingSave = undefined;
    pendingSnapshot = undefined;
  }

  function activeNote() {
    if (!model.active) {
      return model.notes[0];
    }

    return model.notes.find((note) => note.scope === model.active.scope && note.id === model.active.id) || model.notes[0];
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

  function setSaveStatus(text, isError) {
    elements.saveStatus.textContent = text;
    elements.saveStatus.classList.toggle("error", Boolean(isError));
  }
}());
