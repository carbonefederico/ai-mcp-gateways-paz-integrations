# Testing — the portfolio MCP demo, end to end

This guide covers everything needed to reproduce the tested integration:
the sample MCP server (plus the one-line `amount` addition), the PAZ policies
that authorize it, the local setup, and how to run and inspect the tests.

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

1. The PAZ + PAP deployment from the Azure APIM guide's section 1 (PDP mode
   `external`, the JWT-Lab token validator already configured). If starting
   fresh, follow [`../../azure-apim/test/test.md`](../../azure-apim/test/test.md)
   §1.1–1.2 first.
2. Node.js ≥ 22, `curl`, `jq`.
3. The agentgateway binary (this demo used `/usr/local/bin/agentgateway`,
   v1.5.0) — from [agentgateway.dev](https://agentgateway.dev/docs/).

## 1. Configure the PAZ server

### 1.1 Sideband shared secret + endpoint

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

### 1.2 Import the portfolio policies (PAP admin API — no UI clicks)

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

## 2. Run the pieces locally

Three terminals:

```bash
# 2.1 demo-mcp (the amount support is on main since commit bae8d49)
cd ~/Documents/projects/ai/demo-mcp && npm run dev   # :3000

# 2.2 the adapter
cd <this-repo>/agentgateway
cp .env.example .env            # fill SERVICE_URL + SECRET_HEADER_VALUE from §1.1
npm start                        # :8083 (LISTEN_PORT in .env)

# 2.3 agentgateway
/usr/local/bin/agentgateway -f src/agentgateway.yaml   # :3001
```

## 3. Sanity checks before testing

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

## 4. Run the tests

```bash
cd agentgateway/test
./policy-e2e-tests.sh
```

## 5. Inspect results

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
