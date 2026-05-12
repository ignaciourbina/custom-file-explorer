import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { spawn } from 'child_process';

class FileNode extends vscode.TreeItem {
  constructor(
    public readonly uri: vscode.Uri,
    public readonly isDirectory: boolean,
    label?: string
  ) {
    super(
      label ?? path.basename(uri.fsPath),
      isDirectory
        ? vscode.TreeItemCollapsibleState.Collapsed
        : vscode.TreeItemCollapsibleState.None
    );

    this.resourceUri = uri;
    this.tooltip = uri.fsPath;
    this.contextValue = isDirectory ? 'folder' : 'file';

    if (!isDirectory) {
      this.command = {
        command: 'customFileExplorer.openFile',
        title: 'Open File',
        arguments: [this]
      };
    }
  }
}

class FilePairProvider implements vscode.TreeDataProvider<FileNode> {
  private _onDidChange = new vscode.EventEmitter<FileNode | undefined | void>();
  readonly onDidChangeTreeData = this._onDidChange.event;

  constructor(private workspaceRoots: readonly vscode.WorkspaceFolder[] | undefined) {}

  refresh(roots?: readonly vscode.WorkspaceFolder[]): void {
    if (roots) {
      this.workspaceRoots = roots;
    }
    this._onDidChange.fire();
  }

  getTreeItem(element: FileNode): vscode.TreeItem {
    return element;
  }

  async getChildren(element?: FileNode): Promise<FileNode[]> {
    if (!element) {
      const roots = this.workspaceRoots ?? [];
      if (roots.length === 0) {
        return [];
      }
      if (roots.length === 1) {
        return this.readDir(roots[0].uri);
      }
      return roots.map(r => new FileNode(r.uri, true, r.name));
    }
    if (!element.isDirectory) {
      return [];
    }
    return this.readDir(element.uri);
  }

  private async readDir(uri: vscode.Uri): Promise<FileNode[]> {
    const config = vscode.workspace.getConfiguration('customFileExplorer');
    const showHidden = config.get<boolean>('showHidden', false);
    const exclude = new Set(config.get<string[]>('excludeGlobs', []));

    let entries: [string, vscode.FileType][];
    try {
      entries = await vscode.workspace.fs.readDirectory(uri);
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
      .map(([name, type]) => {
        const childUri = vscode.Uri.joinPath(uri, name);
        const isDir = (type & vscode.FileType.Directory) !== 0;
        return new FileNode(childUri, isDir);
      });
  }
}

function openPathInNewWindow(targetPath: string, isDirectory: boolean): Thenable<unknown> {
  const uri = vscode.Uri.file(targetPath);

  if (isDirectory) {
    return vscode.commands.executeCommand('vscode.openFolder', uri, {
      forceNewWindow: true
    });
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

export function activate(context: vscode.ExtensionContext): void {
  const provider = new FilePairProvider(vscode.workspace.workspaceFolders);

  const treeView = vscode.window.createTreeView('customFileExplorer.tree', {
    treeDataProvider: provider,
    showCollapseAll: true,
    canSelectMany: false
  });

  context.subscriptions.push(treeView);

  context.subscriptions.push(
    vscode.workspace.onDidChangeWorkspaceFolders(() => {
      provider.refresh(vscode.workspace.workspaceFolders);
    })
  );

  const watcher = vscode.workspace.createFileSystemWatcher('**/*');
  watcher.onDidCreate(() => provider.refresh());
  watcher.onDidDelete(() => provider.refresh());
  watcher.onDidChange(() => provider.refresh());
  context.subscriptions.push(watcher);

  context.subscriptions.push(
    vscode.commands.registerCommand('customFileExplorer.refresh', () => provider.refresh())
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('customFileExplorer.openFile', async (node: FileNode) => {
      if (!node) return;
      const doc = await vscode.workspace.openTextDocument(node.uri);
      await vscode.window.showTextDocument(doc, { preview: true });
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('customFileExplorer.openInNewWindow', async (node: FileNode) => {
      if (!node) return;
      let isDir = node.isDirectory;
      try {
        const stat = fs.statSync(node.uri.fsPath);
        isDir = stat.isDirectory();
      } catch {
        /* noop */
      }
      await openPathInNewWindow(node.uri.fsPath, isDir);
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('customFileExplorer.revealInExplorer', async (node: FileNode) => {
      if (!node) return;
      await vscode.commands.executeCommand('revealInExplorer', node.uri);
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('customFileExplorer.revealInOS', async (node: FileNode) => {
      if (!node) return;
      await vscode.commands.executeCommand('revealFileInOS', node.uri);
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('customFileExplorer.copyPath', async (node: FileNode) => {
      if (!node) return;
      await vscode.env.clipboard.writeText(node.uri.fsPath);
      vscode.window.setStatusBarMessage(`Copied: ${node.uri.fsPath}`, 2000);
    })
  );
}

export function deactivate(): void {
  /* noop */
}
