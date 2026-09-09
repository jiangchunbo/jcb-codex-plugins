#!/usr/bin/env node

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const pluginDir = path.resolve(__dirname, "..");

function readRuntimeSpec(root = pluginDir) {
  return JSON.parse(fs.readFileSync(path.join(root, "runtime.json"), "utf8"));
}

function managedNodeModules(spec, env = process.env) {
  const codexHome = env.CODEX_HOME || path.join(env.HOME || os.homedir(), ".codex");
  return path.join(codexHome, "runtimes", "playwright-fast", spec.playwrightVersion, "node_modules");
}

function isExecutable(filePath) {
  try {
    fs.accessSync(filePath, fs.constants.X_OK);
    return fs.statSync(filePath).isFile();
  } catch {
    return false;
  }
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", `'\\''`)}'`;
}

function inspectCandidate(candidate, spec, env = process.env) {
  const packageFile = path.join(candidate.nodeModules, "playwright", "package.json");
  if (!fs.existsSync(packageFile)) {
    return { ok: false, message: `${candidate.source}: Playwright package is missing at ${packageFile}` };
  }

  let version;
  try {
    version = JSON.parse(fs.readFileSync(packageFile, "utf8")).version;
  } catch (error) {
    return { ok: false, message: `${candidate.source}: cannot read ${packageFile}: ${error.message}` };
  }
  if (version !== spec.playwrightVersion) {
    return {
      ok: false,
      message: `${candidate.source}: Playwright ${version || "unknown"} does not match required ${spec.playwrightVersion}`,
    };
  }

  const browsersFile = path.join(candidate.nodeModules, "playwright-core", "browsers.json");
  let chromiumMetadata;
  try {
    const browsers = JSON.parse(fs.readFileSync(browsersFile, "utf8"));
    chromiumMetadata = browsers.browsers.find((browser) => browser.name === "chromium");
  } catch (error) {
    return { ok: false, message: `${candidate.source}: cannot read ${browsersFile}: ${error.message}` };
  }
  if (chromiumMetadata?.revision !== spec.chromiumRevision || chromiumMetadata?.browserVersion !== spec.chromiumVersion) {
    return {
      ok: false,
      message: `${candidate.source}: Chromium ${chromiumMetadata?.revision || "unknown"} (${chromiumMetadata?.browserVersion || "unknown"}) does not match required ${spec.chromiumRevision} (${spec.chromiumVersion})`,
    };
  }

  let managedExecutablePath;
  try {
    const { chromium } = require(path.join(candidate.nodeModules, "playwright"));
    managedExecutablePath = chromium.executablePath();
  } catch (error) {
    return { ok: false, message: `${candidate.source}: cannot load Playwright ${version}: ${error.message}` };
  }

  const overridePath = env.PLAYWRIGHT_EXECUTABLE_PATH;
  const executablePath = overridePath || managedExecutablePath;
  if (!isExecutable(executablePath)) {
    const installCommand = `node ${shellQuote(path.join(candidate.nodeModules, "playwright", "cli.js"))} install chromium --no-shell`;
    return {
      ok: false,
      message: overridePath
        ? `override: PLAYWRIGHT_EXECUTABLE_PATH is not an executable file: ${overridePath}`
        : `${candidate.source}: Chromium revision ${spec.chromiumRevision} is missing at ${executablePath}. Run: ${installCommand}`,
    };
  }

  return {
    ok: true,
    nodeModules: candidate.nodeModules,
    playwrightVersion: version,
    chromiumRevision: spec.chromiumRevision,
    chromiumVersion: spec.chromiumVersion,
    browserExecutablePath: executablePath,
    browserSource: overridePath ? "override" : "playwright-managed",
  };
}

function resolveRuntime({ root = pluginDir, env = process.env } = {}) {
  const spec = readRuntimeSpec(root);
  if (env.PLAYWRIGHT_EXECUTABLE_PATH && !isExecutable(env.PLAYWRIGHT_EXECUTABLE_PATH)) {
    throw new Error([
      `playwright-fast runtime unavailable: requires Playwright ${spec.playwrightVersion}, Chromium revision ${spec.chromiumRevision} (${spec.chromiumVersion}).`,
      `PLAYWRIGHT_EXECUTABLE_PATH is not an executable file: ${env.PLAYWRIGHT_EXECUTABLE_PATH}`,
      `Run: bash ${shellQuote(path.join(root, "scripts", "install-runtime.sh"))}`,
    ].join("\n"));
  }
  const explicitNodeModules = env.PLAYWRIGHT_NODE_MODULES;
  const managed = managedNodeModules(spec, env);
  const candidates = explicitNodeModules
    ? [{ source: "PLAYWRIGHT_NODE_MODULES", nodeModules: explicitNodeModules }]
    : [
        { source: "managed runtime", nodeModules: managed },
        { source: "plugin-local runtime", nodeModules: path.join(root, "node_modules") },
      ];

  const failures = [];
  for (const candidate of candidates) {
    const result = inspectCandidate(candidate, spec, env);
    if (result.ok) return result;
    failures.push(result.message);
    if (explicitNodeModules || env.PLAYWRIGHT_EXECUTABLE_PATH) break;
  }

  const installScript = path.join(root, "scripts", "install-runtime.sh");
  throw new Error([
    `playwright-fast runtime unavailable: requires Playwright ${spec.playwrightVersion}, Chromium revision ${spec.chromiumRevision} (${spec.chromiumVersion}).`,
    ...failures,
    `Run: bash ${shellQuote(installScript)}`,
  ].join("\n"));
}

function main() {
  try {
    const runtime = resolveRuntime();
    if (process.argv.includes("--lines")) {
      process.stdout.write([
        runtime.nodeModules,
        runtime.playwrightVersion,
        runtime.chromiumRevision,
        runtime.chromiumVersion,
        runtime.browserExecutablePath,
        runtime.browserSource,
      ].join("\t"));
      return;
    }
    process.stdout.write(`${JSON.stringify(runtime)}\n`);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}

if (require.main === module) main();

module.exports = {
  inspectCandidate,
  managedNodeModules,
  readRuntimeSpec,
  resolveRuntime,
};
