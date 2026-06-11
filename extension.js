"use strict";

const vscode = require("vscode");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const VIEW_ID = "secondarySidebarNotes.notesView";
const EXTENSION_ID = "secondarySidebarNotes";
const ACTIVE_NOTE_KEY = "secondarySidebarNotes.activeNote";
const CURRENT_NOTE_ONLY_KEY = "secondarySidebarNotes.currentNoteOnly";
const COMPACT_LAYOUT_KEY = "secondarySidebarNotes.compactLayout";
const STORAGE_FILE = "notes.v1.json";
const STORAGE_BACKUP_FILE = "notes.v1.json.bak";
const GLOBAL_SCOPE = "global";
const WORKSPACE_SCOPE = "workspace";

function activate(context) {
  const provider = new NotesViewProvider(context);
  provider.syncCurrentNoteOnlyContext();
  provider.syncCompactLayoutContext();

  context.subscriptions.push(
    provider,
    vscode.window.registerWebviewViewProvider(VIEW_ID, provider, {
      webviewOptions: { retainContextWhenHidden: true }
    }),
    vscode.commands.registerCommand("secondarySidebarNotes.focus", () => provider.focus()),
    vscode.commands.registerCommand("secondarySidebarNotes.newGlobalNote", () => provider.createNote(GLOBAL_SCOPE)),
    vscode.commands.registerCommand("secondarySidebarNotes.newWorkspaceNote", () => provider.createNote(WORKSPACE_SCOPE)),
    vscode.commands.registerCommand("secondarySidebarNotes.addExternalFileNote", () => provider.addExternalFileNotes()),
    vscode.commands.registerCommand("secondarySidebarNotes.showCompactLayout", () => provider.setCompactLayout(true)),
    vscode.commands.registerCommand("secondarySidebarNotes.showDetailedLayout", () => provider.setCompactLayout(false)),
    vscode.commands.registerCommand("secondarySidebarNotes.showCurrentNoteOnly", () => provider.setCurrentNoteOnly(true)),
    vscode.commands.registerCommand("secondarySidebarNotes.showAllNoteTabs", () => provider.setCurrentNoteOnly(false)),
    vscode.commands.registerCommand("secondarySidebarNotes.refresh", () => provider.refresh()),
    vscode.commands.registerCommand("secondarySidebarNotes.openStorage", () => provider.openStorage()),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration(EXTENSION_ID)) {
        provider.postState();
      }
    })
  );
}

function deactivate() {}

class NotesViewProvider {
  constructor(context) {
    this.context = context;
    this.globalStore = new JsonNotesStore(vscode.Uri.joinPath(context.globalStorageUri, STORAGE_FILE));
    this.workspaceStore = new JsonNotesStore(
      context.storageUri ? vscode.Uri.joinPath(context.storageUri, STORAGE_FILE) : undefined
    );
    this.globalDocument = emptyDocument();
    this.workspaceDocument = emptyDocument();
    this.loaded = false;
    this.view = undefined;
    this.watchedExternalFiles = new Set();
    this.externalRefreshTimer = undefined;
  }

  dispose() {
    for (const filePath of this.watchedExternalFiles) {
      fs.unwatchFile(filePath);
    }
    this.watchedExternalFiles.clear();

    if (this.externalRefreshTimer) {
      clearTimeout(this.externalRefreshTimer);
      this.externalRefreshTimer = undefined;
    }
  }

  async resolveWebviewView(webviewView) {
    this.view = webviewView;

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [
        vscode.Uri.joinPath(this.context.extensionUri, "media")
      ]
    };

    webviewView.webview.html = this.getHtml(webviewView.webview);
    webviewView.webview.onDidReceiveMessage((message) => {
      this.handleMessage(message).catch((error) => this.reportError(error));
    }, undefined, this.context.subscriptions);

    await this.load();
    await this.ensureInitialNote();
    await this.postState();
  }

  async focus() {
    await vscode.commands.executeCommand(`${VIEW_ID}.focus`);
  }

  async refresh() {
    await this.load(true);
    await this.ensureInitialNote();
    await this.postState();
  }

  async createNote(scope) {
    await this.load();

    const targetScope = this.normalizeTargetScope(scope);
    const targetDocument = this.documentForScope(targetScope);
    const now = new Date().toISOString();
    const note = {
      id: createId(),
      title: nextUntitledTitle(targetDocument.notes, targetScope),
      content: "",
      createdAt: now,
      updatedAt: now
    };

    targetDocument.notes.push(note);
    targetDocument.updatedAt = now;
    await this.saveScope(targetScope);
    await this.setActiveNote(targetScope, note.id);
    await this.focus();
    await this.postState();
  }

  async addExternalFileNotes() {
    const uris = await vscode.window.showOpenDialog({
      canSelectFiles: true,
      canSelectFolders: false,
      canSelectMany: true,
      openLabel: "Add File-Backed Note"
    });

    if (!uris || uris.length === 0) {
      return;
    }

    await this.addExternalFileNoteUris(uris);
  }

  async addExternalFileNotesFromUris(values, useActiveEditorFallback = false) {
    const uris = Array.isArray(values) ? values.map(parseExternalUri).filter(Boolean) : [];
    if (uris.length === 0 && useActiveEditorFallback) {
      uris.push(...activeEditorResourceUris());
    }

    if (uris.length === 0) {
      vscode.window.showInformationMessage("Drop one or more file-backed notes from VS Code's Explorer or editor tabs.");
      return;
    }

    await this.addExternalFileNoteUris(uris);
  }

  async addExternalFileNoteUris(uris) {
    await this.load();

    const externalUris = uniqueExternalUris(uris).filter(isSupportedExternalUri);
    if (externalUris.length === 0) {
      vscode.window.showInformationMessage("No readable file resources were found in the drop.");
      return;
    }

    const config = vscode.workspace.getConfiguration(EXTENSION_ID);
    const targetScope = this.normalizeTargetScope(config.get("defaultScope", WORKSPACE_SCOPE));
    const targetDocument = this.documentForScope(targetScope);
    const now = new Date().toISOString();
    const addedNotes = externalUris.map((uri) => ({
      id: createId(),
      title: titleFromUri(uri),
      content: "",
      source: {
        type: "file",
        uri: uri.toString()
      },
      createdAt: now,
      updatedAt: now
    }));

    targetDocument.notes.push(...addedNotes);
    targetDocument.updatedAt = now;
    await this.saveScope(targetScope);
    await this.setActiveNote(targetScope, addedNotes[0].id);
    await this.focus();
    await this.postState();
  }

  async openStorage() {
    await this.load();

    const choices = [
      {
        label: "Global notes",
        description: "Available in every VS Code workspace",
        store: this.globalStore,
        scope: GLOBAL_SCOPE
      }
    ];

    if (this.workspaceStore.available) {
      choices.unshift({
        label: "Project notes",
        description: "Available in this VS Code workspace",
        store: this.workspaceStore,
        scope: WORKSPACE_SCOPE
      });
    }

    const selected = await vscode.window.showQuickPick(choices, {
      placeHolder: "Reveal notes storage"
    });

    if (!selected) {
      return;
    }

    await this.saveScope(selected.scope);
    await vscode.commands.executeCommand("revealFileInOS", selected.store.uri);
  }

  async handleMessage(message) {
    if (!message || typeof message.type !== "string") {
      return;
    }

    switch (message.type) {
      case "ready":
        await this.load();
        await this.ensureInitialNote();
        await this.postState();
        break;
      case "createNote":
        await this.createNote(message.scope);
        break;
      case "selectNote":
        await this.selectNote(message.scope, message.id);
        break;
      case "updateNote":
        await this.updateNote(message.scope, message.id, message.changes);
        break;
      case "deleteNote":
        await this.deleteNote(message.scope, message.id);
        break;
      case "moveNote":
        await this.moveNote(message.scope, message.id, message.targetScope);
        break;
      case "refresh":
        await this.refresh();
        break;
      case "openStorage":
        await this.openStorage();
        break;
      case "addExternalFileNote":
        await this.addExternalFileNotes();
        break;
      case "addExternalFileNotesFromUris":
        await this.addExternalFileNotesFromUris(message.uris, Boolean(message.useActiveEditorFallback));
        break;
      default:
        break;
    }
  }

  async setCurrentNoteOnly(value) {
    await this.context.globalState.update(CURRENT_NOTE_ONLY_KEY, Boolean(value));
    await this.syncCurrentNoteOnlyContext();
    await this.postState();
  }

  async setCompactLayout(value) {
    await this.context.globalState.update(COMPACT_LAYOUT_KEY, Boolean(value));
    await this.syncCompactLayoutContext();
    await this.postState();
  }

  async syncCurrentNoteOnlyContext() {
    await vscode.commands.executeCommand(
      "setContext",
      "secondarySidebarNotes.currentNoteOnly",
      this.context.globalState.get(CURRENT_NOTE_ONLY_KEY, false)
    );
  }

  async syncCompactLayoutContext() {
    await vscode.commands.executeCommand(
      "setContext",
      "secondarySidebarNotes.compactLayout",
      this.context.globalState.get(COMPACT_LAYOUT_KEY, false)
    );
  }

  async load(force = false) {
    if (this.loaded && !force) {
      return;
    }

    const [globalDocument, workspaceDocument] = await Promise.all([
      this.globalStore.read(),
      this.workspaceStore.available ? this.workspaceStore.read() : Promise.resolve(emptyDocument())
    ]);

    this.globalDocument = globalDocument;
    this.workspaceDocument = workspaceDocument;
    this.loaded = true;
  }

  async ensureInitialNote() {
    const config = vscode.workspace.getConfiguration(EXTENSION_ID);
    if (!config.get("autoCreateFirstNote", true) || this.allNotes().length > 0) {
      await this.ensureValidActiveNote();
      return;
    }

    const configuredScope = config.get("defaultScope", WORKSPACE_SCOPE);
    const scope = this.normalizeTargetScope(configuredScope);
    const document = this.documentForScope(scope);
    const now = new Date().toISOString();
    const note = {
      id: createId(),
      title: "Untitled note",
      content: "",
      createdAt: now,
      updatedAt: now
    };

    document.notes.push(note);
    document.updatedAt = now;
    await this.saveScope(scope);
    await this.setActiveNote(scope, note.id);
  }

  async selectNote(scope, id) {
    await this.load();
    const note = this.findNote(scope, id);
    if (note) {
      await this.setActiveNote(scope, id);
    }
  }

  async updateNote(scope, id, changes) {
    await this.load();

    const note = this.findNote(scope, id);
    if (!note || !changes || typeof changes !== "object") {
      return;
    }

    let changed = false;
    if (Object.prototype.hasOwnProperty.call(changes, "title") && typeof changes.title === "string") {
      note.title = changes.title;
      changed = true;
    }

    if (Object.prototype.hasOwnProperty.call(changes, "content") && typeof changes.content === "string") {
      if (isFileBacked(note)) {
        await writeExternalContent(note, changes.content);
      } else {
        note.content = changes.content;
      }
      changed = true;
    }

    if (!changed) {
      return;
    }

    note.updatedAt = new Date().toISOString();
    this.documentForScope(scope).updatedAt = note.updatedAt;
    await this.saveScope(scope);
    this.postMessage({ type: "saved", key: noteKey(scope, id), updatedAt: note.updatedAt });
  }

  async deleteNote(scope, id) {
    await this.load();
    const document = this.documentForScope(scope);
    const index = document.notes.findIndex((note) => note.id === id);

    if (index === -1) {
      return;
    }

    const note = document.notes[index];
    const config = vscode.workspace.getConfiguration(EXTENSION_ID);
    if (config.get("confirmDelete", true)) {
      const answer = await vscode.window.showWarningMessage(
        `Delete "${displayTitle(note)}"?`,
        { modal: true },
        "Delete"
      );

      if (answer !== "Delete") {
        return;
      }
    }

    document.notes.splice(index, 1);
    document.updatedAt = new Date().toISOString();
    await this.saveScope(scope);
    await this.ensureValidActiveNote();
    await this.postState();
  }

  async moveNote(scope, id, targetScope) {
    await this.load();

    const normalizedTargetScope = this.normalizeTargetScope(targetScope);
    if (scope === normalizedTargetScope) {
      return;
    }

    const sourceDocument = this.documentForScope(scope);
    const targetDocument = this.documentForScope(normalizedTargetScope);
    const index = sourceDocument.notes.findIndex((note) => note.id === id);
    if (index === -1) {
      return;
    }

    const [note] = sourceDocument.notes.splice(index, 1);
    const now = new Date().toISOString();
    note.updatedAt = now;
    sourceDocument.updatedAt = now;
    targetDocument.notes.push(note);
    targetDocument.updatedAt = now;

    await Promise.all([
      this.saveScope(scope),
      this.saveScope(normalizedTargetScope)
    ]);
    await this.setActiveNote(normalizedTargetScope, id);
    await this.postState();
  }

  async postState() {
    if (!this.view) {
      return;
    }

    await this.load();
    await this.ensureValidActiveNote();

    const activeNote = await this.getActiveNote();
    const config = vscode.workspace.getConfiguration(EXTENSION_ID);
    const notes = await this.notesForWebview();
    this.syncExternalFileWatchers(notes);

    this.postMessage({
      type: "state",
      state: {
        workspaceAvailable: this.workspaceStore.available,
        defaultScope: config.get("defaultScope", WORKSPACE_SCOPE),
        currentNoteOnly: this.context.globalState.get(CURRENT_NOTE_ONLY_KEY, false),
        compactLayout: this.context.globalState.get(COMPACT_LAYOUT_KEY, false),
        notes,
        active: activeNote ? { scope: activeNote.scope, id: activeNote.note.id } : undefined
      }
    });
  }

  postMessage(message) {
    if (this.view) {
      this.view.webview.postMessage(message);
    }
  }

  async getActiveNote() {
    const stored = this.context.workspaceState.get(ACTIVE_NOTE_KEY);
    const parsed = parseNoteKey(stored);
    if (parsed) {
      const note = this.findNote(parsed.scope, parsed.id);
      if (note) {
        return { scope: parsed.scope, note };
      }
    }

    const first = this.allNotes()[0];
    if (!first) {
      return undefined;
    }

    return { scope: first.scope, note: first };
  }

  async ensureValidActiveNote() {
    const active = await this.getActiveNote();
    if (active) {
      await this.setActiveNote(active.scope, active.note.id);
    } else {
      await this.context.workspaceState.update(ACTIVE_NOTE_KEY, undefined);
    }
  }

  async setActiveNote(scope, id) {
    await this.context.workspaceState.update(ACTIVE_NOTE_KEY, noteKey(scope, id));
  }

  findNote(scope, id) {
    if (!isKnownScope(scope) || typeof id !== "string") {
      return undefined;
    }

    return this.documentForScope(scope).notes.find((note) => note.id === id);
  }

  documentForScope(scope) {
    return scope === GLOBAL_SCOPE ? this.globalDocument : this.workspaceDocument;
  }

  async saveScope(scope) {
    if (scope === WORKSPACE_SCOPE) {
      if (!this.workspaceStore.available) {
        throw new Error("Project notes need an open VS Code workspace.");
      }
      await this.workspaceStore.write(this.workspaceDocument);
      return;
    }

    await this.globalStore.write(this.globalDocument);
  }

  normalizeTargetScope(scope) {
    if (scope === WORKSPACE_SCOPE && this.workspaceStore.available) {
      return WORKSPACE_SCOPE;
    }

    if (scope === WORKSPACE_SCOPE && !this.workspaceStore.available) {
      vscode.window.showInformationMessage("Project notes need an open VS Code workspace. Creating a global note instead.");
    }

    return GLOBAL_SCOPE;
  }

  allNotes() {
    const notes = [];

    if (this.workspaceStore.available) {
      for (const note of this.workspaceDocument.notes) {
        notes.push({ ...note, scope: WORKSPACE_SCOPE });
      }
    }

    for (const note of this.globalDocument.notes) {
      notes.push({ ...note, scope: GLOBAL_SCOPE });
    }

    return notes;
  }

  async notesForWebview() {
    const notes = this.allNotes();
    await Promise.all(notes.map(async (note) => {
      if (!isFileBacked(note)) {
        note.sourceKind = "internal";
        return;
      }

      const uri = vscode.Uri.parse(note.source.uri);
      note.sourceKind = "file";
      note.sourceLabel = sourceLabel(uri);
      note.sourceUri = uri.toString();

      try {
        note.content = await readExternalContent(note);
        note.sourceError = undefined;
      } catch (error) {
        note.content = "";
        note.sourceError = error instanceof Error ? error.message : String(error);
      }
    }));

    return notes;
  }

  syncExternalFileWatchers(notes) {
    const nextFiles = new Set();

    for (const note of notes) {
      if (!isFileBacked(note)) {
        continue;
      }

      const uri = vscode.Uri.parse(note.source.uri);
      if (uri.scheme === "file") {
        nextFiles.add(uri.fsPath);
      }
    }

    for (const filePath of this.watchedExternalFiles) {
      if (!nextFiles.has(filePath)) {
        fs.unwatchFile(filePath);
        this.watchedExternalFiles.delete(filePath);
      }
    }

    for (const filePath of nextFiles) {
      if (this.watchedExternalFiles.has(filePath)) {
        continue;
      }

      fs.watchFile(filePath, { interval: 1000 }, (current, previous) => {
        if (current.mtimeMs !== previous.mtimeMs || current.size !== previous.size) {
          this.scheduleExternalRefresh();
        }
      });
      this.watchedExternalFiles.add(filePath);
    }
  }

  scheduleExternalRefresh() {
    if (this.externalRefreshTimer) {
      clearTimeout(this.externalRefreshTimer);
    }

    this.externalRefreshTimer = setTimeout(() => {
      this.externalRefreshTimer = undefined;
      this.postState().catch((error) => this.reportError(error));
    }, 250);
  }

  reportError(error) {
    const message = error instanceof Error ? error.message : String(error);
    vscode.window.showErrorMessage(`Secondary Sidebar Notes: ${message}`);
    this.postMessage({ type: "error", message });
  }

  getHtml(webview) {
    const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, "media", "main.js"));
    const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, "media", "styles.css"));
    const nonce = createNonce();

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
  <link rel="stylesheet" href="${styleUri}">
  <title>Secondary Sidebar Notes</title>
</head>
<body>
  <main class="app">
    <section id="notesPanel" class="notes-panel" aria-label="Notes" hidden></section>
    <section id="emptyState" class="empty-state" hidden>
      <p>No notes yet.</p>
      <div class="empty-actions">
        <button type="button" id="emptyProjectNote">New project note</button>
        <button type="button" id="emptyGlobalNote">New global note</button>
        <button type="button" id="emptyExternalNote">Add file-backed note</button>
      </div>
    </section>
    <div id="dropOverlay" class="drop-overlay" hidden>Drop files to add file-backed notes</div>
  </main>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
  }
}

class JsonNotesStore {
  constructor(uri) {
    this.uri = uri;
    this.writeQueue = Promise.resolve();
  }

  get available() {
    return Boolean(this.uri);
  }

  get directoryUri() {
    return this.uri ? vscode.Uri.joinPath(this.uri, "..") : undefined;
  }

  get backupUri() {
    return this.directoryUri ? vscode.Uri.joinPath(this.directoryUri, STORAGE_BACKUP_FILE) : undefined;
  }

  async read() {
    if (!this.uri) {
      return emptyDocument();
    }

    const primary = await this.tryRead(this.uri);
    if (primary) {
      return primary;
    }

    const backup = this.backupUri ? await this.tryRead(this.backupUri) : undefined;
    return backup || emptyDocument();
  }

  async tryRead(uri) {
    try {
      const bytes = await vscode.workspace.fs.readFile(uri);
      const text = Buffer.from(bytes).toString("utf8");
      return normalizeDocument(JSON.parse(text));
    } catch (error) {
      if (isNotFound(error)) {
        return undefined;
      }
      console.warn(`Unable to read notes from ${uri.toString()}:`, error);
      return undefined;
    }
  }

  async write(document) {
    if (!this.uri || !this.directoryUri) {
      throw new Error("Notes storage is not available.");
    }

    const normalized = normalizeDocument(document);
    normalized.updatedAt = new Date().toISOString();
    const payload = `${JSON.stringify(normalized, null, 2)}\n`;
    this.writeQueue = this.writeQueue
      .catch(() => undefined)
      .then(() => this.writePayload(payload));

    return this.writeQueue;
  }

  async writePayload(payload) {
    await vscode.workspace.fs.createDirectory(this.directoryUri);

    if (this.backupUri) {
      try {
        await vscode.workspace.fs.copy(this.uri, this.backupUri, { overwrite: true });
      } catch (error) {
        if (!isNotFound(error)) {
          console.warn("Unable to update notes backup:", error);
        }
      }
    }

    const temporaryUri = vscode.Uri.joinPath(this.directoryUri, `${STORAGE_FILE}.${Date.now()}.${createId()}.tmp`);
    await vscode.workspace.fs.writeFile(temporaryUri, Buffer.from(payload, "utf8"));
    await vscode.workspace.fs.rename(temporaryUri, this.uri, { overwrite: true });
  }
}

function emptyDocument() {
  return {
    schemaVersion: 1,
    updatedAt: new Date().toISOString(),
    notes: []
  };
}

function normalizeDocument(value) {
  const document = value && typeof value === "object" ? value : {};
  const seen = new Set();
  const notes = Array.isArray(document.notes) ? document.notes : [];

  return {
    schemaVersion: 1,
    updatedAt: typeof document.updatedAt === "string" ? document.updatedAt : new Date().toISOString(),
    notes: notes.map((note) => normalizeNote(note, seen)).filter(Boolean)
  };
}

function normalizeNote(value, seen) {
  if (!value || typeof value !== "object") {
    return undefined;
  }

  let id = typeof value.id === "string" && value.id.length > 0 ? value.id : createId();
  while (seen.has(id)) {
    id = createId();
  }
  seen.add(id);

  const now = new Date().toISOString();
  const source = normalizeSource(value.source);
  const normalized = {
    id,
    title: typeof value.title === "string" ? value.title : "Untitled note",
    content: source ? "" : typeof value.content === "string" ? value.content : "",
    createdAt: typeof value.createdAt === "string" ? value.createdAt : now,
    updatedAt: typeof value.updatedAt === "string" ? value.updatedAt : now
  };

  if (source) {
    normalized.source = source;
  }

  return normalized;
}

function normalizeSource(value) {
  if (!value || typeof value !== "object") {
    return undefined;
  }

  if (value.type !== "file" || typeof value.uri !== "string" || value.uri.trim().length === 0) {
    return undefined;
  }

  const uri = parseExternalUri(value.uri);
  if (uri && !isSupportedExternalUri(uri)) {
    return undefined;
  }

  return uri ? { type: "file", uri: uri.toString() } : undefined;
}

function nextUntitledTitle(notes, scope) {
  const prefix = scope === WORKSPACE_SCOPE ? "Project note" : "Global note";
  const existing = new Set(notes.map((note) => note.title));
  let index = notes.length + 1;
  let title = `${prefix} ${index}`;

  while (existing.has(title)) {
    index += 1;
    title = `${prefix} ${index}`;
  }

  return title;
}

function displayTitle(note) {
  return note.title.trim() || "Untitled note";
}

function titleFromUri(uri) {
  if (uri.scheme === "file") {
    return path.basename(uri.fsPath) || "File note";
  }

  const segments = uri.path.split("/").filter(Boolean);
  return segments[segments.length - 1] || uri.authority || "File note";
}

function sourceLabel(uri) {
  return uri.scheme === "file" ? uri.fsPath : uri.toString();
}

function uniqueExternalUris(uris) {
  const seen = new Set();
  const unique = [];

  for (const uri of uris) {
    if (!uri) {
      continue;
    }

    const key = uri.toString();
    if (!seen.has(key)) {
      seen.add(key);
      unique.push(uri);
    }
  }

  return unique;
}

function activeEditorResourceUris() {
  const uris = [];
  const activeDocumentUri = vscode.window.activeTextEditor && vscode.window.activeTextEditor.document
    ? vscode.window.activeTextEditor.document.uri
    : undefined;

  if (activeDocumentUri) {
    uris.push(activeDocumentUri);
  }

  const activeTab = vscode.window.tabGroups && vscode.window.tabGroups.activeTabGroup
    ? vscode.window.tabGroups.activeTabGroup.activeTab
    : undefined;
  const tabUri = activeTab && activeTab.input && activeTab.input.uri;
  if (tabUri) {
    uris.push(tabUri);
  }

  return uniqueExternalUris(uris).filter(isSupportedExternalUri);
}

function isSupportedExternalUri(uri) {
  return Boolean(uri && (uri.scheme === "file" || uri.scheme === "vscode-remote"));
}

function isFileBacked(note) {
  return Boolean(note && note.source && note.source.type === "file" && typeof note.source.uri === "string");
}

async function readExternalContent(note) {
  const uri = vscode.Uri.parse(note.source.uri);
  const bytes = await vscode.workspace.fs.readFile(uri);
  return Buffer.from(bytes).toString("utf8");
}

async function writeExternalContent(note, content) {
  const uri = vscode.Uri.parse(note.source.uri);
  await vscode.workspace.fs.writeFile(uri, Buffer.from(content, "utf8"));
}

function parseExternalUri(value) {
  if (typeof value !== "string") {
    return undefined;
  }

  const trimmed = stripUriListComment(value.trim());
  if (!trimmed) {
    return undefined;
  }

  const candidates = uriCandidates(trimmed);
  for (const candidate of candidates) {
    if (/^[a-zA-Z]:[\\/]/.test(candidate) || candidate.startsWith("\\\\")) {
      return vscode.Uri.file(candidate);
    }

    if (path.isAbsolute(candidate)) {
      return vscode.Uri.file(candidate);
    }

    try {
      const parsed = vscode.Uri.parse(candidate, true);
      if (parsed.scheme) {
        return parsed;
      }
    } catch (error) {
      // Keep trying broader candidates.
    }
  }

  return undefined;
}

function stripUriListComment(value) {
  return value.startsWith("#") ? "" : value;
}

function uriCandidates(value) {
  const candidates = new Set([value]);

  try {
    candidates.add(decodeURIComponent(value));
  } catch (error) {
    // The original value is still usable.
  }

  const fileLineColumn = value.match(/^([a-zA-Z]:[\\/].*?)(?::\d+)?(?::\d+)?$/);
  if (fileLineColumn) {
    candidates.add(fileLineColumn[1]);
  }

  const fileUriLineColumn = value.match(/^((?:file|vscode-remote):\/\/.*?)(?::\d+)?(?::\d+)?$/);
  if (fileUriLineColumn) {
    candidates.add(fileUriLineColumn[1]);
  }

  return Array.from(candidates);
}

function noteKey(scope, id) {
  return `${scope}:${id}`;
}

function parseNoteKey(value) {
  if (typeof value !== "string") {
    return undefined;
  }

  const separator = value.indexOf(":");
  if (separator === -1) {
    return undefined;
  }

  const scope = value.slice(0, separator);
  const id = value.slice(separator + 1);
  return isKnownScope(scope) && id ? { scope, id } : undefined;
}

function isKnownScope(scope) {
  return scope === GLOBAL_SCOPE || scope === WORKSPACE_SCOPE;
}

function isNotFound(error) {
  const message = error instanceof Error ? error.message : String(error);
  return error && (error.code === "FileNotFound" || message.includes("FileNotFound") || message.includes("ENOENT"));
}

function createId() {
  if (typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }

  return crypto.randomBytes(16).toString("hex");
}

function createNonce() {
  return crypto.randomBytes(16).toString("base64");
}

module.exports = {
  activate,
  deactivate
};
