# Agentgateway ↔ Ping Authorize sideband integration — design

Date: 2026-10-12
Status: approved in-session design; spec for implementation planning
Sibling of: [`azure-apim/`](../../../azure-apim/), [`aws-agentcore-mcp-gateway/`](../../../aws-agentcore-mcp-gateway/)

## 1. Goal and story

Add a third integration folder, `agentgateway/`, that wires
[agentgateway](https://agentgateway.dev/) (standalone binary) to Ping Authorize
(PingOne Authorize or self-hosted PingAuthorize) as the centralized Policy
Decision Point (PDP) for MCP traffic, using the same **Sideband API** pattern as
the existing integrations. The gateway acts as the Policy Enforcement Point
(PEP): every MCP call is intercepted, its context is POSTed to PAZ's
`/sideband/request`, and the decision — permit, deny with machine-readable
reason, deny-with-challenge — is enforced, fail-closed.

The demo story: *two teams, two gateways, one PDP.* Team A's Azure APIM protects
the mortgage MCP; team B's agentgateway protects a different MCP (portfolio) —
both enforce through the same PAZ, each with its own sideband endpoint, service
name, and policy set, distinguishable in the decision audit.

## 2. Agreed understanding

- **Topology (demo phase):** everything local except PAZ — demo-mcp (`:3000`),
  agentgateway (`:3001`), sideband adapter (`:8082`) all run on the laptop; PAZ
  stays on the `id4ai-control-plane` cluster deployment. No ngrok, no Vercel.
  A later full k8s deployment is a separate phase; this design keeps the
  adapter container-runnable but does not build it.
- **PAZ side: pattern unchanged, content new.** Same sideband protocol, same
  JWT-Lab token validator, same deny semantics (`WWW-Authenticate`
  `insufficient_scope` challenges, `approval_required`, `delegation_not_permitted`),
  same JSON-RPC error correlation on denials. New: one shared secret, one
  sideband endpoint, and a new portfolio policy set that lands in the same
  serving branch as the mortgage policies.
- **Target MCP:** `carbonefederico/demo-mcp` → `/mcp/portfolio`
  (`get_portfolio_summary`, `list_positions`, `simulate_trade`,
  `submit_trade_order`). The mortgage policy *pattern* ports to it; the
  mortgage policy *content* does not (tool names and payload attributes differ).
- **No agentgateway token validation.** No `mcpAuthentication`; PAZ validates
  the bearer token inside the sideband envelope — identical to APIM, where the
  token validator is configured on the sideband endpoint.
- **The well-known metadata route** (`/.well-known/oauth-protected-resource/…`)
  is forwarded to demo-mcp, which serves the RFC 9728 document; the gateway
  passes front-door host/proto as `X-Client-Host`/`X-Client-Proto` so the
  backend builds the client-facing `resource` identifier (RFC 8707) — same
  mechanism as the APIM second-API route.

## 3. The protocol mismatch, and the chosen bridge (decision: gRPC)

PAZ signals **deny with HTTP 200 + an embedded `response` object**; agentgateway's
extAuthz treats every 2xx from the authorization service as **allow**. A direct
PAZ connection would pass every denial silently. Something must translate. The
adapter is not optional — it flips the deny encoding and builds the sideband
envelope.

**Chosen: Option B — gRPC Envoy External Authorization.** The adapter implements
`envoy.service.auth.v3.Authorization/Check` (the exact proto agentgateway
consumes; vendored from agentgateway 1.5.0). Rationale over HTTP-mode extAuthz:

- gRPC is agentgateway's **default** callout protocol and its canonical,
  Envoy-compatible path.
- **Real client source address**: gRPC `CheckRequest.attributes.source`
  carries the client IP/port natively — the APIM fragment had to fake
  `source_port: 5034`; HTTP mode cannot supply it.
- **Multi-value-safe headers**: Envoy's repeated-value header map matches the
  sideband envelope's array-of-single-key-objects format 1:1.
- **Reusable artifact**: a PAZ-sideband ⇄ Envoy ext_authz bridge serves the
  later k8s deployment (agentgateway k8s mode, or any Envoy/Istio PEP) unchanged.

Verified relay semantics (agentgateway source, `http/ext_authz.rs`): a
`CheckResponse` with non-OK status + `DeniedHttpResponse{status, headers, body}`
becomes the client's direct response; with `includeRequestBody`, the original
body reaches the adapter in `attributes.request.http.body`. Callout failures
honor `failureMode` (default **Deny** = fail-closed).

## 4. Architecture

```
                        ┌─────────────────────────────────────┐
                        │  demo-mcp  (npm run dev, :3000)     │
                        │  /mcp/portfolio — target MCP        │
                        └────────────▲────────────────────────┘
                                     │ 6. proxied MCP call
┌──────────┐   1. MCP call    ┌──────┴───────┐
│ MCP      │─────────────────►│ agentgateway │
│ client   │  Bearer + JSON-  │   (:3001)    │
│ (curl)   │  RPC body        └──────┬───────┘
└──────────┘                         │ 2. gRPC Check (ext_authz v3)
                              ┌──────▼───────────┐
                              │ paz-extauthz     │ 3. POST /sideband/request
                              │ adapter (:8082)  │──────────► PAZ sideband API
                              │ (Node, this repo)│ 4. permit / deny
                              └──────────────────┘           ▲ id4ai-control-plane
                                     5. allow / deny-relay   │ cluster
```

Decision paths through the adapter (semantics identical to the APIM fragment):

| PAZ says | Adapter CheckResponse | Client sees |
|---|---|---|
| 200, no `response` object | OK, pass-through | normal MCP response |
| 200, `response` = deny | DENIED with PAZ's status/headers/body | PAZ denial (401/403, `WWW-Authenticate`, JSON-RPC error `-32001`/`-32003`) |
| sideband transport failure ×3 (retries) | DENIED 502 `sideband-unavailable` | fail-closed |
| PAZ non-200 | DENIED 502 `sideband-error` | fail-closed |
| adapter down/timeout | gRPC error → `failureMode: deny` | fail-closed |

No permit-on-error path exists anywhere in the chain.

## 5. The adapter (`src/paz-extauthz-adapter.mjs`)

Node ESM, zero-build (proto-loader at runtime — same loading style as the
AgentCore Lambda), runtime deps only `@grpc/grpc-js` + `@grpc/proto-loader`.
Protos vendored into `src/proto/` from agentgateway 1.5.0
(`crates/protos/proto/ext_authz.proto` + `shared_envoy.proto`, Apache-2.0) so
the wire contract is pinned to the tested binary.

Per call:

1. Extract from `CheckRequest.attributes`: `request.http.method`, `path`,
   `headers` (repeated map → array-of-single-key-objects, duplicates
   preserved), `body` (bytes → string), `source.ip`/`port` (real values).
2. Build the sideband envelope exactly as the APIM fragment does:
   `source_ip`, `source_port`, `method`, `url` (reconstructed from original
   host + path), `http_version: "1.1"`, `headers` (the array format; the
   client's `Authorization` header is copied — PAZ validates the token),
   `body` (string).
3. POST `{SERVICE_URL}/sideband/request` with `PDG-TOKEN: <secret>`,
   `Content-Type: application/json`; retry on transport failure twice (one
   immediate, one after 1s — the decision probe is idempotent), same
   rationale as the APIM fragment.
4. Map the result per the Section 4 table. On deny: `DeniedHttpResponse.status`
   from PAZ's `response_code`, `headers` from PAZ's response headers (incl.
   `WWW-Authenticate`), `body` from PAZ's body — with the JSON-RPC error
   envelope fallback (`-32001` for 401, `-32003` for 403, echoing the original
   JSON-RPC `id`) when PAZ sends no body.
5. Configuration via env vars, same convention as the AgentCore Lambda:
   `SERVICE_URL`, `SECRET_HEADER_VALUE`, `SIDEBAND_TIMEOUT_MS` (default 5000),
   `DEBUG_LOGGING` (with the same secret-masking discipline).
6. `npm test` runs a selftest: fabricate `CheckRequest`s and assert the
   envelope shape and every mapping branch.

## 6. agentgateway config (`src/agentgateway.yaml`)

Routing-based mode (the simplified `mcp:` form cannot forward the well-known
metadata route). One gateway, two routes:

```yaml
# yaml-language-server: $schema=https://agentgateway.dev/schema/config
gateways:
  default:
    port: 3001                      # demo-mcp owns :3000

routes:
  # 1. The MCP route — the only place extAuthz attaches
  - name: portfolio-mcp
    matches:
      - path: { pathPrefix: /portfolio }
    backends:
      - mcp:
          targets:
            - name: portfolio
              mcp:
                host: http://localhost:3000/mcp/portfolio
    policies:
      extAuthz:
        host: localhost:8082        # the adapter
        failureMode: deny           # fail-closed (also the default)
        protocol: { grpc: {} }
        # gRPC forwards ALL request headers when includeRequestHeaders is
        # unset — same as APIM copying every header into the envelope
        includeRequestBody:
          maxRequestBytes: 65536
          allowPartialMessage: false   # oversized bodies reject, never partial-auth
        policies:
          http:
            requestTimeout: "5s"      # extAuthz callout budget (default 2s)

  # 2. The metadata route — plain HTTP passthrough to demo-mcp
  - name: mcp-metadata
    matches:
      - path: { pathPrefix: /.well-known/oauth-protected-resource }
    backends:
      - host: localhost:3000
    policies:
      requestHeaderModifier:          # demo-mcp's resourceForRequest() prefers X-Client-*
        set:                          # (exact field names pinned with --validate-only)
          x-client-host: localhost:3001
          x-client-proto: http
```

Deliberate omissions, mirroring APIM: no `mcpAuthentication` (PAZ validates the
token from the envelope), no `backendAuth` (demo-mcp is open in the demo — the
APIM guide's defense-in-depth disclaimer carries over), no decision caching
(gRPC-only, and near-useless here since decisions depend on token + body).
Validate the config with `agentgateway --validate-only -f src/agentgateway.yaml`
during implementation and pin exact schema field placement then.

GET/SSE wrinkle: demo-mcp is stateless JSON-only, so all MCP traffic is
POST-with-body. Bodyless GETs (stream opens) hit default-deny — correct
posture; enabling them later is one policy addition, not a redesign.

## 7. PAZ-side changes (cloud)

Same cluster deployment; three additions, all `dsconfig`-scriptable like the
APIM guide §1.3 (exact commands in `test/test.md`):

1. **Shared secret** `AGENTGATEWAY-SIDEBAND` (+ `--add` to the Sideband API
   servlet extension's `shared-secrets`). A distinct name from APIM's secret
   keeps the two gateways' credentials distinguishable.
2. **Sideband endpoint** `AgentGateway Portfolio MCP`: `service: AgentGateway
   Portfolio MCP`, `access-token-validator: JWT-Lab` (existing validator),
   `base-path: /portfolio` — the base path matches the agentgateway public MCP
   path the same way it matched `/mortgage-mcp-local` for APIM. Path-prefix
   matching falls through unmatched paths to the **Default service**, whose
   generic policy set permits any valid token — a silent security hole, not a
   routing error; the audit check below guards it.
3. **Policies merge into the serving branch.** In PDP-external mode one branch
   serves decisions; the mortgage snapshot imported as branch `ID4AI Control
   Plane` whose Global Decision Point dispatches by service. The portfolio
   ServiceDefinition + policy set must land **in that same serving branch** so
   one Global Decision Point dispatches to both services. Snapshot imports
   create new branches, so implementation validates the Branch Manager merge
   path; `test.md` documents the exact steps, and the snapshot doubles as the
   cold-start artifact for a fresh install.

Verification (same as APIM): one authorized call, then the PAP decision audit
— `request.service` must read `AgentGateway Portfolio MCP`, never `Default`.

## 8. Portfolio policy snapshot (`test/policy-snapshot/Portfolio MCP policies.snapshot`)

New snapshot, built by adapting the mortgage snapshot's object model (flat
object list: 7 policies / 2 policy sets / ~73 attribute definitions / 1
ServiceDefinition / statements / rules). Same six-policy pattern + global Token
Validation; scopes are capability classes `portfolio:read` / `portfolio:write`.

| # | Policy | Outcome |
|---|---|---|
| 1 | Allow Session Methods (`initialize`, `tools/list`, `ping`, `notifications/initialized`) | PERMIT, no scope |
| 2 | Allow Delegated Token by VIP Users Only (`act.sub` present ⇒ subject must be `vip_user`) | DENY `delegation_not_permitted` |
| 3 | Allow read operations (`get_portfolio_summary`, `list_positions`, `simulate_trade`) on `portfolio:read` | PERMIT / 403 `insufficient_scope` challenge |
| 4 | Allow low-risk orders: `amount ≤ 10,000` on `portfolio:write` | PERMIT / 403 `insufficient_scope` |
| 5 | High-risk orders with HITL: `amount > 10,000` | 403 `insufficient_scope` (no write scope) / 403 `approval_required` (no mirror) / PERMIT (mirror) |
| 6 | Default Deny (unknown tools, unmatched) | DENY |

**Risk tiering key: `amount`** — a new optional numeric parameter added to
`submit_trade_order`'s schema in demo-mcp (the user's repo; a one-line
`z.number().positive().optional()` change, backwards-compatible, documented in
`test.md`). Tiering on a monetary value is the strongest agent-governance story
("the agent tried to move €50,000 without a human") and adds the
numeric-comparison condition pattern the mortgage set lacked. The `MCP Amount`
attribute extracts `arguments.amount` by JSONPath; policies 4/5 compare it
against the 10,000 threshold.

**HITL txn-mirror** (deny-then-challenge, then re-authorization — same
two-phase loop as mortgage): an approval token carries `approved_for:
submit_trade_order`, `txn`, and a `tctx` mirroring **six** payload fields —
`tool`, `customerId`, `symbol`, `side`, `quantity`, `amount` — compared
attribute-to-attribute against the payload; `txn == arguments.txn` too. Any
drift — different symbol, changed amount, replayed txn id — breaks the mirror
and policy 5 denies `approval_required`. An approval for €10k cannot execute a
€50k order. Expiry is the revocation (short TTL on approval tokens, as with
mortgage).

Demo-mcp change is required for `amount` to exist; without it the tiering has
no key (defaults: treat absent `amount` as low-risk threshold path — the
policy's condition is `amount > 10000`, absent ⇒ not high-risk ⇒ policy 4
handles it).

## 9. Test matrix (`test/policy-e2e-tests.sh`, 17 tests)

Direct adaptation of the APIM harness (same `mint`/`run`/502-retry machinery;
`AG_URL` replaces `APIM_URL`; tokens minted on the fly from jwt-lab with
explicit claims; `http://localhost:3001/portfolio` as the call target).

| Group | Tests |
|---|---|
| Core | T1 tools/list · T2 read with `portfolio:read` · T3 low-risk order (amount ≤ 10k) with `portfolio:write` · T4 high-risk (50k) no approval → 403 `approval_required` · T5 approved mirror → 200 · T5a wrong txn → 403 · T5b no txn → 403 · T5c `tctx.amount` mismatch → 403 · T6 unknown tool → 403 · T8 write-only scope on read → 403 · T9 expired token → 401 |
| Delegation (RFC 8693) | D1 vip+agent read → 200 · D2 standard+agent → 403 `delegation_not_permitted` · D3 vip direct → 200 · D4 vip+agent benign → 200 · D5 vip+agent risky no approval → 403 · D6 vip+agent risky with approval → 200 |

Plus documented curl checks in `test.md`: metadata route through agentgateway
(`resource` = client-facing `http://localhost:3001/portfolio`), and the
tokenless-call sanity check (expect 401 from PAZ via adapter — proves the
chain is live).

## 10. Repository layout

```
agentgateway/
├── README.md                          # integration guide (mirrors azure-apim/README.md)
├── package.json                       # @grpc/grpc-js, @grpc/proto-loader; npm test
├── src/
│   ├── paz-extauthz-adapter.mjs       # the gRPC adapter
│   ├── agentgateway.yaml              # standalone config (Section 6)
│   └── proto/
│       ├── ext_authz.proto            # vendored from agentgateway 1.5.0
│       └── shared_envoy.proto
└── test/
    ├── policy-e2e-tests.sh            # Section 9 matrix
    ├── test.md                        # local setup: demo-mcp(+amount), adapter, AG, PAZ dsconfig
    └── policy-snapshot/
        └── Portfolio MCP policies.snapshot
```

Root `README.md` gains a third layout-table row. The adapter runs as
`node src/paz-extauthz-adapter.mjs` today and is container-ready for the later
k8s phase.

## 11. Error handling

Every failure denies: gRPC error ⇒ agentgateway `failureMode: deny`; PAZ
transport failure ⇒ adapter retries then returns `Denied 502
sideband-unavailable`; PAZ non-200 ⇒ `Denied 502 sideband-error`; oversized
bodies ⇒ rejected before the callout (`allowPartialMessage: false`). No
permit-on-error anywhere. The APIM guide's transient-502 lesson is already
baked in: the adapter's retry policy handles stale pooled sockets, and debug
mode is off by default (`DEBUG_LOGGING` env, same masking as the Lambda).

## 12. Out of scope

- Full k8s deployment of agentgateway/adapter (later phase; container-runnable
  adapter is the only provision made now).
- demo-mcp OAuth enablement (backend stays open in the demo — same disclaimer
  as APIM).
- Response-side authorization (`/sideband/response`): the APIM integration is
  request-side only; this design matches it.
- Decision caching.
