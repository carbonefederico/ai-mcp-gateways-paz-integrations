# Testing — the portfolio MCP demo

Two layers, cleanly separated:

| Layer | Runner | What it exercises | Needs a live stack? |
|---|---|---|---|
| **Unit tests** (`test/unit/`) | `npm test` | adapter logic in isolation: sideband envelope, call/retry/timeout behavior, decision→Envoy mapping, gRPC loopback, snapshot builder | **No** — mocked sideband, no services |
| **Integration tests** (`test/integration/`, the test plan) | `./policy-e2e-tests.sh` | the full production chain: client → agentgateway → adapter → PAZ sideband → PAP policies → demo-mcp, 19 scenarios | **Yes** — the K8s stack, or the local stack (§3/§4) |

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
(EUR). Orders above **10,000** are economically risky and require human
approval; 10,000 and below (or an absent `amount`) are low risk. This
distinction is what the HITL policies encode.

## Prerequisites

- **Unit tests:** Node.js ≥ 22 only.
- **Integration tests against the K8s stack:** the deployed stack (see
  [`../README.md`](../README.md), "Kubernetes deployment") — nothing local.
- **Integration tests locally:** the PAZ + PAP pair (§4 — the Azure APIM
  guide's section 1 describes the same setup:
  [`../../azure-apim/test/test.md`](../../azure-apim/test/test.md)), plus
  `curl`, `jq`, and the agentgateway binary
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
| `unit/portfolio-snapshot.test.mjs` | snapshot builder: roster, self-containment (every referenced id ships), session-gate invariants |

The snapshot tests also **regenerate** the snapshot files as a side effect
(the builder mints fresh ids per run) — content-equivalent; restore them
with `git restore` if the churn bothers you.

## 2. Integration tests — the test plan

The 19-scenario policy matrix (`integration/policy-e2e-tests.sh`). Same
structure as the Azure APIM plan
(`../../azure-apim/test/policy-e2e-tests.sh`): tokens minted on the fly by
jwt-lab, claims explicit per scenario, one PASS/FAIL line each.

```bash
cd agentgateway/test/integration
# against the K8s stack:
AG_URL=https://agentgateway-stack-ag.ping-devops.com/mcp \
  AUD=https://agentgateway-stack-ag.ping-devops.com ./policy-e2e-tests.sh
# against a local stack (§3):
./policy-e2e-tests.sh
# verbose: payloads + pause before each scenario
./policy-e2e-tests.sh --verbose
```

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

# base-path matches the agentgateway public MCP path (/portfolio); service
# pins which policy set evaluates; the JWT-Lab validator validates the
# bearer token inside the envelope.
dsconfig --no-prompt create-sideband-api-endpoint \
  --endpoint-name "AgentGateway Portfolio MCP" \
  --set "service:AgentGateway Portfolio MCP" \
  --set "access-token-validator:JWT-Lab" \
  --set "base-path:/portfolio"
```

A path matching no endpoint falls through to the **Default service**, whose
generic policy set permits any valid token — a silent security hole, not a
routing error. The audit check in §5 guards against it.

### 4.2 Import the portfolio policies (PAP admin API — no UI clicks)

The demo policies ship as an importable snapshot:
[`policy-snapshot/Portfolio MCP policies.snapshot`](policy-snapshot/Portfolio%20MCP%20policies.snapshot).
Regenerate it any time with `node test/policy-snapshot/build-portfolio-snapshot.mjs`
(from the `agentgateway/` folder). The snapshot is **self-contained portfolio
content only** — service, attributes, statements, rules, six policies, and the
`AgentGateway Portfolio MCP` policy set. It deliberately ships **no Global
Decision Point and no Token Validation**: both already exist in the serving
branch, and re-shipping them either fails the import (their children must
resolve inside the package) or fails the merge (a fresh-id TV claiming the
shared inactive rule = two parents).

The serving branch is the one PAZ already points at — the APIM demo's
`ID4AI Control Plane` branch. The import below was already executed against
the live PAP; the commands are reproducible:

```bash
PAP=https://id4ai-control-plane-pingauthorizepap.ping-devops.com
AUTH='administrator:2FederateM0re'   # console credential; add header x-user-id: administrator
BR=20fc6b9c-14dc-45ba-8e53-271a1b4d4e9a

# 1. import the snapshot into a NEW branch (raw JSON body; the package
#    carries its own DataStreamFooter digest):
curl -sk -u "$AUTH" -H 'x-user-id: administrator' -X POST \
  -H 'Content-Type: application/json' \
  --data-binary @test/policy-snapshot/"Portfolio MCP policies.snapshot" \
  "$PAP/api/snapshot/Portfolio%20import/import"

# 2. export the import branch's tip (body is an entity-reference array;
#    '[]' exports everything):
#    POST $PAP/api/snapshot/<tipId>/export   with body '[]'

# 3. merge the export into the serving branch. Multipart: field
#    'snapshot-file' (application/json) + field 'conflict-resolutions'
#    (text/plain!). The three COLLISIONs on MCP Method / MCP Tool Name /
#    MCP Transaction Id are cosmetic (the template reuses mortgage ids);
#    TAKE_MINE keeps the portfolio expressions:
#    POST $PAP/api/snapshot/ID4AI%20Control%20Plane/merge

# 4. attach the imported set under the branch's existing Global Decision
#    Point (GET the GDP, append the child, PUT it back), then commit:
#    POST $PAP/api/version-control/branches/$BR/commit
#    body: {"message":"<non-empty commit message>"}
```

What the committed branch now contains (verified by exporting the branch
head): the `AgentGateway Portfolio MCP` service and policy set, the six
policies with their rules and challenge/approval statements, the `MCP Amount`
NUMBER / `MCP Amount Mirror` STRING attributes (`$.params.arguments.amount`),
the `MCP Amount GreaterThan 10000` condition inside `High Risk Orders with
HITL`, and the GDP with children `[Token Validation, APIM Mortgage MCP,
AgentGateway Portfolio MCP]`. The mortgage content is untouched.

Verify the wiring: one authorized call through the gateway, then the PAP
decision audit — `request.service` must read `AgentGateway Portfolio MCP`
(never `Default`), and both mortgage and portfolio calls now appear in the
same branch's audit trail (the two-teams-one-PDP story, visible).

## 5. Inspect integration results

**Script output:** 19 PASS lines + `Result: 19 passed, 0 failed`. Any FAIL:
401 = token validation, 403 = policy, 502 = sideband transport.

**Recent decisions on PAZ:** on the PAP pod:

```bash
tail -1 /opt/out/instance/logs/decision-audit.log | python3 -m json.tool
```

Fields worth eyeballing:
- `decision` — PERMIT / DENY
- `statements[]` — machine-readable denial reasons (`approval_required`,
  `delegation_not_permitted`, insufficient-scope challenges)
- `evaluationLog[]` — watch `MCP Amount` resolve and the six-field mirror
  comparisons fire
- `request.attributes` — exactly what the sideband envelope carried

Confirm `request.service` reads `AgentGateway Portfolio MCP` for portfolio
calls and `APIM Mortgage MCP` for mortgage calls — the centralized-PDP
story: one audit trail, two gateways.
