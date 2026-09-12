# Local adaptive browser routing

The persistent MCP runtime alone owns this feature; CLI and JSONL fallbacks retain their existing
network behavior. `PLAYWRIGHT_FAST_ROUTING=auto` is the default. `off` skips the relay and restores
the previous Chromium launch configuration. Environment changes require restarting the MCP process.

## Inherited configuration

For HTTP targets, read `http_proxy`, then `HTTP_PROXY` if the lowercase variable is absent.
For HTTPS targets, use `https_proxy`, then `HTTPS_PROXY`. If the corresponding variable is absent,
use `all_proxy`, then `ALL_PROXY`. An explicitly empty lowercase value suppresses its uppercase
counterpart. `no_proxy` similarly takes precedence over `NO_PROXY`.

Only `http://` and `https://` upstreams are supported, including URL-encoded Basic credentials.
Unsupported or invalid configurations produce a credential-free warning and that scheme stays
direct. No supported proxy means no listener, probes, or routing-cache initialization.

Loopback, private/link-local addresses, local names, and locally resolved private addresses stay
direct. NO_PROXY supports hostname suffixes, optional ports, wildcard patterns, IPv4 CIDR, and IPv6
literals. A local DNS lookup that exceeds 250 ms conservatively uses direct for that connection;
an unresolved public name can still use proxy-side DNS. Public DNS answers are cached for five
minutes. No fixed external domain list or proxy address is installed.

## Transport and isolation

Chromium uses an inline, local-only PAC script and two random ports bound only to `127.0.0.1`.
The main entry handles HTTP/HTTPS/WSS, and a separate entry identifies plain WS before CONNECT.
Both entries share the same context pins and routing statistics. The relay handles HTTP, HTTPS CONNECT,
and WebSocket upgrades. HTTPS application TLS belongs to Chromium and the origin: the relay
installs no certificate and never decrypts it. Probe TLS handshakes validate certificates normally.
HTTPS upstreams add a separate validated TLS connection to the proxy.

The upstream must allow CONNECT to the target port, including HTTP/WS ports. An upstream limited
to absolute-form HTTP forwarding is not supported in this version. Proxy authentication headers
are consumed by the upstream and excluded from origin requests.

Routes are keyed by scheme, canonical host, and port; WS shares HTTP and WSS shares HTTPS. Navigation
and subresource connections use the same router. Each context pins its selections. Existing
connections are never migrated. Faster measurements affect the next context; an unavailable route
may be replaced before delivery. A real connection attempt has a two-second deadline and may try
the alternate once, only before sending business bytes or delivering CONNECT success to Chromium.
There is no replay after that boundary, including POST, TLS errors, HTTP errors, and WebSocket data.
These deadlines do not extend the contract's existing navigation/operation timeout.

## Learning

Only actually accessed targets trigger background exploration, including requests on reused
connections. Probes perform DNS/TCP and, for HTTPS, target TLS through the complete direct or
upstream CONNECT path. They send no page requests, cookies, or application data. Connection quality
is not page-load time, bandwidth, token throughput, or a guarantee of a faster website.

- Each probe has a three-second deadline. Each target/route is tested at most once per five
  minutes, with at most two probes across cooperating local processes sharing the cache directory.
- The queue is bounded to 32 entries; entries older than 30 seconds are discarded. Budget contention
  skips work and never blocks the business connection. Crashed-process leases expire automatically.
- Scores use the last 30 minutes, weighted with a 15-minute half-life. Failed probes cost 3000 ms.
  A performance-driven switch requires at least three samples on each route, at least 20% relative
  improvement, and at least 50 ms absolute improvement. Cold targets start direct.
- Two consecutive connection/probe failures suspend preference for that route for 30 seconds.
  Exploration can resume afterward, still subject to the five-minute rate limit. HTTP status,
  locator failure, or a cancelled request does not count as a route failure.
- Browser transport failure may schedule exploration but cannot authorize transparent retries.

## Local records and diagnostics

Records live under `$CODEX_HOME/cache/playwright-fast/routing/`, or
`~/.codex/cache/playwright-fast/routing/` when CODEX_HOME is absent. Keep this directory local rather
than syncing it. Host identity, network interfaces, DNS configuration, and proxy configuration
contribute to a hash. Passwords are hashed as part of configuration identity and never stored in
plain text. Network identity is checked at startup and at most once a minute on subsequent runs;
changes select fresh statistics while preserving current context pins.

Each process writes its own bounded JSON shard using atomic replacement. Startup aggregates
compatible shards, ignores corrupt data, and removes shards older than 24 hours. A shard/view has
at most 1000 targets and 16000 records; context targets beyond the limit use direct without learning.
Records contain only the host/port/scheme key, route, timestamp, duration, outcome/category, and
whether the record represents a probe, connection, or selection. They contain no URL path, body,
Cookie, or proxy password. Cache failures degrade to in-memory operation and appear in diagnostics.

`status.routing` and `diag.routing` show mode, warnings, counts, fallbacks, and up to eight recent
target choices with probe scores. Normal successful `ultra` responses stay compact. A proxy warning
is also returned when a configured protocol cannot be used.

`reset` defaults to preserving records. `reset({clearRouting:true})` rotates the local statistics
epoch and resets browser state; `warm:false` avoids immediate relaunch. Other live processes adopt
the epoch at their next network check. Old shards become ineligible and age out normally, avoiding
races with writers. Use this after a network change that interface/DNS fingerprints cannot identify.
Closing the browser/runtime closes the relay, active tunnels, and probes; measurement alone never
restarts Chromium.

## Phase-two diagnostics and optional connection competition

`status.routing.timings` and `diag.routing.timings` summarize a rolling, in-memory window of at
most 500 events over 30 minutes. They separate real connections, probes, policy decisions, and
top-level contract navigation. Each measured phase has its own sample count and P50/P95; failures
and cancellations are counted separately. `recentConnections` includes the last eight real
connection attempts with origin key, route, outcome, and measured phases. These additional metrics
are not written to disk and never affect route scores.

- `dnsMs`: time until the local socket DNS lookup event; literal IP addresses record zero.
  Proxy-side target DNS is opaque and remains part of CONNECT timing.
- `tcpMs`: time from local resolution (or connection start for literal IPs) to TCP establishment.
  Node address-family attempts can contribute to this duration; it is not isolated packet RTT.
- `proxyTlsMs`: HTTPS upstream TLS handshake after TCP establishment.
- `proxyConnectMs`: upstream CONNECT request to successful tunnel response.
- `targetTlsMs`: target TLS handshake on probes only. Browser application TLS remains opaque.
- `totalMs`: elapsed connection/probe attempt, including a timeout if it fails.
- `policyMs`: route policy work, including the private-address DNS check and any wait for an
  ongoing first-connection selection. A hot cached choice is a different measurement from cold DNS.
- `navigationMs`: top-level `run.url` navigation until the requested `waitUntil` (normally
  DOMContentLoaded), or until navigation failure. This includes browser/site work. It excludes
  later `ready` assertions, step-level goto/reload, and model latency.

Missing phases mean they were not observable/completed, not zero milliseconds. A failed handshake
contributes total attempt time but no completed-handshake sample. Cancelled attempts are excluded
from phase percentiles. Aggregate phases may have different sample counts and should not be added
as if they described the same individual request. Ordinary ultra output remains unchanged.

Set `PLAYWRIGHT_FAST_CONNECT_RACE=on` before MCP startup to try delayed connection competition;
`off` is the default. With a supported inherited proxy and an eligible public target, the initial
route gets a 250 ms head start. If still connecting, the alternate starts; an immediate failure
starts the alternate immediately. The first established TCP/CONNECT path wins. Neither contender
sends business bytes before selection, and only the winner is delivered to Chromium. The loser is
cancelled and is not scored as a network failure. The usual two-second per-attempt timeout applies.

Competition is restricted to the first connection for an origin in a context. Simultaneous opens
for that origin wait for selection, then establish their own connections on its pinned route.
Later connections retain that route with the existing pre-delivery failure fallback. At most two
competitions are active per process; excess targets use normal sequential selection. This is
separate from the shared background-probe budget. No proxy, routing off, private/NO_PROXY targets,
and already-pinned targets never speculate. Reset/close cancels unfinished contenders.

`routing.race` reports the effective switch, delay, alternate attempts, alternate wins, and active
competitions. `fallbackConnections` continues to count sequential recovery only. An alternate
attempt triggered by an immediate failure is included in race counters too.

The default remains off: local controlled tests show reduced first-connection waiting, but do not
establish an everyday benefit across networks or justify additional sockets for every user. This
feature does not race browser TLS handshakes or replay a request after tunnel delivery.

## WebSocket protocol selection (fixed after the phase-three matrix)

Chromium can send CONNECT for both plain WS and encrypted WSS. The CONNECT authority does not
include the application scheme. The runtime now configures Chromium with an inline PAC script,
which selects the dedicated plain-WS listener when the URL starts with `ws:`; WSS and HTTPS use
the main listener. This also works when WS and WSS use the same port. The PAC contains only local
listener ports, never upstream proxy credentials, and performs no DNS lookup, remote fetch, or
application request. Chromium's implicit local bypass remains compatible with always-direct local
traffic. Other NO_PROXY/private checks remain in the router.

The scheme is therefore known before opening an upstream connection or delivering the tunnel.
WS uses the HTTP proxy, shares HTTP route pins, and gets TCP-only probes. WSS uses the HTTPS proxy
and gets target TLS probes. An absent scheme-specific proxy is never fabricated. Existing TLS
validation, opaque application tunnels, and pre-delivery-only fallback are unchanged. No page
WebSocket API injection, message interception, certificate installation, or post-delivery replay
is needed. This behavior depends on using `Router.browserArgs()` after `start()`; a manual single
proxy endpoint cannot convey the same protocol distinction.

Chromium documents PAC-based WS/WSS separation in its
[proxy documentation](https://github.com/chromium/chromium/blob/main/net/docs/proxy.md).
Actual Chromium tests cover distinct inherited proxies, HTTP-only and HTTPS-only configurations,
Cookie/localStorage state, subprotocol negotiation, binary frames, a rejected handshake submitted
once, and absence of TLS probes against plain WS. The old failure matrix remains historical evidence,
not a description of the corrected runtime.

## HTTP connection reuse

HTTP forwarding uses context-owned pools keyed by target origin and selected route. Each cached
pool allows at most six active and six idle sockets, with a 30-second idle expiry. At most 128 pools
are cached; extra targets use an uncached agent. Idle expiry never applies to active requests.
Proxy connections still complete CONNECT before sending business bytes.

If establishing a connection changes route, the old pool is retired: already queued requests may
finish, new requests select a correctly labelled pool, and idle sockets are discarded through the
Agent lifecycle. Pools cannot be shared across router/browser contexts and close with the runtime.
A stale connection or an error after business bytes have been sent is returned normally; pooling
does not authorize POST replay. WS/WSS streams and HTTPS tunnels continue to own their connections.
`status.routing.httpPools` reports cached pool and idle-socket counts.
