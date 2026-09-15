/**
 * `vscode` 模块的最小桩实现。
 * 只用于让 Node 直接加载插件源码做语法检查（tools/check.mjs），
 * 不参与任何实际运行，也不影响 VSCode 里的真实构建。
 */

class Disposable {
  dispose() {}
}

class EventEmitter {
  constructor() {
    this.event = () => new Disposable();
  }
  fire() {}
  dispose() {}
}

class TreeItem {
  constructor(label, collapsibleState) {
    this.label = label;
    this.collapsibleState = collapsibleState;
  }
}

class ThemeIcon {
  constructor(id, color) {
    this.id = id;
    this.color = color;
  }
}

class ThemeColor {
  constructor(id) {
    this.id = id;
  }
}

class MarkdownString {
  constructor(value = '') {
    this.value = value;
    this.supportHtml = false;
  }
  appendMarkdown() {
    return this;
  }
}

class Position {
  constructor(line, character) {
    this.line = line;
    this.character = character;
  }
}

class Range {
  constructor(start, end) {
    this.start = start;
    this.end = end;
  }
}

class Selection extends Range {}

class Uri {
  constructor(p) {
    this.fsPath = p;
    this.scheme = 'file';
    this.path = p;
  }
  static file(p) {
    return new Uri(p);
  }
  toString() {
    return `file://${this.fsPath}`;
  }
}

export {
  Disposable,
  EventEmitter,
  TreeItem,
  ThemeIcon,
  ThemeColor,
  MarkdownString,
  Position,
  Range,
  Selection,
  Uri,
};

export const TreeItemCollapsibleState = { None: 0, Collapsed: 1, Expanded: 2 };
export const StatusBarAlignment = { Left: 1, Right: 2 };
export const ProgressLocation = { SourceControl: 1, Window: 10, Notification: 15 };
export const ViewColumn = { Active: -1, Beside: -2, One: 1, Two: 2 };
export const TextEditorRevealType = { Default: 0, InCenter: 1, InCenterIfOutsideViewport: 2, AtTop: 3 };

const noopConfig = {
  get: (_key, fallback) => fallback,
  update: async () => {},
  has: () => false,
};

export const workspace = {
  getConfiguration: () => noopConfig,
  findFiles: async () => [],
  textDocuments: [],
  workspaceFolders: [],
  onDidSaveTextDocument: () => new Disposable(),
  onDidChangeConfiguration: () => new Disposable(),
  openTextDocument: async () => ({ getText: () => '', positionAt: () => new Position(0, 0) }),
  fs: {
    readFile: async () => new Uint8Array(),
    writeFile: async () => {},
    stat: async () => ({}),
  },
};

export const window = {
  activeTextEditor: undefined,
  createStatusBarItem: () => ({ show() {}, hide() {}, dispose() {} }),
  createTreeView: () => ({ dispose() {} }),
  showInformationMessage: async () => undefined,
  showWarningMessage: async () => undefined,
  showErrorMessage: async () => undefined,
  showQuickPick: async () => undefined,
  showInputBox: async () => undefined,
  showSaveDialog: async () => undefined,
  showTextDocument: async () => ({ selection: null, revealRange() {} }),
  setStatusBarMessage: () => new Disposable(),
  withProgress: async (_opts, cb) => cb({ report() {} }),
};

export const commands = {
  registerCommand: () => new Disposable(),
  executeCommand: async () => undefined,
};

export const env = {
  clipboard: { writeText: async () => {} },
};

export const languages = {
  createDiagnosticCollection: () => ({ set() {}, delete() {}, dispose() {} }),
};
