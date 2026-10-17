const assert = require("node:assert/strict");
const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { dirname, join } = require("node:path");
const { before, test } = require("node:test");
let extension;
before(async () => {
  extension = (await import("../dist/index.js")).default;
});

const commit = "a".repeat(40);

function writePrompt(file, content) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, content);
}

function harness({ remote = "git@github.com:owner/repo.git", root = "/repo", code = 0, fail = false } = {}) {
  const handlers = new Map();
  const calls = [];
  extension({
    on: (event, handler) => handlers.set(event, handler),
    exec: async (command, args, options) => {
      calls.push({ command, args, options });
      if (fail) throw new Error("Git is not installed");
      return {
        code,
        stdout: args[0] === "remote" ? `${remote}\n` : `${root}\n${commit}\n`,
        stderr: "",
        killed: false,
      };
    },
  });
  return { handlers, calls };
}

async function start(t, { globalPrompt = "Global test instructions", projectPrompt, ...options } = {}) {
  const directory = mkdtempSync(join(tmpdir(), "pi-extra-prompts-"));
  const cwd = join(directory, "project");
  const agentDir = join(directory, "agent");
  const globalFile = join(agentDir, "extra-prompts.md");
  const projectFile = join(cwd, ".pi", "extra-prompts.md");
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  t.after(() => {
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    rmSync(directory, { recursive: true, force: true });
  });
  mkdirSync(cwd, { recursive: true });
  if (globalPrompt !== null) writePrompt(globalFile, globalPrompt);
  if (projectPrompt !== undefined) writePrompt(projectFile, projectPrompt);
  const instance = harness(options);
  await instance.handlers.get("session_start")({}, { cwd });
  return { ...instance, cwd, globalFile, projectFile };
}

function request(instance, messages = []) {
  return instance.handlers.get("context")({ messages })?.messages ?? messages;
}

test("injects one hidden instruction on every request without changing history", async (t) => {
  const instance = await start(t);
  const user = Object.freeze({ role: "user", content: "Explain auth", timestamp: 1 });
  const history = Object.freeze([user]);
  for (let i = 0; i < 3; i++) {
    const messages = request(instance, history);
    assert.equal(messages.length, 2);
    assert.equal(messages[0], user);
    assert.equal(messages[1].role, "custom");
    assert.equal(messages[1].customType, "extra-prompts");
    assert.equal(messages[1].display, false);
    assert.match(messages[1].content, /Global test instructions/);
    assert.match(messages[1].content, new RegExp(`https://github.com/owner/repo/blob/${commit}/`));
  }
  assert.equal(history.length, 1);
  assert.equal(instance.calls.length, 2, "no Git calls during model requests");
  assert.ok(instance.calls.every((call) => call.command === "git" && call.options.cwd === instance.cwd));
});

test("also injects after tool results and after compaction", async (t) => {
  const instance = await start(t);
  const toolResult = { role: "toolResult", toolCallId: "1", toolName: "read", content: [], timestamp: 2 };
  assert.equal(request(instance, [toolResult]).at(-1).customType, "extra-prompts");
  const summary = { role: "compactionSummary", summary: "Earlier conversation", timestamp: 3 };
  assert.equal(request(instance, [summary]).at(-1).customType, "extra-prompts");
  assert.equal(instance.calls.length, 2);
});

test("combines global then project Markdown files, honoring the agent-directory override", async (t) => {
  const instance = await start(t, { projectPrompt: "Project test instructions" });
  const content = request(instance).at(-1).content;
  assert.ok(content.indexOf("Global test instructions") < content.indexOf("Project test instructions"));
  assert.doesNotMatch(content, /GitHub source references/, "no bundled prompts");
});

test("loads project instructions without a global file", async (t) => {
  const instance = await start(t, { globalPrompt: null, projectPrompt: "Project-only instructions" });
  assert.match(request(instance).at(-1).content, /Project-only instructions/);
  assert.doesNotMatch(request(instance).at(-1).content, /Global test instructions/);
});

test("inherits parent project files when running in a subdirectory, outermost first", async (t) => {
  const instance = await start(t, { projectPrompt: "Parent project instructions" });
  const cwd = join(instance.cwd, "packages", "child");
  writePrompt(join(cwd, ".pi", "extra-prompts.md"), "Child project instructions");
  await instance.handlers.get("session_start")({}, { cwd });
  const content = request(instance).at(-1).content;
  assert.ok(content.indexOf("Global test instructions") < content.indexOf("Parent project instructions"));
  assert.ok(content.indexOf("Parent project instructions") < content.indexOf("Child project instructions"));
});

test("refreshes edited files on session start, not on each request", async (t) => {
  const instance = await start(t, { projectPrompt: "Old project instructions" });
  writeFileSync(instance.globalFile, "Updated global instructions");
  writeFileSync(instance.projectFile, "Updated project instructions");
  assert.match(request(instance).at(-1).content, /Old project instructions/);
  assert.doesNotMatch(request(instance).at(-1).content, /Updated global instructions/);
  await instance.handlers.get("session_start")({}, { cwd: instance.cwd });
  const content = request(instance).at(-1).content;
  assert.match(content, /Updated global instructions/);
  assert.match(content, /Updated project instructions/);
  assert.doesNotMatch(content, /Old project instructions|Global test instructions/);
});

for (const globalPrompt of [null, "  \n"]) {
  test(`does nothing when prompt files are missing or empty: ${JSON.stringify(globalPrompt)}`, async (t) => {
    const instance = await start(t, { globalPrompt, projectPrompt: " \n" });
    const history = [{ role: "user", content: "hello", timestamp: 1 }];
    assert.equal(request(instance, history), history);
    assert.equal(instance.calls.length, 0, "no metadata work without instructions");
  });
}

test("does not load legacy prompt directories", async (t) => {
  const instance = await start(t, { globalPrompt: null });
  writePrompt(join(instance.cwd, ".pi", "extra-prompts", "ignored.md"), "Legacy instruction");
  await instance.handlers.get("session_start")({}, { cwd: instance.cwd });
  assert.deepEqual(request(instance), []);
  assert.equal(instance.calls.length, 0);
});

test("clears cached instructions when files are removed", async (t) => {
  const instance = await start(t, { projectPrompt: "Project instructions" });
  rmSync(instance.globalFile);
  rmSync(instance.projectFile);
  await instance.handlers.get("session_start")({}, { cwd: instance.cwd });
  assert.deepEqual(request(instance), []);
  assert.equal(instance.calls.length, 2);
});

test("does not duplicate a file that is both global and project-scoped", async (t) => {
  const instance = await start(t, { projectPrompt: "Shared instruction" });
  process.env.PI_CODING_AGENT_DIR = join(instance.cwd, ".pi");
  await instance.handlers.get("session_start")({}, { cwd: instance.cwd });
  assert.equal(request(instance).at(-1).content.split("Shared instruction").length - 1, 1);
});

for (const remote of [
  "https://github.com/owner/repo.git",
  "https://github.com/owner/repo/",
  "git@github.com:owner/repo.git",
  "ssh://git@github.com/owner/repo.git",
]) {
  test(`normalizes GitHub origin: ${remote}`, async (t) => {
    const instance = await start(t, { remote });
    assert.match(request(instance).at(-1).content, /GitHub repository: https:\/\/github\.com\/owner\/repo\n/);
  });
}

for (const options of [
  { remote: "git@gitlab.com:owner/repo.git" },
  { remote: "https://github.com.evil.example/owner/repo" },
  { remote: "https://secret@github.com/owner/repo.git" },
  { code: 128 },
  { fail: true },
]) {
  test(`works without usable GitHub metadata: ${JSON.stringify(options)}`, async (t) => {
    const instance = await start(t, options);
    const content = request(instance).at(-1).content;
    assert.match(content, /Global test instructions/);
    assert.doesNotMatch(content, /## Workspace source links/);
    assert.doesNotMatch(content, /secret|evil\.example/);
  });
}

test("does not reuse metadata from a previous session", async (t) => {
  const instance = await start(t);
  const cwd = join(instance.cwd, "other");
  mkdirSync(cwd);
  await instance.handlers.get("session_start")({}, { cwd });
  const content = request(instance).at(-1).content;
  assert.ok(content.includes(`Working directory: ${cwd}\n`));
  assert.ok(!content.includes(`Working directory: ${instance.cwd}\n`));
});
