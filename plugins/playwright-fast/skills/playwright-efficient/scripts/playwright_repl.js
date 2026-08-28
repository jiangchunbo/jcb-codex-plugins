const repl = require("node:repl");
const { chromium } = require("playwright");
const startedAt = performance.now();

async function main() {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  const page = await context.newPage();
  let closing = false;

  async function close() {
    if (closing) return;
    closing = true;
    await browser.close();
  }

  console.log(`PW_READY startup_ms=${Math.round(performance.now() - startedAt)}`);
  const server = repl.start({ prompt: "pw> ", useGlobal: false });
  Object.assign(server.context, { browser, context, page });

  server.on("exit", async () => {
    await close();
    process.exit(0);
  });

  process.once("SIGTERM", async () => {
    await close();
    process.exit(0);
  });
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
