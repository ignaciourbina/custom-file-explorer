import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { spawn } from 'child_process';

interface DirEntry {
  name: string;
  isDirectory: boolean;
  fsPath: string;
}

async function readDir(dirPath: string): Promise<DirEntry[]> {
  const config = vscode.workspace.getConfiguration('customFileExplorer');
  const showHidden = config.get<boolean>('showHidden', false);
  const exclude = new Set(config.get<string[]>('excludeGlobs', []));

  let entries: [string, vscode.FileType][];
  try {
    entries = await vscode.workspace.fs.readDirectory(vscode.Uri.file(dirPath));
  } catch {
    return [];
  }

  return entries
    .filter(([name]) => showHidden || !name.startsWith('.'))
    .filter(([name]) => !exclude.has(name))
    .sort((a, b) => {
      const aDir = (a[1] & vscode.FileType.Directory) !== 0;
      const bDir = (b[1] & vscode.FileType.Directory) !== 0;
      if (aDir !== bDir) return aDir ? -1 : 1;
      return a[0].localeCompare(b[0]);
    })
    .map(([name, type]) => ({
      name,
      isDirectory: (type & vscode.FileType.Directory) !== 0,
      fsPath: path.join(dirPath, name)
    }));
}

function validateName(name: string): string | undefined {
  const trimmed = name.trim();
  if (!trimmed) return 'Name cannot be empty';
  if (trimmed.includes('/') || trimmed.includes('\\')) {
    return 'Name cannot contain path separators';
  }
  if (trimmed === '.' || trimmed === '..') return 'Invalid name';
  return undefined;
}

function targetDirPath(itemPath: string, isDirectory: boolean): string {
  return isDirectory ? itemPath : path.dirname(itemPath);
}

function openPathInNewWindow(targetPath: string, isDirectory: boolean): Thenable<unknown> {
  const uri = vscode.Uri.file(targetPath);

  if (isDirectory) {
    return vscode.commands.executeCommand('vscode.openFolder', uri, {
      forceNewWindow: true
    });
  }

  // Under a remote/tunnel context, `spawn('code', ...)` would run on the
  // remote machine and open a window there, invisible to the local client.
  // Fall back to opening the file's parent folder in a new window via the API.
  if (vscode.env.remoteName) {
    return vscode.commands.executeCommand(
      'vscode.openFolder',
      vscode.Uri.file(path.dirname(targetPath)),
      { forceNewWindow: true }
    );
  }

  return new Promise(resolve => {
    try {
      const child = spawn('code', ['--new-window', targetPath], {
        detached: true,
        stdio: 'ignore'
      });
      child.on('error', () => {
        vscode.commands
          .executeCommand('vscode.openFolder', vscode.Uri.file(path.dirname(targetPath)), {
            forceNewWindow: true
          })
          .then(() => resolve(undefined));
      });
      child.unref();
      resolve(undefined);
    } catch {
      vscode.commands
        .executeCommand('vscode.openFolder', vscode.Uri.file(path.dirname(targetPath)), {
          forceNewWindow: true
        })
        .then(() => resolve(undefined));
    }
  });
}

function getNonce(): string {
  let text = '';
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  for (let i = 0; i < 32; i++) {
    text += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return text;
}

class CustomFileExplorerPanel {
  public static currentPanel: CustomFileExplorerPanel | undefined;
  public static readonly viewType = 'customFileExplorer';

  private readonly _panel: vscode.WebviewPanel;
  private readonly _context: vscode.ExtensionContext;
  private readonly _disposables: vscode.Disposable[] = [];
  private _refreshTimer: NodeJS.Timeout | undefined;

  public static createOrShow(context: vscode.ExtensionContext): void {
    const column = vscode.window.activeTextEditor?.viewColumn ?? vscode.ViewColumn.One;

    if (CustomFileExplorerPanel.currentPanel) {
      CustomFileExplorerPanel.currentPanel._panel.reveal(column);
      return;
    }

    const panel = vscode.window.createWebviewPanel(
      CustomFileExplorerPanel.viewType,
      'Custom File Explorer',
      column,
      {
        enableScripts: true,
        retainContextWhenHidden: true
      }
    );

    panel.iconPath = vscode.Uri.joinPath(context.extensionUri, 'media', 'icon.svg');

    CustomFileExplorerPanel.currentPanel = new CustomFileExplorerPanel(panel, context);
  }

  private constructor(panel: vscode.WebviewPanel, context: vscode.ExtensionContext) {
    this._panel = panel;
    this._context = context;

    this._panel.webview.html = this._getHtml(this._panel.webview);

    this._panel.onDidDispose(() => this.dispose(), null, this._disposables);

    this._panel.webview.onDidReceiveMessage(
      (msg) => this._handleMessage(msg),
      null,
      this._disposables
    );

    const watcher = vscode.workspace.createFileSystemWatcher('**/*');
    const scheduleRefresh = (): void => {
      if (this._refreshTimer) clearTimeout(this._refreshTimer);
      this._refreshTimer = setTimeout(() => {
        this._refreshTimer = undefined;
        this._panel.webview.postMessage({ type: 'refresh' });
      }, 150);
    };
    watcher.onDidCreate(scheduleRefresh, null, this._disposables);
    watcher.onDidDelete(scheduleRefresh, null, this._disposables);
    watcher.onDidChange(scheduleRefresh, null, this._disposables);
    this._disposables.push(watcher);

    this._disposables.push(
      vscode.workspace.onDidChangeWorkspaceFolders(() => this._sendInit())
    );
  }

  private _sendInit(): void {
    const roots = (vscode.workspace.workspaceFolders ?? []).map(f => ({
      name: f.name,
      fsPath: f.uri.fsPath
    }));
    this._panel.webview.postMessage({ type: 'init', roots });
  }

  private async _handleMessage(msg: { type: string; [k: string]: unknown }): Promise<void> {
    switch (msg.type) {
      case 'ready':
        this._sendInit();
        break;
      case 'loadDir': {
        const p = msg.path as string;
        const entries = await readDir(p);
        this._panel.webview.postMessage({ type: 'dir', path: p, entries });
        break;
      }
      case 'openFile':
        await vscode.commands.executeCommand(
          'vscode.open',
          vscode.Uri.file(msg.path as string),
          { preview: false }
        );
        break;
      case 'openInNewWindow': {
        const p = msg.path as string;
        let isDir = Boolean(msg.isDirectory);
        try {
          isDir = fs.statSync(p).isDirectory();
        } catch {
          /* noop */
        }
        await openPathInNewWindow(p, isDir);
        break;
      }
      case 'revealInExplorer':
        await vscode.commands.executeCommand(
          'revealInExplorer',
          vscode.Uri.file(msg.path as string)
        );
        break;
      case 'revealInOS':
        await vscode.commands.executeCommand(
          'revealFileInOS',
          vscode.Uri.file(msg.path as string)
        );
        break;
      case 'copyPath': {
        const p = msg.path as string;
        await vscode.env.clipboard.writeText(p);
        vscode.window.setStatusBarMessage(`Copied: ${p}`, 2000);
        break;
      }
      case 'newFile':
        await this._newFile(msg.path as string, Boolean(msg.isDirectory));
        break;
      case 'newFolder':
        await this._newFolder(msg.path as string, Boolean(msg.isDirectory));
        break;
      case 'rename':
        await this._rename(msg.path as string);
        break;
      case 'delete':
        await this._delete(msg.path as string);
        break;
    }
  }

  private async _newFile(itemPath: string, isDirectory: boolean): Promise<void> {
    const dir = targetDirPath(itemPath, isDirectory);
    const name = await vscode.window.showInputBox({
      prompt: 'New file name',
      validateInput: validateName
    });
    if (!name) return;
    const newUri = vscode.Uri.file(path.join(dir, name.trim()));
    try {
      await vscode.workspace.fs.writeFile(newUri, new Uint8Array());
      await vscode.commands.executeCommand('vscode.open', newUri, { preview: false });
    } catch (e) {
      vscode.window.showErrorMessage(
        `Failed to create file: ${e instanceof Error ? e.message : String(e)}`
      );
    }
  }

  private async _newFolder(itemPath: string, isDirectory: boolean): Promise<void> {
    const dir = targetDirPath(itemPath, isDirectory);
    const name = await vscode.window.showInputBox({
      prompt: 'New folder name',
      validateInput: validateName
    });
    if (!name) return;
    try {
      await vscode.workspace.fs.createDirectory(
        vscode.Uri.file(path.join(dir, name.trim()))
      );
    } catch (e) {
      vscode.window.showErrorMessage(
        `Failed to create folder: ${e instanceof Error ? e.message : String(e)}`
      );
    }
  }

  private async _rename(itemPath: string): Promise<void> {
    const oldName = path.basename(itemPath);
    const ext = path.extname(oldName);
    const newName = await vscode.window.showInputBox({
      prompt: 'New name',
      value: oldName,
      valueSelection: [0, oldName.length - ext.length],
      validateInput: validateName
    });
    if (!newName || newName.trim() === oldName) return;
    const newUri = vscode.Uri.file(path.join(path.dirname(itemPath), newName.trim()));
    try {
      await vscode.workspace.fs.rename(vscode.Uri.file(itemPath), newUri, { overwrite: false });
    } catch (e) {
      vscode.window.showErrorMessage(
        `Failed to rename: ${e instanceof Error ? e.message : String(e)}`
      );
    }
  }

  private async _delete(itemPath: string): Promise<void> {
    const name = path.basename(itemPath);
    const choice = await vscode.window.showWarningMessage(
      `Move "${name}" to trash?`,
      { modal: true },
      'Move to Trash'
    );
    if (choice !== 'Move to Trash') return;
    try {
      await vscode.workspace.fs.delete(vscode.Uri.file(itemPath), {
        recursive: true,
        useTrash: true
      });
    } catch (e) {
      vscode.window.showErrorMessage(
        `Failed to delete: ${e instanceof Error ? e.message : String(e)}`
      );
    }
  }

  public dispose(): void {
    CustomFileExplorerPanel.currentPanel = undefined;
    if (this._refreshTimer) {
      clearTimeout(this._refreshTimer);
      this._refreshTimer = undefined;
    }
    this._panel.dispose();
    while (this._disposables.length) {
      const x = this._disposables.pop();
      if (x) x.dispose();
    }
  }

  private _getHtml(webview: vscode.Webview): string {
    const nonce = getNonce();
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';">
  <title>Custom File Explorer</title>
  <style>
    body { font-family: var(--vscode-font-family); font-size: var(--vscode-font-size); color: var(--vscode-foreground); background: var(--vscode-editor-background); margin: 0; padding: 0; user-select: none; }
    #header { display: flex; align-items: center; justify-content: space-between; padding: 4px 8px; border-bottom: 1px solid var(--vscode-editorWidget-border); position: sticky; top: 0; background: var(--vscode-editor-background); z-index: 10; }
    #header .title { font-weight: 600; }
    #header button { background: transparent; color: var(--vscode-foreground); border: none; cursor: pointer; padding: 2px 6px; font-size: 14px; }
    #header button:hover { background: var(--vscode-toolbar-hoverBackground); }
    #tree { padding: 4px 0; }
    .node { display: flex; align-items: center; padding: 2px 8px; cursor: pointer; white-space: nowrap; }
    .node:hover { background: var(--vscode-list-hoverBackground); }
    .twisty { display: inline-block; width: 14px; text-align: center; font-size: 9px; opacity: 0.7; }
    .twisty.placeholder { visibility: hidden; }
    .icon { display: inline-block; width: 18px; margin: 0 2px 0 2px; text-align: center; opacity: 0.85; }
    .label { padding-left: 2px; }
    #context-menu { position: absolute; background: var(--vscode-menu-background); color: var(--vscode-menu-foreground); border: 1px solid var(--vscode-menu-border, var(--vscode-editorWidget-border)); padding: 4px 0; z-index: 1000; box-shadow: 0 2px 8px rgba(0,0,0,0.3); min-width: 220px; }
    #context-menu[hidden] { display: none; }
    #context-menu .item { padding: 4px 16px; cursor: pointer; }
    #context-menu .item:hover { background: var(--vscode-menu-selectionBackground); color: var(--vscode-menu-selectionForeground); }
    #context-menu .sep { height: 1px; background: var(--vscode-menu-separatorBackground, var(--vscode-editorWidget-border)); margin: 4px 0; }
    #empty { padding: 16px; color: var(--vscode-descriptionForeground); font-style: italic; }
  </style>
</head>
<body>
  <div id="header">
    <span class="title">Custom File Explorer</span>
    <button id="refresh-btn" title="Refresh">&#x21bb;</button>
  </div>
  <div id="tree"><div id="empty">No workspace open.</div></div>
  <div id="context-menu" hidden></div>
  <script nonce="${nonce}">
  (function() {
    const vscode = acquireVsCodeApi();
    const treeEl = document.getElementById('tree');
    const ctxEl = document.getElementById('context-menu');
    let roots = [];

    function makeNode(name, fsPath, isDirectory) {
      return { name, fsPath, isDirectory, expanded: false, children: null };
    }

    function findNode(targetPath, list) {
      list = list || roots;
      for (const n of list) {
        if (n.fsPath === targetPath) return n;
        if (n.children) {
          const found = findNode(targetPath, n.children);
          if (found) return found;
        }
      }
      return null;
    }

    function loadedPaths(list, acc) {
      list = list || roots;
      acc = acc || [];
      for (const n of list) {
        if (n.expanded && n.children !== null) {
          acc.push(n.fsPath);
          loadedPaths(n.children, acc);
        }
      }
      return acc;
    }

    function render() {
      if (roots.length === 0) {
        treeEl.innerHTML = '<div id="empty">No workspace open.</div>';
        return;
      }
      treeEl.textContent = '';
      for (const r of roots) treeEl.appendChild(renderNode(r, 0));
    }

    function renderNode(node, depth) {
      const wrap = document.createElement('div');
      const row = document.createElement('div');
      row.className = 'node';
      row.style.paddingLeft = (8 + depth * 12) + 'px';
      row.dataset.path = node.fsPath;

      const tw = document.createElement('span');
      tw.className = 'twisty';
      if (node.isDirectory) {
        tw.textContent = node.expanded ? '▾' : '▸';
      } else {
        tw.classList.add('placeholder');
      }
      row.appendChild(tw);

      const ic = document.createElement('span');
      ic.className = 'icon';
      ic.textContent = node.isDirectory ? '\u{1F4C1}' : '\u{1F4C4}';
      row.appendChild(ic);

      const lbl = document.createElement('span');
      lbl.className = 'label';
      lbl.textContent = node.name;
      row.appendChild(lbl);

      row.addEventListener('click', (e) => {
        e.stopPropagation();
        hideContextMenu();
        if (node.isDirectory) {
          if (node.expanded) {
            node.expanded = false;
            render();
          } else {
            node.expanded = true;
            if (node.children === null) {
              vscode.postMessage({ type: 'loadDir', path: node.fsPath });
            }
            render();
          }
        } else {
          vscode.postMessage({ type: 'openFile', path: node.fsPath });
        }
      });

      row.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        e.stopPropagation();
        showContextMenu(e.clientX, e.clientY, node);
      });

      wrap.appendChild(row);
      if (node.isDirectory && node.expanded && node.children) {
        for (const c of node.children) wrap.appendChild(renderNode(c, depth + 1));
      }
      return wrap;
    }

    function showContextMenu(x, y, node) {
      ctxEl.textContent = '';
      const items = [
        { label: 'New File', action: 'newFile' },
        { label: 'New Folder', action: 'newFolder' },
        { sep: true },
        { label: 'Open in New Window', action: 'openInNewWindow' },
        { label: 'Reveal in Built-in Explorer', action: 'revealInExplorer' },
        { label: 'Reveal in File Manager', action: 'revealInOS' },
        { sep: true },
        { label: 'Rename', action: 'rename' },
        { label: 'Delete', action: 'delete' },
        { sep: true },
        { label: 'Copy Path', action: 'copyPath' }
      ];
      for (const it of items) {
        if (it.sep) {
          const s = document.createElement('div');
          s.className = 'sep';
          ctxEl.appendChild(s);
        } else {
          const m = document.createElement('div');
          m.className = 'item';
          m.textContent = it.label;
          m.addEventListener('click', (e) => {
            e.stopPropagation();
            hideContextMenu();
            vscode.postMessage({
              type: it.action,
              path: node.fsPath,
              isDirectory: node.isDirectory
            });
          });
          ctxEl.appendChild(m);
        }
      }
      // Position, clamping to viewport
      ctxEl.hidden = false;
      const maxX = window.innerWidth - ctxEl.offsetWidth - 4;
      const maxY = window.innerHeight - ctxEl.offsetHeight - 4;
      ctxEl.style.left = Math.min(x, maxX) + 'px';
      ctxEl.style.top = Math.min(y, maxY) + 'px';
    }

    function hideContextMenu() { ctxEl.hidden = true; }

    document.addEventListener('click', hideContextMenu);
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') hideContextMenu(); });
    ctxEl.addEventListener('contextmenu', (e) => e.preventDefault());

    document.getElementById('refresh-btn').addEventListener('click', () => {
      const paths = loadedPaths();
      for (const p of paths) vscode.postMessage({ type: 'loadDir', path: p });
    });

    window.addEventListener('message', (event) => {
      const msg = event.data;
      switch (msg.type) {
        case 'init':
          roots = (msg.roots || []).map(r => {
            const n = makeNode(r.name, r.fsPath, true);
            n.expanded = true;
            vscode.postMessage({ type: 'loadDir', path: r.fsPath });
            return n;
          });
          render();
          break;
        case 'dir': {
          const node = findNode(msg.path);
          if (node) {
            node.children = (msg.entries || []).map(e => makeNode(e.name, e.fsPath, e.isDirectory));
            render();
          }
          break;
        }
        case 'refresh': {
          const paths = loadedPaths();
          for (const p of paths) vscode.postMessage({ type: 'loadDir', path: p });
          break;
        }
      }
    });

    vscode.postMessage({ type: 'ready' });
  })();
  </script>
</body>
</html>`;
  }
}

export function activate(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    vscode.commands.registerCommand('customFileExplorer.open', () => {
      CustomFileExplorerPanel.createOrShow(context);
    })
  );
}

export function deactivate(): void {
  if (CustomFileExplorerPanel.currentPanel) {
    CustomFileExplorerPanel.currentPanel.dispose();
  }
}
