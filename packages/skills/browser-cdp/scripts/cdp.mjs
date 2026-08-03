#!/usr/bin/env node
/**
 * Small, dependency-free local Chrome DevTools Protocol helper.
 * It intentionally uses an isolated profile and loopback-only debugging.
 */
import { execFileSync, spawn } from 'node:child_process';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, resolve } from 'node:path';

const STATE_DIR = resolve(tmpdir(), 'pi-browser-cdp');
const STATE_FILE = resolve(STATE_DIR, 'state.json');
const DEFAULT_PORT = 9222;

function usage(message) {
  if (message) console.error(`Error: ${message}\n`);
  console.error(`Usage: node cdp.mjs <command> [options]

Commands:
  open       --url <url> [--allow-remote] [--port 9222] [--width 1440] [--height 900] [--chrome <path>]
  navigate   --url <url> [--allow-remote] [--port 9222] [--target <url-substring>]
  status     [--port 9222] [--target <url-substring>]
  eval       --expr <javascript> [--port 9222] [--target <url-substring>]
  click      --selector <css-selector> [--port 9222] [--target <url-substring>]
  key        --key <key-name> [--port 9222] [--target <url-substring>]
  dom        [--selector <css-selector>] [--port 9222] [--target <url-substring>]
  screenshot --path <png-path> [--width 1440] [--height 900] [--port 9222] [--target <url-substring>]
  close      [--port 9222]

Use --allow-remote only for an http(s) URL the user explicitly authorized.
The helper always launches Chrome with its CDP endpoint bound to 127.0.0.1.`);
  process.exitCode = 2;
}

function parseArgs(argv) {
  const [command, ...rest] = argv;
  const options = {};
  for (let index = 0; index < rest.length; index += 1) {
    const item = rest[index];
    if (!item.startsWith('--')) {
      usage(`Unexpected argument: ${item}`);
      return {};
    }
    const key = item.slice(2);
    if (key === 'allow-remote') {
      options[key] = true;
      continue;
    }
    if (key === 'help') {
      usage();
      return {};
    }
    const value = rest[index + 1];
    if (!value || value.startsWith('--')) {
      usage(`Missing value for --${key}`);
      return {};
    }
    options[key] = value;
    index += 1;
  }
  return { command, options };
}

function asPort(value) {
  const port = Number(value ?? DEFAULT_PORT);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Port must be an integer from 1 to 65535.');
  return port;
}

function asDimension(value, fallback, name) {
  const dimension = Number(value ?? fallback);
  if (!Number.isInteger(dimension) || dimension < 200 || dimension > 10000) throw new Error(`${name} must be an integer from 200 to 10000.`);
  return dimension;
}

function assertAllowedUrl(value, allowRemote = false) {
  let url;
  try { url = new URL(value); } catch { throw new Error(`Invalid URL: ${value}`); }
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Only http(s) URLs are supported.');
  const localHosts = new Set(['localhost', '127.0.0.1', '[::1]']);
  if (!localHosts.has(url.hostname) && !allowRemote) {
    throw new Error('Remote URLs require --allow-remote and explicit user authorization.');
  }
  return url.toString();
}

function findChrome(explicitPath) {
  if (explicitPath) return explicitPath;
  for (const name of ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser']) {
    try { return execFileSync('sh', ['-lc', `command -v ${name}`], { encoding: 'utf8' }).trim(); } catch { /* try next */ }
  }
  throw new Error('Could not find Google Chrome or Chromium. Pass --chrome <path>.');
}

async function fetchJson(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`CDP endpoint returned HTTP ${response.status}.`);
  return response.json();
}

async function waitForDebugger(port, timeoutMs = 7000) {
  const end = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < end) {
    try { return await fetchJson(`http://127.0.0.1:${port}/json/version`); } catch (error) { lastError = error; }
    await new Promise(resolveTimer => setTimeout(resolveTimer, 125));
  }
  throw new Error(`Chrome's debugger did not become ready on port ${port}: ${lastError?.message ?? 'unknown error'}`);
}

async function readState() {
  try { return JSON.parse(await readFile(STATE_FILE, 'utf8')); } catch { return undefined; }
}

async function writeState(state) {
  await mkdir(STATE_DIR, { recursive: true });
  await writeFile(STATE_FILE, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
}

async function listTargets(port) {
  const targets = await fetchJson(`http://127.0.0.1:${port}/json/list`);
  return targets.filter(target => target.type === 'page' && target.webSocketDebuggerUrl);
}

async function selectTarget(options) {
  const port = asPort(options.port);
  const targets = await listTargets(port);
  const requestedUrl = options.target;
  const target = requestedUrl ? targets.find(item => item.url.includes(requestedUrl)) : targets[0];
  if (!target) throw new Error(requestedUrl ? `No page target matches ${requestedUrl}.` : 'No inspectable page target found.');
  return { port, target };
}

class CdpClient {
  static async connect(url) {
    const socket = new WebSocket(url);
    await new Promise((resolveConnection, rejectConnection) => {
      socket.addEventListener('open', resolveConnection, { once: true });
      socket.addEventListener('error', () => rejectConnection(new Error('Unable to connect to Chrome via CDP.')), { once: true });
    });
    return new CdpClient(socket);
  }

  constructor(socket) {
    this.socket = socket;
    this.nextId = 0;
    this.pending = new Map();
    socket.addEventListener('message', ({ data }) => {
      const message = JSON.parse(data);
      const resolveMessage = this.pending.get(message.id);
      if (!resolveMessage) return;
      this.pending.delete(message.id);
      if (message.error) resolveMessage.reject(new Error(message.error.message));
      else resolveMessage.resolve(message.result);
    });
    socket.addEventListener('close', () => {
      for (const { reject } of this.pending.values()) reject(new Error('CDP connection closed.'));
      this.pending.clear();
    });
  }

  send(method, params = {}) {
    return new Promise((resolveMessage, rejectMessage) => {
      const id = ++this.nextId;
      this.pending.set(id, { resolve: resolveMessage, reject: rejectMessage });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }

  async evaluate(expression) {
    const result = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.text ?? 'Page evaluation failed.');
    return result.result.value;
  }

  close() { this.socket.close(); }
}

async function withPage(options, operation) {
  const { target } = await selectTarget(options);
  const client = await CdpClient.connect(target.webSocketDebuggerUrl);
  try { return await operation(client, target); } finally { client.close(); }
}

async function open(options) {
  if (!options.url) throw new Error('open requires --url.');
  const url = assertAllowedUrl(options.url, options['allow-remote'] === true);
  const port = asPort(options.port);
  const width = asDimension(options.width, 1440, 'Width');
  const height = asDimension(options.height, 900, 'Height');
  try {
    const existing = await listTargets(port);
    if (existing.length > 0) throw new Error(`A CDP target already exists on port ${port}. Use --port with another local port, or run close first.`);
  } catch (error) {
    if (error.message.includes('A CDP target')) throw error;
  }

  const chrome = findChrome(options.chrome);
  const profile = resolve(STATE_DIR, `profile-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  await mkdir(profile, { recursive: true });
  const child = spawn(chrome, [
    '--headless=new', '--no-first-run', '--no-default-browser-check', '--disable-gpu',
    '--remote-allow-origins=*', `--remote-debugging-port=${port}`, '--remote-debugging-address=127.0.0.1',
    `--user-data-dir=${profile}`, `--window-size=${width},${height}`, url,
  ], { detached: true, stdio: 'ignore' });
  child.unref();
  await waitForDebugger(port);
  await writeState({ pid: child.pid, port, profile, startedAt: new Date().toISOString() });
  const targets = await listTargets(port);
  const target = targets.find(item => item.url === url) ?? targets[0];
  console.log(JSON.stringify({ pid: child.pid, port, url: target?.url, targetId: target?.id }, null, 2));
}

async function screenshot(options) {
  if (!options.path) throw new Error('screenshot requires --path.');
  const outputPath = resolve(options.path);
  const width = asDimension(options.width, 1440, 'Width');
  const height = asDimension(options.height, 900, 'Height');
  await withPage(options, async client => {
    await client.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
    const image = await client.send('Page.captureScreenshot', { format: 'png' });
    await mkdir(dirname(outputPath), { recursive: true });
    await writeFile(outputPath, Buffer.from(image.data, 'base64'));
  });
  console.log(JSON.stringify({ path: outputPath, width, height }, null, 2));
}

async function removeTemporaryProfile(profile) {
  // Chrome's child processes can hold profile files briefly after SIGTERM.
  for (let attempt = 0; attempt < 12; attempt += 1) {
    try {
      await rm(profile, { recursive: true, force: true, maxRetries: 1, retryDelay: 100 });
      return;
    } catch (error) {
      if (attempt === 11) throw error;
      await new Promise(resolveTimer => setTimeout(resolveTimer, 150));
    }
  }
}

async function close(options) {
  const state = await readState();
  const port = asPort(options.port ?? state?.port);
  if (state?.pid) {
    try { process.kill(-state.pid, 'SIGTERM'); } catch { try { process.kill(state.pid, 'SIGTERM'); } catch { /* process already ended */ } }
  }
  if (state?.profile && isAbsolute(state.profile) && basename(dirname(state.profile)) === basename(STATE_DIR)) {
    await removeTemporaryProfile(state.profile);
  }
  if (existsSync(STATE_FILE)) await rm(STATE_FILE, { force: true });
  console.log(JSON.stringify({ closed: true, port }, null, 2));
}

async function main() {
  const { command, options } = parseArgs(process.argv.slice(2));
  if (!command || command === '--help' || command === 'help') return usage();
  if (command === 'open') return open(options);
  if (command === 'close') return close(options);
  if (command === 'navigate') {
    if (!options.url) throw new Error('navigate requires --url.');
    const url = assertAllowedUrl(options.url, options['allow-remote'] === true);
    const value = await withPage(options, async client => {
      const result = await client.send('Page.navigate', { url });
      return { navigated: url, frameId: result.frameId };
    });
    console.log(JSON.stringify(value, null, 2));
    return;
  }
  if (command === 'status') {
    const { port, target } = await selectTarget(options);
    console.log(JSON.stringify({ port, id: target.id, title: target.title, url: target.url }, null, 2));
    return;
  }
  if (command === 'eval') {
    if (!options.expr) throw new Error('eval requires --expr.');
    const value = await withPage(options, client => client.evaluate(options.expr));
    console.log(JSON.stringify(value, null, 2));
    return;
  }
  if (command === 'click') {
    if (!options.selector) throw new Error('click requires --selector.');
    const selector = JSON.stringify(options.selector);
    const value = await withPage(options, client => client.evaluate(`(() => { const element = document.querySelector(${selector}); if (!element) throw new Error('No element matches: ' + ${selector}); element.click(); return { tag: element.tagName, text: (element.innerText || element.textContent || '').trim().slice(0, 200) }; })()`));
    console.log(JSON.stringify(value, null, 2));
    return;
  }
  if (command === 'key') {
    if (!options.key) throw new Error('key requires --key.');
    const key = JSON.stringify(options.key);
    const value = await withPage(options, client => client.evaluate(`(() => { window.dispatchEvent(new KeyboardEvent('keydown', { key: ${key}, bubbles: true })); return { dispatched: ${key} }; })()`));
    console.log(JSON.stringify(value, null, 2));
    return;
  }
  if (command === 'dom') {
    const selector = JSON.stringify(options.selector ?? 'html');
    const value = await withPage(options, client => client.evaluate(`(() => { const element = document.querySelector(${selector}); if (!element) throw new Error('No element matches: ' + ${selector}); return element.outerHTML; })()`));
    console.log(value);
    return;
  }
  if (command === 'screenshot') return screenshot(options);
  usage(`Unknown command: ${command}`);
}

main().catch(error => { console.error(`CDP helper failed: ${error.message}`); process.exitCode = 1; });
