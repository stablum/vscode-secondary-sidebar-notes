# Secondary Sidebar Notes

Secondary Sidebar Notes adds an editable Notes view for VS Code. It is built for the Secondary Sidebar workflow: open the Notes view, drag it to the Secondary Sidebar once, and VS Code will remember that layout for future sessions.

## Features

- Multiple note tabs inside the sidebar view.
- Notes can be scoped as project notes or global notes.
- Native view title icons provide note actions near the Notes view title.
- A current-note-only mode hides inactive tabs and secondary actions when you want a cleaner note surface.
- Project notes are stored in VS Code workspace storage.
- Global notes are stored in VS Code global extension storage.
- Note content is edited directly in the sidebar webview, not in editor tabs.
- Writes use JSON files plus backup files under VS Code-managed storage locations, so extension and VS Code upgrades do not overwrite note content.

## Usage

1. Run `Secondary Sidebar Notes: Focus Notes` from the Command Palette, or open the Notes activity view.
2. Drag the Notes view or its container into the Secondary Sidebar if you want it on the right-hand side.
3. Use `+ Project` for workspace-specific notes and `+ Global` for notes that follow you across projects.
4. Change a note between `Project` and `Global` with the scope selector next to the title.

VS Code's stable extension API does not currently let an extension force a view to be contributed directly into the Secondary Sidebar by default. VS Code does remember user-customized view locations after you move the view.

## Install

From a local checkout:

```powershell
git clone https://github.com/stablum/vscode-secondary-sidebar-notes.git
cd vscode-secondary-sidebar-notes
npm run check
npx @vscode/vsce package
code --install-extension .\secondary-sidebar-notes-0.1.4.vsix
```

You can also install the generated `.vsix` from VS Code with `Extensions: Install from VSIX...`.

For development, open this folder in VS Code and press `F5`, or run `Debug: Start Debugging`, to launch an Extension Development Host.

## Storage

Notes are saved outside the extension installation folder:

- Global notes: `${globalStorageUri}/notes.v1.json`
- Project notes: `${storageUri}/notes.v1.json`

Each storage location also maintains `notes.v1.json.bak`. The extension reads the backup if the primary JSON file cannot be parsed or opened.

Use `Secondary Sidebar Notes: Reveal Notes Storage` to open the storage file location.

## License

Secondary Sidebar Notes is licensed under GPLv3. See `LICENSE`.
