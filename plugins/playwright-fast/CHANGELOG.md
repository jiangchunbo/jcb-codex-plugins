# Changelog

## 1.2.0 — 2026-09-12

- Automatically compare direct connections with inherited HTTP/HTTPS proxies using bounded local
  connection-quality probes and machine/network-specific statistics. No proxy means direct only.
- Separate WS and WSS before CONNECT with a local Chromium PAC configuration. Preserve application
  TLS, browser state, and the boundary that prevents replay after request/tunnel delivery.
- Reuse HTTP connections in pools isolated by context, origin, and route; clean them up on reset/close.
- Add compact routing/phase diagnostics, optional statistics clearing, and an opt-in 250 ms delayed
  connection competition experiment. Competition remains off by default.
- Update skill guidance using retained model/effort and evidence-size evaluations: Luna low for
  routine eligible delegation, medium for complex flows; preserve normal model service tier.
- Retain reproducible tests, benchmark runners, raw comparisons, and earlier failed trials.

Validation: 58 regression tests passed. The final 95-run controlled task matrix completed all 60
automatic/racing tasks; ten direct-only fault cases failed as expected. Normal automatic routing
used nine target connections including two probes, versus seven for native direct. These are local
measurements, not a guarantee of public-site speedup.

### Upgrade and rollback

Upgrade the `jcb-codex-plugins` marketplace and reinstall `playwright-fast`, then start a new Codex
task to load the updated skill and MCP process. Pinned Playwright/Chromium versions are unchanged.

For a browser-networking rollback, set `PLAYWRIGHT_FAST_ROUTING=off` in the MCP process environment
and restart it. Keep `PLAYWRIGHT_FAST_CONNECT_RACE=off` for ordinary trial use. The previous release
source is commit `82696b640835482ba9d7175df66277509fbc635c` (1.1.2); the old installed cache is not
manually removed. This release changes neither system proxy settings nor model API routing.
