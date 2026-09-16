const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");

const OUTPUT_LIMIT = 16000;
const PREVIEW_LIMIT = 12000;
const RETENTION_MS = 24 * 60 * 60 * 1000;
const lastCleanup = new Map();
const MARKER = "… [truncated; full value in outputArtifact]";

// Bound serialized size (including escaped newlines/quotes), while retaining
// object keys and value types wherever the preview budget permits.
function preview(value, budget, depth = 0) {
  if (budget < 4) return null;
  if (typeof value === "string") {
    if (JSON.stringify(value).length <= budget) return value;
    let low = 0;
    let high = Math.min(value.length, budget);
    const suffix = budget >= JSON.stringify(MARKER).length ? MARKER : "…";
    while (low < high) {
      const mid = Math.ceil((low + high) / 2);
      if (JSON.stringify(value.slice(0, mid) + suffix).length <= budget) low = mid;
      else high = mid - 1;
    }
    return value.slice(0, low) + suffix;
  }
  if (value === null || typeof value !== "object") return value;
  if (depth >= 12) return Array.isArray(value) ? [] : {};
  const array = Array.isArray(value);
  const result = array ? [] : {};
  const entries = Object.entries(value);
  let remaining = budget - 2;
  for (let i = 0; i < entries.length; i++) {
    const [key, child] = entries[i];
    const overhead = (i ? 1 : 0) + (array ? 0 : JSON.stringify(key).length + 1);
    if (remaining < overhead + 4) break;
    const share = Math.max(4, Math.floor((remaining - overhead) / Math.min(entries.length - i, 20)));
    const part = preview(child, share, depth + 1);
    const size = JSON.stringify(part).length;
    if (size + overhead > remaining) break;
    if (array) result.push(part);
    else Object.defineProperty(result, key, { value: part, enumerable: true, configurable: true });
    remaining -= size + overhead;
  }
  return result;
}

// Only unlink this module's sole known file in an old, private, owned directory.
// Never recurse, follow symlinks, or delete another plugin's temporary paths.
async function cleanupExpiredOutputs(tempDir, io = fs, now = Date.now()) {
  for (const name of await io.readdir(tempDir)) {
    if (!/^playwright-fast-outputs-[a-zA-Z0-9]{6}$/.test(name)) continue;
    const directory = path.join(tempDir, name);
    try {
      const stat = await io.lstat(directory);
      if (!stat.isDirectory() || (stat.mode & 0o777) !== 0o700 ||
          (process.getuid && stat.uid !== process.getuid()) || now - stat.mtimeMs < RETENTION_MS) continue;
      const entries = await io.readdir(directory);
      if (entries.length !== 1 || entries[0] !== "outputs.json") continue;
      const file = path.join(directory, "outputs.json");
      const fileStat = await io.lstat(file);
      if (!fileStat.isFile() || (fileStat.mode & 0o777) !== 0o600 ||
          (process.getuid && fileStat.uid !== process.getuid()) || now - fileStat.mtimeMs < RETENTION_MS) continue;
      await io.unlink(file);
      await io.rmdir(directory);
    } catch { /* Busy or changed artifacts are retained. */ }
  }
}

async function compactOutputs(result, { io = fs, tempDir = os.tmpdir() } = {}) {
  if (!result.outputs) return result;
  const serialized = JSON.stringify(result.outputs);
  if (serialized.length <= OUTPUT_LIMIT) return result;
  let directory;
  try {
    directory = await io.mkdtemp(path.join(tempDir, "playwright-fast-outputs-"));
    await io.chmod(directory, 0o700);
    const artifactPath = path.join(directory, "outputs.json");
    await io.writeFile(artifactPath, serialized, { encoding: "utf8", mode: 0o600, flag: "wx" });
    const now = Date.now();
    if (now - (lastCleanup.get(tempDir) || 0) > 60 * 60 * 1000) {
      lastCleanup.set(tempDir, now);
      await cleanupExpiredOutputs(tempDir, io, now).catch(() => {});
    }
    return {
      ...result,
      outputs: preview(result.outputs, PREVIEW_LIMIT),
      outputArtifact: {
        path: artifactPath,
        originalChars: serialized.length,
        truncated: true,
        format: "json",
        retentionHours: 24,
        note: "outputs is a bounded preview; read this local file for complete outputs. Array items and object fields may be omitted. The file contains only outputs, not the whole result. Older artifacts may be removed after 24 hours on a later large-output run.",
      },
    };
  } catch (error) {
    if (directory) {
      await io.unlink(path.join(directory, "outputs.json")).catch(() => {});
      await io.rmdir(directory).catch(() => {});
    }
    return { ...result, outputWarning: `Could not save full outputs; returning them unabridged (${error.code || "artifact write failed"}).` };
  }
}

module.exports = { compactOutputs, OUTPUT_LIMIT, PREVIEW_LIMIT, cleanupExpiredOutputs };
