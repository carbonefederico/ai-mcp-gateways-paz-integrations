# Testing — the portfolio MCP demo

Two layers, cleanly separated:

| Layer | Runner | What it exercises | Needs a live stack? |
|---|---|---|---|
| **Unit tests** (`test/unit/`) | `npm test` | adapter logic in isolation: sideband envelope, call/retry/timeout behavior, decision→Envoy mapping, gRPC loopback | **No** — mocked sideband, no services |
| **Integration tests** (`test/integration/`, the test plan) | `./policy-e2e-tests.sh` | the full production chain: client → agentgateway → adapter → PAZ sideband → PAP policies → demo-mcp, 27 scenarios | **Yes** — the K8s stack, or the local stack (§3/§4) |

> **Security disclaimer — the demo MCP server is intentionally open.** The
> demo-mcp backend runs with `OAUTH_ENABLED` unset, so it accepts
> unauthenticated calls. That is deliberate: this demo focuses exclusively on
> the **agentgateway ↔ Ping Authorize integration**, so all enforcement
> happens at the gateway. In a real environment the MCP server would validate
> tokens itself. Defense in depth, not a single gate.

## The sample MCP server

The policies guard **[`carbonefederico/demo-mcp`](https://github.com/carbonefederico/demo-mcp)**
→ `/mcp/portfolio`, four tools:

| Tool | What it does | Risk |
|---|---|---|
| `get_portfolio_summary` | Portfolio valuation, cash, risk profile | read |
| `list_positions` | List positions | read |
| `simulate_trade` | Non-binding trade simulation | read |
| `submit_trade_order` | Submit a trade order (`customerId`, `symbol`, `side`, `quantity`, `orderType`, `amount`, `confirmedByUser`, optional `txn` echoed for correlation) | write, risk-tiered by `amount` |

**The `amount` parameter is an addition to demo-mcp** (branch `amount-param`,
commit `bae8d49`): `submit_trade_order` gained an optional monetary `amount`
(EUR). Orders are partitioned into explicit bands (below); orders without an
`amount` are **unpriceable and denied** — the policy never falls back to
"low risk" for a missing value.

## The policy model (branch `AgentGatewayPortfolioMCP`)

The live tree (snapshot:
[`k8s/server-profiles/pingauthorizepap/policies/AgentGatewayPortfolioMCP.SNAPSHOT`](../k8s/server-profiles/pingauthorizepap/policies/AgentGatewayPortfolioMCP.SNAPSHOT))
is five named policies under a per-MCP wrapper, with **every request class
explicitly covered — no implicit ordering fallbacks**:

| Policy | Condition | Verdict |
|---|---|---|
| **Session Methods** | MCP method calls (initialize, tools/list, …) | ladder below, then `portfolio:read` scope |
| **Read Tools** | read tools (summary, positions, simulate) | ladder below, then `portfolio:read` scope |
| **Order Tool: missing amount** | `submit_trade_order` AND `amount <= 0` (absent amounts resolve to 0 via the attribute's `defaultValue`) | **deny** `unpriceable_order_denied` |
| **Order Tool: medium risk HITL** | `submit_trade_order` AND `0 < amount <= threshold` | ladder below, then `portfolio:write`, then the **approval mirror** (six-field tctx + `txn` binding) |
| **Order Tool: high risk denied** | `submit_trade_order` AND `amount > threshold` | **deny** `order_above_limit` — approval cannot exceed the band |
| **Default Deny** | everything else | deny |

**The ladder** — mandatory rules inside Session Methods, Read Tools, and the
HITL policy, combined with `DenyOverrides` so every rule evaluates (a
permit-branch hit under `FirstApplicable` would be terminal and silently
skip later gates):

- **R1 audience** — token minted for the MCP-specific audience
  `Constants.Portfolio_MCP Audience` (= the gateway's `/mcp/portfolio`
  resource URI, RFC 8707). A token for the wrong resource is `invalid_token`
  → 401.
- **R2 agent identity — ONLY AGENTS CAN ACCESS** — the rule ALWAYS applies:
  the acting agent (`act.sub`) must equal
  `Constants.Portfolio Analysis Agent` (`customer_support_agent`), an
  admin-declared allow-list. A token **without `act.sub` has no acting
  agent and is denied** (`agent_identity_mismatch`) — there is no
  direct-access path. Any other delegated actor is likewise denied.
  Authorization of an agent is an admin decision, not a token property —
  `client_id` is irrelevant.
- **R3 user claim** — delegated access is reserved to VIP users
  (`sub_type == vip_user`). Under R2 every token that reaches R3 already
  carries the declared agent's `act.sub`.

**Tuning knobs** (PAP constants): `Constants.Order Approval Threshold`
(NUMBER, 20000) sets the HITL/deny band boundary; the audience and agent
constants set R1/R2. All constants carry the MCP's name per the
`Constants.<Name>_MCP …` convention.

## Prerequisites

- **Unit tests:** Node.js ≥ 22 only.
- **Integration tests against the K8s stack:** the deployed stack (see
  [`../README.md`](../README.md), "Kubernetes deployment") — nothing local.
  The bootstrap imports and commits the branch automatically; there is no
  manual post-install step.
- **Integration tests locally:** the PAZ + PAP pair (§4), plus `curl`, `jq`,
  and the agentgateway binary
  ([agentgateway.dev](https://agentgateway.dev/docs/)).

## 1. Unit tests (`npm test`)

The adapter is a real Node service (APIM's equivalent logic lives in a
policy fragment; here it is code, so it gets unit tests). They run against
mocked sideband endpoints — no PAZ, PAP, or gateway needed, finish in
seconds, and are the right place to pin transport subtleties (retry-once,
timeout fail-closed, TLS-stale-cert self-exit, decision→Envoy mapping).

```bash
cd agentgateway            # the adapter package root
npm test                   # node --test test/unit/*.test.mjs
```

Files (`test/unit/`), by concern:

| File | Covers |
|---|---|
| `unit/envelope.test.mjs` | sideband request envelope shape (schema parity with the APIM fragment) |
| `unit/sideband-call.test.mjs` | adapter→PAZ call: PDG-TOKEN header, retry, timeout fail-closed, 401 passthrough, TLS-trust-failure self-exit |
| `unit/decision-mapping.test.mjs` | PAZ decision → Envoy CheckResponse (permit/deny/502, JSON-RPC fallback bodies) |
| `unit/adapter-loopback.test.mjs` | the real gRPC server end-to-end over loopback |
| `unit/proto-load.test.mjs` | vendored ext_authz.proto loads |

The policy snapshot has **no unit tests by design**: its correctness is
exercised where it matters — end-to-end, by the integration plan against
the live PAP. The snapshot is the exported committed head of branch
`AgentGatewayPortfolioMCP`; edit policies on the live PAP (or import the
snapshot into a scratch PAP), then export the committed head over the file.
The export→mutate→delete→re-import→commit edit loop is documented in
[`../k8s/server-profiles/pingauthorizepap/policies/README.md`](../k8s/server-profiles/pingauthorizepap/policies/README.md).

## 2. Integration tests — the test plan

The 27-scenario policy matrix (`integration/policy-e2e-tests.sh`). Tokens
are minted on the fly by jwt-lab; claims are explicit per scenario so each
PASS/FAIL line is self-documenting.

```bash
cd agentgateway/test/integration
# against the K8s stack:
AG_URL=https://agentgateway-stack-ag.ping-devops.com/mcp/portfolio \
  AUD=https://agentgateway-stack-ag.ping-devops.com \
  MCP_AUD=https://agentgateway-stack-ag.ping-devops.com/mcp/portfolio \
  ./policy-e2e-tests.sh
# against a local stack (§3):
./policy-e2e-tests.sh
# verbose: payloads + pause before each scenario
./policy-e2e-tests.sh --verbose
```

The matrix maps 1:1 onto the policy model above: the three order bands plus
boundaries (0, 3K, 20K, 20K+ε, 50K), the approval mirror (exact match,
wrong/missing `txn`, amount drift), the ladder gates (declared vs undeclared
agent, VIP vs standard delegation, MCP audience vs gateway-root audience),
expired/invalid tokens (401s), and default-deny probes (unknown tool,
bodyless GET).

> A matrix where all the **denies** pass and all the **permits** fail is the
> signature of an EMPTY deployment package (PDP resolved nothing) — it looks
> almost healthy but no policy evaluated. Check
> `dsconfig get-external-server-prop --server-name pingauthorizepap
> --property snapshot` (`-` = empty) before debugging individual scenarios.

## 3. Local stack (for integration tests without K8s)

Three terminals:

```bash
# 3.1 demo-mcp (the amount support is on main since commit bae8d49)
cd ~/Documents/projects/ai/demo-mcp && npm run dev   # :3000

# 3.2 the adapter
cd <this-repo>/agentgateway
cp .env.example .env            # fill SERVICE_URL + SECRET_HEADER_VALUE from §4.1
npm start                        # :8083 (LISTEN_PORT in .env)

# 3.3 agentgateway
/usr/local/bin/agentgateway -f src/agentgateway.yaml   # :3001
```

Sanity checks before running the plan:

```bash
# a) tokenless call must be rejected (chain live, fail-closed):
curl -s -o /dev/null -w '%{http_code}\n' -X POST http://localhost:3001/mcp \
  -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","method":"tools/list","id":1}'
# expect 401; a 200 here means the chain is not enforcing

# b) protected-resource metadata served through agentgateway:
curl -s http://localhost:3001/.well-known/oauth-protected-resource/portfolio
# "resource" must read http://localhost:3001/mcp/portfolio (client-facing), not
# the backend's localhost:3000 — that is what the X-Client-Host/X-Client-Proto
# headers on the metadata route are for.

# c) stop the adapter and re-run (a): expect 403 (fail-closed, extAuthz
# callout fails), then restart it.
```

## 4. Local PAZ/PAP setup (for integration tests without K8s)

### 4.1 Sideband shared secret + endpoint

All `dsconfig` commands run against the PAZ server (`--no-prompt` shown;
`--hostname/--port/bindDN` omitted for brevity).

```bash
# The secret the adapter presents; the header name must match what the
# adapter sends (PDG-TOKEN).
dsconfig --no-prompt set-http-servlet-extension-prop \
  --extension-name "Sideband API" \
  --add "shared-secrets:AGENTGATEWAY-SIDEBAND"

dsconfig --no-prompt create-sideband-api-shared-secret \
  --secret-name "AGENTGATEWAY-SIDEBAND" \
  --set "shared-secret:<generate-a-random-secret>"

# The endpoint's service MUST be the GENERIC "AgentGateway" service — the
# policy tree's top wrapper PolicySet is targeted at it, and per-MCP
# selection happens one level down (the "Portfolio MCP" child PolicySet,
# condition leaf == "portfolio"). Pointing the endpoint at the per-MCP
# service leaves the top wrapper N/A for every request: every decision
# comes back NOT_APPLICABLE, all permits fail and all denies pass vacuously.
dsconfig --no-prompt create-sideband-api-endpoint \
  --endpoint-name "AgentGateway Portfolio MCP" \
  --set "service:AgentGateway" \
  --set "access-token-validator:JWT-Lab" \
  --set "base-path:/mcp"
```

A path matching no endpoint falls through to the **Default service**, whose
generic policy set permits any valid token — a silent security hole, not a
routing error. The audit check in §5 guards against it.

### 4.2 Import the portfolio policies (PAP admin API — no UI clicks)

The demo policies ship as the branch snapshot
[`k8s/server-profiles/pingauthorizepap/policies/AgentGatewayPortfolioMCP.SNAPSHOT`](../k8s/server-profiles/pingauthorizepap/policies/AgentGatewayPortfolioMCP.SNAPSHOT)
— the exported committed head of branch `AgentGatewayPortfolioMCP`,
self-contained: trust framework baseline, the `AgentGateway` service and
wrapper, the `Portfolio MCP` set with its five policies, and the Global
Decision Point whose children hang off the `AgentGateway` wrapper.

```bash
PAP=https://<pap-host>                 # e.g. the K8s stack's PAP, or localhost:18443 under port-forward
AUTH='administrator:2FederateM0re'     # console credential; add header x-user-id: administrator

# 1. import the snapshot into a NEW branch named after the file
#    (raw JSON body; the package carries its own DataStreamFooter digest):
curl -sk -u "$AUTH" -H 'x-user-id: administrator' -X POST \
  -H 'Content-Type: application/json' \
  --data-binary @../k8s/server-profiles/pingauthorizepap/policies/AgentGatewayPortfolioMCP.SNAPSHOT \
  "$PAP/api/snapshot/AgentGatewayPortfolioMCP/import"
# -> prints the branch id

# 2. commit it — the PDP serves only COMMITTED snapshots:
curl -sk -u "$AUTH" -H 'x-user-id: administrator' -X POST \
  -H 'Content-Type: application/json' \
  -d '{"message":"import AgentGatewayPortfolioMCP"}' \
  "$PAP/api/version-control/branches/<branch-id>/commit"

# 3. point PAZ at it (the K8s profile layer does this; locally):
dsconfig --no-prompt set-external-server-prop \
  --server-name pingauthorizepap \
  --set branch:AgentGatewayPortfolioMCP \
  --set "decision-node:a7c4e2d0-8f11-4b5a-9c3d-6e8f2a1b4c7d"
# decision-node = the Global Decision Point PolicySet id INSIDE the snapshot
# (branch exports carry the whole tree from the GDP down). A snapshot with a
# re-created GDP carries a new id; update the dsconfig to match or the PDP
# returns 503 REQUEST_FAILED.
```

## 5. Inspect integration results

**Script output:** 27 PASS lines + `Result: 27 passed, 0 failed`. Any FAIL:
401 = token validation, 403 = policy, 502 = sideband transport.

**Recent decisions on PAZ:** on the PAP pod:

```bash
tail -1 /opt/out/instance/logs/decision-audit.log | python3 -m json.tool
```

Fields worth eyeballing:
- `decision` — PERMIT / DENY / NOT_APPLICABLE (N/A for every request = the
  empty-package or wrong-service failure above, not a policy verdict)
- `statements[]` — machine-readable denial reasons (`approval_required`,
  `agent_identity_mismatch`, `unpriceable_order_denied`, `order_above_limit`,
  insufficient-scope challenges)
- `evaluationLog[]` — the wrapper chain: `AgentGateway` → `Portfolio MCP` →
  the matching policy, each ladder rule's outcome, and the band condition
  that selected the order policy
- `request.attributes` — exactly what the sideband envelope carried
