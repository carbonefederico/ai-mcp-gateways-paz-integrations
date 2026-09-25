# Azure API Management — Ping Authorize Sideband Integration

This folder contains the Azure API Management (APIM) integration that uses Ping
Authorize (self-hosted) or PingOne Authorize (cloud) as the centralized Policy
Decision Point (PDP) for MCP (Model Context Protocol) traffic, using the
**Sideband API**.

The gateway acts as the Policy Enforcement Point (PEP): it intercepts every MCP
call, forwards the original HTTP request to the authorization server's sideband
endpoint, and enforces the decision — permit, deny with a machine-readable
reason, or deny-with-challenge for human-in-the-loop flows.

```
MCP client ──> APIM ──> PingAuthorize (sideband API) ──> policy decision
   │             │                                              │
   │             │ permit: forward to backend MCP server <──────┘
   │             │ deny:   return the denial to the client
   │             └─ (APIM holds a shared secret for the sideband API)
```

---

## Folder layout

```
azure-apim/
├── README.md                          # this file
├── src/
│   ├── authorize-sideband-fragment.xml   # APIM policy fragment (sideband PEP)
│   └── authorize-sideband-policy.xml     # outer policy wrapping the fragment
└── test/
    ├── policy-e2e-tests.sh               # end-to-end policy test matrix
    ├── LOCAL-SETUP.md                    # run the whole stack locally (PAZ config + import + APIM + ngrok)
    └── policy-snapshot/                  # exported PAZ policy branch (import via Policy Editor)
        └── attributes.json … policysets.json
```

---

## 1. The APIM policy fragment

`src/authorize-sideband-fragment.xml` is an APIM inbound policy fragment named
**`AuthorizeSidebandAuthorization`**. The outer policy
(`src/authorize-sideband-policy.xml`) includes it in the inbound section:

```xml
<inbound>
    <base />
    <include-fragment fragment-id="AuthorizeSidebandAuthorization" />
</inbound>
```

The fragment is product-neutral: the sideband protocol is shared between
PingOne Authorize (cloud) and PingAuthorize (self-hosted), so the same policy
works against either, given different named values.

### How it works, step by step

1. **Capture the original request.** The inbound MCP body is preserved as a
   string (`authorizeOriginalRequestBody`) — the sideband protocol requires
   the body as a string field inside its envelope.

2. **Build the sideband envelope.** A JSON object describing the client's
   original request, matching the format Ping's official gateway adapters produce:

   ```json
   {
     "source_ip": "<client IP>",
     "source_port": 5034,
     "method": "POST",
     "url": "https://apimid4ai.azure-api.net/mortgage-mcp/mcp/mortgage",
     "http_version": "1.1",
     "headers": [{"Accept": "application/json"}, {"Content-Type": "application/json"},
                 {"Host": "apimid4ai.azure-api.net"}, {"Authorization": "Bearer eyJ..."}],
     "body": "{\"jsonrpc\":\"2.0\", ...}"
   }
   ```

   Notes:
   - `headers` is an **array of single-key objects** — this is the sideband
     protocol's multi-value-safe header format, not a plain map.
   - The client's `Authorization` header is copied into the envelope. The
     authorization server validates the bearer token itself; nothing needs to
     be configured by name for this.
   - APIM does not expose the client's TCP source port to policy expressions,
     so the fragment uses a synthetic `5034`. The value only matters if
     policies use it.

3. **POST the envelope** to `{AuthorizeSidebandRequestEndpoint}/sideband/request`
   with:
   - the sideband shared secret in the `PDG-TOKEN` header (the header name is
     configured on the server's Sideband API servlet extension — the Ping),
   - `Content-Type: application/json`.

4. **Enforce the decision** (fail-closed):

   | Sideband response | Meaning | Fragment behavior |
   |---|---|---|
   | Transport failure / null response | integration error | `502` `sideband-unavailable` (fail closed) |
   | non-200 status | integration error, not a denial | `502` `sideband-error` |
   | HTTP 200, top-level `response` object | **DENY** | relay the denial: status, reason, headers (incl. `WWW-Authenticate`) and body from the `response` object; with debug on, a redacted diagnostic envelope is returned instead |
   | HTTP 200, no `response` object | **PERMIT** | continue to the backend MCP server |

5. **MCP-aware denials.** When the backend denies, the fragment reads the
   JSON-RPC `id` from the original request and returns a JSON-RPC-shaped error
   (`-32001` for 401, `-32003` for 403), so MCP clients can correlate the
   denial with their pending request.

### Named values (configure in the APIM portal)

| Named Value | Description |
|---|---|
| `AuthorizeSidebandRequestEndpoint` | Base URL of the authorization server **without** `/sideband/request`. Example (PingAuthorize): `https://paz.example.com` — the fragment appends the path. |
| `AuthorizeSidebandClientToken` (**secret**) | The sideband shared secret. On PingAuthorize this is a Sideband API Shared Secret; on PingOne Authorize it is the gateway credential. |
| `AuthorizeSidebandDebug` | `false` by default. Set `true` temporarily to get a redacted sideband request plus the full authorization response in error bodies. Remove before production. |

### Deploying

1. APIM portal → **APIs → Policy fragments → + Create**, name it
   `AuthorizeSidebandAuthorization`, paste `src/authorize-sideband-fragment.xml`.
2. Create the three named values above (mark the client token **secret**).
3. Include the fragment in the API's inbound policy as shown above.
4. Point the endpoint at your authorization server and make sure the shared
   secret value matches the one configured server-side, and the header name
   matches the server's `shared-secret-header-name`.

### Production hardening

- Turn debug **off** (`AuthorizeSidebandDebug=false`).
- Tune the `timeout` on the `send-request` (currently 20s) to your PDP SLA.
- Keep the fail-closed behavior: any sideband transport failure is a 502, never
  an implicit permit.

---

## The demo policies (PingAuthorize Policy Editor)

The demo authorizes a **mortgage MCP server** (`/mcp/mortgage` on the demo-mcp
backend) whose interesting tool is `submit_mortgage_change_request` with a
`changeType` argument. All policies live on the `ID4AI Control Plane` branch,
under the `APIM Mortgage MCP` policy set (service `APIM Mortgage MCP`,
sideband endpoint `base-path: /mortgage-mcp`).

### Policy attributes (Trust Framework components)

Policies read MCP context from the sideband request via JSONPath attribute
components:

| Attribute | JSONPath | Source |
|---|---|---|
| `MCP Method` | `$.method` | JSON-RPC method (`tools/call`, `tools/list`, …) |
| `MCP Tool Name` | `$.params.name` | tool being invoked |
| `MCP Change Type` | `$.params.arguments.changeType` | risk-relevant argument |
| `HttpRequest.AccessToken.scope` | `$.scope` | token scopes |
| `HttpRequest.AccessToken.approved_for` | `$.approved_for` | HITL approval binding (default `_null`) |
| `HttpRequest.AccessToken.tctx_change_type` | `$.tctx.changeType` | transaction context: approved change type |
| `HttpRequest.AccessToken.tctx_mortgage_id` | `$.tctx.mortgageId` | transaction context: approved mortgage |
| `MCP Mortgage Id` | `$.params.arguments.mortgageId` | mortgage targeted by the payload |
| `HttpRequest.AccessToken.act_sub` | `$.act.sub` | RFC 8693 actor (the agent) |
| `HttpRequest.AccessToken.sub_type` | `$.sub_type` | subject type (e.g. `vip_user`) |

### Policy set: `APIM Mortgage MCP` (FirstApplicable order)

| # | Policy | Fires when | Decision |
|---|---|---|---|
| 1 | **Allow Session Methods** | method ∈ {`initialize`, `tools/list`, `ping`} | PERMIT |
| 2 | **Allow Delegated Token by VIP Users Only** | call is delegated (`act.sub` present) AND subject is not `vip_user` | DENY — `delegation_not_permitted` |
| 3 | **Allow read operations** | tool ∈ {`get_mortgage_summary`, `calculate_affordability`, `generate_rate_quote`} ∧ scope `mortgage:read` | PERMIT |
| 4 | **Allow low risk changes** | `changeType = PAYMENT_DATE` ∧ scope `mortgage:write` | PERMIT |
| 5 | **Deny High Risk Changes Without HITL** | `changeType` ∈ {`RATE_SWITCH`, `TERM_CHANGE`, `OVERPAYMENT`} ∧ transaction context does not mirror this payload | DENY — `approval_required` (403, machine-readable challenge) |
| 6 | **Allow High Risk Changes with HITL** | risky `changeType` ∧ token's transaction context matches the payload claim-by-claim | PERMIT |
| 7 | **Default Deny** | anything else (unknown tools, wrong scopes, expired/invalid tokens are caught earlier by Token Validation) | DENY |

The design intent, layer by layer:

- **Scopes are capability classes, policies map tools to classes.** Tokens
  carry coarse scopes (`mortgage:read`, `mortgage:write`); the policy decides
  which tools they cover. Adding a tool never requires re-issuing tokens.
- **Risk lives in the payload, not the tool.** The same `tools/call` flips
  between permit and approval-required based on `changeType`.
- **Human-in-the-loop = deny-then-challenge, then re-authorization.** PAZ
  cannot pause a decision. *Deny High Risk Changes Without HITL* denies
  risky changes with an `approval_required` challenge; once a human
  approves, the AS mints a short-lived transaction token carrying the
  approval and the transaction context (`approved_for` + `tctx`), and the
  *same call* retries through *Allow High Risk Changes with HITL*, which
  validates the `tctx` mirror claim-by-claim against the payload.
- **Delegation is a first-class gate.** Classic token-exchange tokens (RFC
  8693) carry the human in `sub` (+ `sub_type`) and the acting agent in
  `act.sub`. Only VIP subjects may be operated via the delegated agent; direct
  (non-delegated) calls are unaffected by the gate.

### The demo flow

```
1. Agent calls calculate_affordability                    → PERMIT   (read)
2. Agent calls submit_mortgage_change_request
     changeType=PAYMENT_DATE                              → PERMIT   (benign)
3. Agent calls the same tool with changeType=TERM_CHANGE  → 403 approval_required
4. Human approves; the AS mints a transaction token carrying
       approved_for=submit_mortgage_change_request
       tctx={tool, changeType: TERM_CHANGE, mortgageId: MORT-90001, ...}
5. Agent retries the identical call → PERMIT
     (Allow High Risk Changes with HITL validates tctx claim-by-claim)
6. Agent calls delete_mortgage (not a real tool)          → 403      (default deny)
```

With a delegated token the same matrix also proves the agent gate: a
`standard_user` behind the `customer_support_agent` is denied outright, while
the `vip_user` flows through.

---

## End-to-end tests

`test/policy-e2e-tests.sh` runs 14 assertions through the **full production
chain** — client → APIM → sideband → policy decision → backend — no mocking.
For a fully local setup (demo-mcp via ngrok, policy import into your own PAZ),
see [`test/LOCAL-SETUP.md`](test/LOCAL-SETUP.md).

### Prerequisites

- `curl` and `jq`
- Network access to the APIM endpoint and to jwt-lab (token minting)
- The APIM API must have the fragment deployed with `AuthorizeSidebandDebug`
  on or off (both work; debug just enriches error bodies)

### What it does

1. **Mints every scenario token on the fly** from jwt-lab — no presets, claims
   are spelled out per scenario so each test is self-documenting:

   | Token | Claims |
   |---|---|
   | read | `sub=alice, scope=mortgage:read` |
   | write | `sub=alice, scope=mortgage:read mortgage:write` |
   | approved | write + `approved_for` + `tctx={tool, changeType: TERM_CHANGE, mortgageId: MORT-90001}` |
   | expired | read, `expiresIn=-300` |
   | VIP + agent | `sub=vip_user, sub_type=vip_user, act.sub=customer_support_agent` |
   | standard + agent | `sub=standard_user, sub_type=standard, act.sub=customer_support_agent` |
   | VIP direct | VIP without `act` |
   | VIP + agent + approved | all three bindings combined |

2. **Runs 14 tests** across the core matrix and the delegation matrix, each
   asserting the expected HTTP status (200 permit / 403 policy deny / 401
   invalid token).

### Running

```bash
cd azure-apim/test
./policy-e2e-tests.sh

# Override targets without editing the script:
APIM_URL=https://other-apim.example.com/mcp/mortgage \
AUD=https://other-apim.example.com \
./policy-e2e-tests.sh
```

Expected output: 14 PASS lines and `Result: 14 passed, 0 failed`.

### Test matrix

| ID | Scenario | Token | Expected |
|---|---|---|---|
| T1 | `tools/list` (session method) | read | 200 |
| T2 | `get_mortgage_summary` | read | 200 |
| T3 | benign `PAYMENT_DATE` change | write | 200 |
| T4 | risky `TERM_CHANGE`, no approval | write | 403 `approval_required` |
| T5 | same call **with** approval | approved | 200 |
| T6 | unknown tool `delete_mortgage` | read | 403 (default deny) |
| T8 | read tool, write-only scope | write-only | 403 |
| T9 | expired token | expired | 401 |
| D1 | VIP user + support agent, read | delegated VIP | 200 |
| D2 | standard user + same agent | delegated non-VIP | 403 `delegation_not_permitted` |
| D3 | VIP direct (no agent) | VIP, no `act` | 200 |
| D4 | VIP + agent, benign change | delegated VIP | 200 |
| D5 | VIP + agent, risky, no approval | delegated VIP | 403 |
| D6 | VIP + agent, risky + approval | delegated + approved | 200 |

> Note: T5 and D6 deliberately reuse T4's exact request body with a different
> token — same call, different credential, different outcome. That is the
> demo's money shot.

### Known transient behavior

APIM → PAZ sideband calls occasionally fail on a cold connection (the fragment
surfaces this as `502 sideband-unavailable`). The harness retries 502s up to
three times; a persistent 502 means the sideband endpoint or shared secret is
misconfigured, not a policy failure.
