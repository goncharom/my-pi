// Small VS Code host double. Git operations in the tests use real temporary repositories.
const Module = require('node:module');
const path = require('node:path');
const { pathToFileURL, fileURLToPath } = require('node:url');

class Uri {
  constructor(scheme, uriPath, query = '') { Object.assign(this, { scheme, path: uriPath, query }); }
  static file(filePath) { return new Uri('file', new URL(pathToFileURL(path.resolve(filePath))).pathname); }
  static parse(value) {
    const url = new URL(value);
    return new Uri(url.protocol.slice(0, -1), url.pathname, decodeURIComponent(url.search.slice(1)));
  }
  static joinPath(base, ...parts) { return Uri.file(path.join(base.fsPath, ...parts)); }
  get fsPath() { return fileURLToPath(`file://${this.path}`); }
  with(change) { return new Uri(change.scheme ?? this.scheme, change.path ?? this.path, change.query ?? this.query); }
  toString() { return `${this.scheme}://${this.path}${this.query ? '?' + encodeURIComponent(this.query) : ''}`; }
}
class Range {
  constructor(startLine, startCharacter, endLine, endCharacter) {
    this.start = { line: startLine, character: startCharacter };
    this.end = { line: endLine, character: endCharacter };
    this.isEmpty = startLine === endLine && startCharacter === endCharacter;
  }
}
class TabInputText {
  constructor(uri) { this.uri = uri; }
}
const listeners = new Set();
const subscribe = (listener) => { listeners.add(listener); return { dispose() { listeners.delete(listener); } }; };
const state = { controllers: [], commands: new Map(), errors: [], notifications: [] };
const api = {
  Uri, Range, TabInputText,
  CommentMode: { Preview: 0 },
  CommentThreadCollapsibleState: { Collapsed: 0 },
  window: {
    activeTextEditor: undefined, visibleTextEditors: [],
    tabGroups: { activeTabGroup: { activeTab: undefined }, all: [], onDidChangeTabs: subscribe, onDidChangeTabGroups: subscribe },
    onDidChangeActiveTextEditor: subscribe,
    showErrorMessage(message) { state.errors.push(message); },
    showInformationMessage(message) { state.notifications.push(message); },
  },
  workspace: { workspaceFolders: [], openTextDocument() { throw new Error('No test document installed'); } },
  commands: { registerCommand(name, handler) { state.commands.set(name, handler); return { dispose() { state.commands.delete(name); } }; } },
  comments: {
    createCommentController() {
      const controller = {
        threads: [],
        createCommentThread(uri, range, comments) {
          const thread = { uri, range, comments, disposed: false, dispose() { this.disposed = true; } };
          this.threads.push(thread);
          return thread;
        },
        dispose() { for (const thread of this.threads) thread.dispose(); },
      };
      let provider;
      controller.rangeRefreshes = 0;
      Object.defineProperty(controller, 'commentingRangeProvider', {
        get() { return provider; },
        set(value) { provider = value; this.rangeRefreshes++; },
      });
      state.controllers.push(controller);
      return controller;
    },
  },
  __test: { state, fireEditorsChanged() { for (const listener of listeners) listener(); } },
};
const originalLoad = Module._load;
Module._load = function (request, ...args) { return request === 'vscode' ? api : originalLoad.call(this, request, ...args); };
