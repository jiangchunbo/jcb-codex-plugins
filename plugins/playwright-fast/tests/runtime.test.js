const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { afterEach, test } = require("node:test");
const {
  managedNodeModules,
  readRuntimeSpec,
  resolveRuntime,
} = require("../scripts/resolve-runtime");

const pluginDir = path.resolve(__dirname, "..");
const spec = readRuntimeSpec(pluginDir);
const temporaryDirectories = [];

function temporaryDirectory() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "playwright-fast-runtime-"));
  temporaryDirectories.push(directory);
  return directory;
}

function writeFakeRuntime(nodeModules, { version = spec.playwrightVersion, executable = null } = {}) {
  const playwrightDir = path.join(nodeModules, "playwright");
  const coreDir = path.join(nodeModules, "playwright-core");
  fs.mkdirSync(playwrightDir, { recursive: true });
  fs.mkdirSync(coreDir, { recursive: true });
  fs.writeFileSync(path.join(playwrightDir, "package.json"), JSON.stringify({ name: "playwright", version }));
  fs.writeFileSync(path.join(playwrightDir, "index.js"), `module.exports = { chromium: { executablePath: () => ${JSON.stringify(executable)} } };\n`);
  fs.writeFileSync(path.join(playwrightDir, "cli.js"), "");
  fs.writeFileSync(path.join(coreDir, "browsers.json"), JSON.stringify({
    browsers: [{
      name: "chromium",
      revision: spec.chromiumRevision,
      browserVersion: spec.chromiumVersion,
    }],
  }));
}

function writeExecutable(directory, name = "chrome") {
  const executable = path.join(directory, name);
  fs.mkdirSync(path.dirname(executable), { recursive: true });
  fs.writeFileSync(executable, "#!/usr/bin/env bash\nexit 0\n", { mode: 0o755 });
  return executable;
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("managed runtime selection is independent of newer npx caches", () => {
  const root = temporaryDirectory();
  fs.copyFileSync(path.join(pluginDir, "runtime.json"), path.join(root, "runtime.json"));
  const codexHome = path.join(root, "codex-home");
  const env = { HOME: root, CODEX_HOME: codexHome, npm_config_cache: path.join(root, "npm-cache") };
  const executable = writeExecutable(root);
  const nodeModules = managedNodeModules(spec, env);
  writeFakeRuntime(nodeModules, { executable });
  writeFakeRuntime(path.join(env.npm_config_cache, "_npx", "newest", "node_modules"), {
    version: "99.0.0",
    executable,
  });

  const result = resolveRuntime({ root, env });
  assert.equal(result.nodeModules, nodeModules);
  assert.equal(result.playwrightVersion, spec.playwrightVersion);
  assert.equal(result.browserExecutablePath, executable);
  assert.equal(result.browserSource, "playwright-managed");
});

test("explicit Playwright version mismatch is rejected", () => {
  const root = temporaryDirectory();
  fs.copyFileSync(path.join(pluginDir, "runtime.json"), path.join(root, "runtime.json"));
  const nodeModules = path.join(root, "wrong", "node_modules");
  writeFakeRuntime(nodeModules, { version: "99.0.0", executable: writeExecutable(root) });

  assert.throws(
    () => resolveRuntime({ root, env: { HOME: root, PLAYWRIGHT_NODE_MODULES: nodeModules } }),
    /Playwright 99\.0\.0 does not match required 1\.63\.0/,
  );
});

test("missing Chromium reports the pinned revision and exact repair commands", () => {
  const root = temporaryDirectory();
  fs.copyFileSync(path.join(pluginDir, "runtime.json"), path.join(root, "runtime.json"));
  const env = { HOME: root, CODEX_HOME: path.join(root, "codex-home") };
  const nodeModules = managedNodeModules(spec, env);
  writeFakeRuntime(nodeModules, { executable: path.join(root, "missing-chrome") });

  assert.throws(
    () => resolveRuntime({ root, env }),
    (error) => {
      assert.match(error.message, /Playwright 1\.63\.0, Chromium revision 1243/);
      assert.match(error.message, /missing-chrome/);
      assert.match(error.message, /install chromium --no-shell/);
      assert.match(error.message, /install-runtime\.sh/);
      return true;
    },
  );
});

test("explicit browser executable overrides the Playwright-managed browser", () => {
  const root = temporaryDirectory();
  fs.copyFileSync(path.join(pluginDir, "runtime.json"), path.join(root, "runtime.json"));
  const override = writeExecutable(root, "google-chrome");
  const env = {
    HOME: root,
    CODEX_HOME: path.join(root, "codex-home"),
    PLAYWRIGHT_EXECUTABLE_PATH: override,
  };
  const nodeModules = managedNodeModules(spec, env);
  writeFakeRuntime(nodeModules, { executable: path.join(root, "missing-managed-browser") });

  const result = resolveRuntime({ root, env });
  assert.equal(result.browserSource, "override");
  assert.equal(result.browserExecutablePath, override);
});

test("invalid explicit browser executable is rejected before fallback", () => {
  const root = temporaryDirectory();
  fs.copyFileSync(path.join(pluginDir, "runtime.json"), path.join(root, "runtime.json"));

  assert.throws(
    () => resolveRuntime({
      root,
      env: { HOME: root, PLAYWRIGHT_EXECUTABLE_PATH: path.join(root, "missing") },
    }),
    /PLAYWRIGHT_EXECUTABLE_PATH is not an executable file/,
  );
});
