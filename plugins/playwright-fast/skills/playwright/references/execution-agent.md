## Choose The Execution Agent

Execute in the current agent when browser work is the user's primary task, the current task was
already delegated as a browser-only task, a Playwright call has established page or login state,
the next action depends on the same failure state, or the parent has no useful non-browser work to run
at the same time. Continue in the same agent after the first Playwright call; do not transfer a live
flow or assume that another agent shares its browser state.

Delegate browser work only when it is a bounded, independent verification inside a larger task and
the parent can continue useful non-browser work concurrently, or when multiple browser targets are
independent and share no state. When either condition is met, delegation is required. Before
starting the parent's parallel work, call `spawn_agent`
exactly once for each independent browser target; do not merely announce delegation or call `wait`
without a successfully returned child id. Use the collaboration subagent tool, not a user-owned
task, with:

- `model: "gpt-5.6-luna"`
- `reasoning_effort: "low"` for routine controls, reads, and frame/popup flows; choose `"medium"`
  before starting multi-page constraint comparisons or chained review/confirmation/persistence tasks
- no inherited conversation: use `fork_turns: "none"` when that field is available, or the
  equivalent `fork_context: false` on collaboration APIs that expose that field instead
- a unique lowercase `task_name` describing the browser target when the API requires it

These defaults prioritize observed task latency. Honor an explicitly requested model or effort.
For GPT-5.5, use low for routine flows and medium for the multi-stage tasks above. Do not infer
that fewer reasoning tokens or higher token/s necessarily means faster completion.

Give the subagent a self-contained task containing the URL, actions, acceptance result, allowed
fixtures or fake data, and required evidence. Tell it to use Playwright Fast directly, not modify
business source, and not delegate again. A Playwright-dedicated subagent always executes directly.

Do not automatically select `high`, `xhigh`, `max`, or a different model after a failure. Keep the
single targeted diagnostic in the same executing agent. If collaboration or the requested model is
unavailable, do not retry delegation; execute the browser task in the current agent.

