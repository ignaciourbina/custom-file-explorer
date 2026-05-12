# Custom File Explorer

A lightweight VS Code extension that adds a second file-explorer view, mirroring the workspace tree. The view lives in its own Activity Bar container so it can be dragged into a side panel or moved into a detached window (via VS Code's *Move View* / *Move into New Window* actions).

## Features

- A secondary tree view of the current workspace folder(s).
- Right-click any file or folder for:
  - **Open in New Window** — opens the target in a separate VS Code window.
  - **Reveal in Built-in Explorer**
  - **Reveal in File Manager**
  - **Copy Path**
- Honors `customFileExplorer.showHidden` and `customFileExplorer.excludeGlobs` settings.

## Build

```bash
npm install
npm run compile
```

Then press `F5` in VS Code to launch an Extension Development Host.

## Settings

| Setting | Default | Description |
| --- | --- | --- |
| `customFileExplorer.showHidden` | `false` | Show dotfiles in the tree. |
| `customFileExplorer.excludeGlobs` | `["node_modules", ".git", "out", "dist", ".DS_Store"]` | Names to hide from the tree. |
