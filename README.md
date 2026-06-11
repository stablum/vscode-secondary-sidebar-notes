# Secondary Sidebar Notes

Secondary Sidebar Notes adds an editable Notes view for VS Code. It is built for the Secondary Sidebar workflow: open the Notes view, drag it to the Secondary Sidebar once, and VS Code will remember that layout for future sessions.

## Features

- Multiple notes inside the sidebar view, shown as stacked editable panels in expanded mode.
- Notes can be scoped as project notes or global notes.
- Notes can be backed by external files, with content read from and written to the source file instead of copied into extension storage.
- Files can be dragged from VS Code editor tabs or the Explorer into the native `Drop Files` view in detailed mode to add them as file-backed notes.
- Native view title icons provide note actions near the Notes view title.
- A compact layout hides note titles, metadata, and secondary actions while still allowing all notes to appear stacked vertically.
- A current-note-only mode can additionally hide inactive notes when you want a single full-height note surface.
- Project notes are stored in VS Code workspace storage.
- Global notes are stored in VS Code global extension storage.
- Note content is edited directly in the sidebar webview, with the editor filling the available vertical space.
- Writes use JSON files plus backup files under VS Code-managed storage locations, so extension and VS Code upgrades do not overwrite note content.

## Usage

1. Run `Secondary Sidebar Notes: Focus Notes` from the Command Palette, or open the Notes activity view.
2. Drag the Notes view or its container into the Secondary Sidebar if you want it on the right-hand side.
3. Use the view title icons to create project notes, global notes, or file-backed notes.
4. In detailed mode, expand the collapsed `Drop Files` view and drag a file from a VS Code editor tab or the Explorer onto it to add it as a live file-backed note.
5. Use `Hide Note Details` for compact stacked note bodies, and `Show Current Note Only` when you want just the active note.
6. Change a note between `Project` and `Global` with the scope selector next to the title.

VS Code's stable extension API does not currently let an extension force a view to be contributed directly into the Secondary Sidebar by default. VS Code does remember user-customized view locations after you move the view.

## Install

From a local checkout:

```powershell
git clone https://github.com/stablum/vscode-secondary-sidebar-notes.git
cd vscode-secondary-sidebar-notes
npm run check
npx @vscode/vsce package
code --install-extension .\secondary-sidebar-notes-0.1.12.vsix
```

You can also install the generated `.vsix` from VS Code with `Extensions: Install from VSIX...`.

For development, open this folder in VS Code and press `F5`, or run `Debug: Start Debugging`, to launch an Extension Development Host.

## Storage

Notes are saved outside the extension installation folder:

- Global notes: `${globalStorageUri}/notes.v1.json`
- Project notes: `${storageUri}/notes.v1.json`

Each storage location also maintains `notes.v1.json.bak`. The extension reads the backup if the primary JSON file cannot be parsed or opened.

File-backed notes store only a source-file URI and note metadata in these JSON files. Their visible content is read from the external file when the view refreshes, and edits in the sidebar are written back to that same file.

Use `Secondary Sidebar Notes: Reveal Notes Storage` to open the storage file location.

## License

Secondary Sidebar Notes is licensed under GPLv3. See `LICENSE`.
