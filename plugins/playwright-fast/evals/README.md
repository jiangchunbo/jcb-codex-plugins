# Playwright Fast Agent Evaluations

This suite measures whether Codex models can use Playwright Fast naturally from a browser task
written in ordinary language. It complements the deterministic contract/runtime tests; it does not
replace them.

The latest checked-in findings and three-model matrix are in [RESULTS.md](RESULTS.md).

## What is measured

- task correctness, verified by fixture state and requested answer values
- whether the first `run` contract is valid
- Playwright Fast calls, failed calls, correction calls, and unrelated tool calls
- unnecessary `status` and `reset` usage
- end-to-end latency and Playwright Fast's own reported runtime
- repeated friction across models or repeated attempts

The case catalog contains 13 deterministic fixture tasks and two opt-in local-project tasks. The
real tasks use `/home/jcb/projects-tq/web-zwpg-2c-admin` and
`/home/jcb/projects-tq/web-zwpg-2c` without real credentials or writes to either repository.

## Run

Start with the bounded smoke suite:

```bash
node plugins/playwright-fast/evals/run-agent-evals.js --mode smoke
```

Run the agreed layered suite (up to 90 model turns):

```bash
node plugins/playwright-fast/evals/run-agent-evals.js --mode layered --concurrency 3
```

Run the conditional-delegation matrix (three decisions across three parent models):

```bash
node plugins/playwright-fast/evals/run-delegation-evals.js --concurrency 3
```

This matrix scores actual `spawn_agent` calls from each isolated Codex session, their model,
reasoning effort, fork mode, assignment contents, parent execution lane, and fixture oracle. It does
not grade copied Skill text. Delegation runs keep their otherwise isolated sessions long enough to
read the complete rollout because the public `codex exec --json` event stream can omit collaboration
events; the generated sessions and result records are ignored build artifacts.

Useful narrower forms:

```bash
node plugins/playwright-fast/evals/run-agent-evals.js --mode first-pass --skip-real
node plugins/playwright-fast/evals/run-agent-evals.js --case element-control --models gpt-5.6-luna
node plugins/playwright-fast/evals/run-agent-evals.js --mode layered --dry-run
```

Each run writes raw scored records, `summary.json`, and `report.md` under the ignored `results/`
directory. Rebuild a report without calling a model:

```bash
node plugins/playwright-fast/evals/score-agent-evals.js plugins/playwright-fast/evals/results/<run>
```

Overlay targeted post-fix reruns onto a first pass without counting both versions:

```bash
node plugins/playwright-fast/evals/score-agent-evals.js \
  plugins/playwright-fast/evals/results/<first-pass> \
  plugins/playwright-fast/evals/results/<post-fix> \
  --output plugins/playwright-fast/evals/results/<final-matrix>
```

The runner disables the unrelated local `idea` and `lanhu` MCP servers for its child Codex tasks.
It uses the current app's non-interactive `never` approval behavior with an unrestricted sandbox so
browser calls are not rejected before reaching the plugin. Evaluation prompts are fixed local-page
tasks and explicitly prohibit shell and file operations. The installed Playwright Fast plugin stays
enabled so the evaluation sees the same Skill and tool schema as an ordinary task.

## Hot runtime benchmark

```bash
node plugins/playwright-fast/evals/benchmark-hot-run.js --iterations=30 --enforce
```

The benchmark warms one MCP process, then measures compact read/assertion contracts. The enforced
targets are wall-clock P50 at or below 100 ms and P95 at or below 250 ms.

## Interpreting failures

A failed case is not automatically a plugin defect. Treat a friction signature as a plugin
candidate only when it appears in at least two models or at least twice for one model. Environment
startup and real-page availability failures are reported separately. Prefer compatibility inside
the schema/runtime over retries, force clicks, extra tools, or additional user steps.
