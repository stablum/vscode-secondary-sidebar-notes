# Changelog

## 0.1.11

- Removed the extra outer note box in compact layout so each compact note appears as a single editable box.
- Added a native `Drop Files` view that accepts VS Code Explorer and editor-tab drops for file-backed notes.

## 0.1.10

- Added a separate compact layout toggle so multiple notes can be shown stacked with titles and metadata hidden.
- Made file drops more tolerant of VS Code drag payloads and added an active-editor fallback for stripped editor-tab drops.

## 0.1.9

- Hid note titles and metadata in current-note-only mode.
- Replaced the compact tab strip with richer stacked note panels in expanded mode.
- Added live file-backed notes that read from and write to external source files.
- Added file drag-and-drop support for creating file-backed notes from VS Code editor tabs and the Explorer.

## 0.1.8

- Replaced the note textarea with a plaintext editable surface that fills the content grid row.

## 0.1.7

- Reworked the note editor layout to fill the webview viewport without height measurement.

## 0.1.6

- Fixed collapsed note editor height in VS Code webviews.

## 0.1.5

- Expanded the note editor layout so the content area uses the available vertical space.

## 0.1.4

- Moved the current-note toggle to the native VS Code view title toolbar.

## 0.1.3

- Moved note controls into compact icon buttons beside the tab strip.

## 0.1.2

- Added a current-note-only toggle to reduce sidebar clutter.

## 0.1.1

- Added the GNU GPLv3 license.
- Added installation instructions.

## 0.1.0

- Initial extension implementation.
- Added sidebar note tabs with direct in-view editing.
- Added project and global note scopes backed by VS Code storage JSON files.
- Added backup-aware persistence and storage reveal commands.
