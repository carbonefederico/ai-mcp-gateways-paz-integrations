# Testing — the mortgage MCP demo, end to end

This guide covers everything needed to reproduce the tested integration:
the sample MCP server, the PAZ policies that authorize it, the local setup,
and how to run and inspect the tests.

> **Security disclaimer — the demo MCP server is intentionally open.** The
> demo-mcp backend in this guide runs with `OAUTH_ENABLED` unset, so it
> accepts unauthenticated calls. That is deliberate: this demo focuses
> exclusively on the **APIM ↔ Ping Authorize integration**, so all
> enforcement happens at the gateway. In a real environment the MCP server
> would not be open — APIM (or the caller) would need to obtain tokens via
> token exchange / client credentials and present them to the backend, and
> the backend would validate them itself. Defense in depth, not a single
> gate.

## The sample MCP server

The policies guard a **demo mortgage MCP server** —
[`carbonefederico/demo-mcp`](https://github.com/carbonefederico/demo-mcp),
a synthetic banking backend exposing four tools:

| Tool | What it does | Risk |
|---|---|---|
| `get_mortgage_summary` | Retrieve a customer's mortgage summary | read |
| `calculate_affordability` | Affordability calculation | read |
| `generate_rate_quote` | Generate a rate quote | read |
| `submit_mortgage_change_request` | Submit a servicing change (`changeType`: `PAYMENT_DATE`, `TERM_CHANGE`, `RATE_SWITCH`, `OVERPAYMENT`) | write, risk-tiered by `changeType` |

`PAYMENT_DATE` (moving a due date) is treated as low risk; the other three
are economically risky and require human approval — this distinction is what
the HITL policies encode.

## Prerequisites

1. **A PingAuthorize + PingAuthorize PAP deployment** (the standard Ping
   DevOps Helm chart works), already running in PDP mode `external` — PAZ
   serves the sideband API and delegates decisions to the PAP (Policy
   Editor). If yours is a fresh install, section 1.1 sets that up.
2. **Node.js ≥ 22**
3. `ngrok` (free account), `curl`, `jq`.
4. **An Azure APIM instance** (portal access; the MCP server is created in the portal).

## 1. Configure the PAZ server

All `dsconfig` commands run against the **PAZ** server (`--no-prompt` shown;
`--hostname/--port/bindDN` omitted for brevity).

### 1.1 Only for a fresh install: point PAZ at the PAP (external PDP mode)

Skip this if your deployment already runs `pdp-mode: external` (check with
`dsconfig get-policy-decision-service-prop`). On a fresh install the Ping
DevOps chart's default profile usually wires PAZ→PAP already; verify the
`base-url` and `shared-secret` match your environment rather than re-running
`create-external-server` (it fails if the server already exists — use
`set-external-server-prop` instead).

```bash
# The policy server PAZ pulls decisions from. Replace the base-url with your
# PAP host; shared-secret must match the PAP's admin API credential.
dsconfig --no-prompt create-external-server \
  --server-name pingauthorizepap \
  --type policy \
  --set "base-url:https://pap-host:8443" \
  --set "hostname-verification-method:allow-all" \
  --set "key-manager-provider:Null" \
  --set "trust-manager-provider:Blind Trust" \
  --set "shared-secret:2FederateM0re"

dsconfig --no-prompt set-policy-decision-service-prop \
  --set "pdp-mode:external" \
  --set "policy-server:pingauthorizepap" \
  --set "trust-framework-version:v2"
```

After the PAP is reachable (and after importing the snapshot in section 1.4),
repoint the external server at the branch that holds the imported policies
and the root decision node (the `Global Decision Point` policy set — find
its id under **Policy Editor → Policy Sets**, then):

```bash
dsconfig --no-prompt set-external-server-prop \
  --server-name pingauthorizepap \
  --set "branch:<the-branch-you-imported-the-policies-into>" \
  --set "decision-node:<global-decision-point-policyset-id>"
```

### 1.2 Token validator (jwt-lab for the demo)

```bash
# The authorization server the validator consults for JWKS:
dsconfig --no-prompt create-external-server \
  --server-name JWT-Lab \
  --type http \
  --set "base-url:https://jwt-lab-beta.vercel.app" \
  --set "hostname-verification-method:strict"

dsconfig --no-prompt create-access-token-validator \
  --validator-name JWT-Lab \
  --type jwt \
  --set "authorization-server:JWT-Lab" \
  --set "jwks-endpoint-path:/.well-known/jwks.json" \
  --set "allowed-signing-algorithm:RS256" \
  --set "evaluation-order-index:1000"

dsconfig --no-prompt set-access-token-validator-prop \
  --validator-name JWT-Lab \
  --set "enabled:true"
```

### 1.3 Sideband shared secret + endpoints

```bash
# The secret APIM presents; the header name must match what the fragment sends (PDG-TOKEN).
dsconfig --no-prompt set-http-servlet-extension-prop \
  --extension-name "Sideband API" \
  --set "shared-secret-header-name:PDG-TOKEN" \
  --add "shared-secrets:APIM-SIDEBAND"

dsconfig --no-prompt create-sideband-api-shared-secret \
  --secret-name "APIM-SIDEBAND" \
  --set "shared-secret:<generate-a-random-secret>"

# The sideband endpoint: base-path must match the APIM MCP server's public
# base path; service pins which policy set evaluates; validator validates
# the bearer token inside the envelope.
dsconfig --no-prompt create-sideband-api-endpoint \
  --endpoint-name "APIM Mortgage MCP" \
  --set "service:APIM Mortgage MCP" \
  --set "access-token-validator:JWT-Lab" \
  --set "base-path:/mortgage-mcp-local"
```

The `service` value must match a **service defined in the Policy Editor**
(Policy Editor → Services → create `APIM Mortgage MCP`). It is the glue
between path and policy set.

### 1.4 Import the policy snapshot (Policy Editor UI)

The demo policies ship as a ready-to-import snapshot:
[`policy-snapshot/Mortgage MCP policies.snapshot`](policy-snapshot/Mortgage%20MCP%20policies.snapshot)
— a `.snapshot` export of the Policy Editor branch holding the full policy
content (Trust Framework attributes, statements, rules, policies, and the
`APIM Mortgage MCP` policy set).

Import it through the Policy Editor web UI (this is the supported way to
move branch content between Policy Editor instances — a snapshot imports
as a new branch):

1. Open your Policy Editor → **Branch Manager → Version Control →
   Import Snapshot**.
2. Choose the `Mortgage MCP policies.snapshot` file.
3. Name the new policy branch it creates (the demo used `ID4AI Control
   Plane` — any name works).
4. Commit the branch's initial state when prompted.

Then point PAZ at that branch: in section 1.1's final `set-external-server-prop`,
use the branch name you just created and the `Global Decision Point`
policy set id of **the imported branch** (Policy Editor → Policy Sets).
In PDP-external mode the branch tip serves decisions immediately.

Verify the wiring before testing: one authorized call through the gateway,
then check the PAP decision audit (`/opt/out/instance/logs/decision-audit.log`)
— `request.service` must read `APIM Mortgage MCP` (not `Default`), and the
evaluation log should show the full policy chain.

## 2. Run the demo MCP locally

```bash
git clone https://github.com/carbonefederico/demo-mcp
cd demo-mcp
npm install
npm run dev          # listens on :3000
```

For the tunnel test, run it on a port you own:

```bash
PORT=3010 npm run dev
# health check:
curl http://localhost:3010/health
```

(Leave `OAUTH_ENABLED` unset — the local MCP accepts all calls; authorization
is enforced by PAZ at the APIM layer, which is the point of the demo.)

## 3. Expose it via ngrok

```bash
ngrok http 3010
# note the https URL, e.g. https://<random>.ngrok-free.dev
```

Verify from outside:

```bash
curl -s -X POST https://<random>.ngrok-free.dev/mcp/mortgage \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -H "ngrok-skip-browser-warning: 1" \
  -d '{"jsonrpc":"2.0","method":"tools/list","id":1}'
```

## 4. Expose the MCP server in Azure APIM (portal)

APIM has a native **MCP server** resource type — use it (it wraps the backend
MCP endpoint and gives the MCP-specific management surface).

**APIM portal → APIs → MCP servers (Preview) → + Create MCP server →
Expose an existing MCP server**, with these values (the exact configuration
used for the local demo):

| Field | Value | Notes |
|---|---|---|
| **MCP server base url** | `https://<random>.ngrok-free.dev/mcp/mortgage` | The **full backend MCP endpoint** — tunnel + MCP route. This is where APIM proxies MCP traffic. |
| **Display name** | `Mortgage MCP Local` | Label in the portal. |
| **Name** | `mortgage-mcp-local` | Resource name. |
| **Base path** | `/mortgage-mcp-local` | The public path. The exposed MCP URL becomes `https://<apim>.azure-api.net/mortgage-mcp-local/mcp/mortgage`. |
| **Products** | *(none for the demo)* | Products control subscription requirements — leave empty to call without a subscription key. |

The resulting client-facing URL (with `<your-apim>` being your instance's
hostname, e.g. `https://apimid4ai.azure-api.net` in this demo's
environment) is:

```
https://<your-apim>.azure-api.net/mortgage-mcp-local/mcp/mortgage
```

The PAZ sideband endpoint (section 1.3) must have a `base-path` that matches
the APIM MCP server's **base path** — it is the path PAZ matches incoming
envelopes on. If you named your base path `/mortgage-mcp-local` as above,
the endpoint's `base-path` from 1.3 already matches; if you chose a
different one, update the endpoint accordingly.

Sideband endpoints match on path prefix; a path that matches no endpoint
falls through to the **Default service**, whose generic policy set (token
validation only) permits any valid token — your MCP-specific policies never
evaluate. This is a silent security hole, not a routing error.

Verify the mapping: make one authorized call and check `request.service` in
the PAP decision audit log — it must read `APIM Mortgage MCP`, not `Default`.

Then attach the authorization layer:

1. **Named values** (APIM → APIs → Named values — shared across the instance,
   create once):
   - `AuthorizeSidebandRequestEndpoint` = your PAZ sideband base URL, e.g.
     `https://paz.example.com`
   - `AuthorizeSidebandClientToken` (**secret**) = the sideband shared secret value
   - `AuthorizeSidebandDebug` = `true` (helpful for first runs; turn off later)
2. **Policy fragment**: APIs → Policy fragments → **+ Create** →
   name `AuthorizeSidebandAuthorization`, paste the contents of
   [`src/authorize-sideband-fragment.xml`](../src/authorize-sideband-fragment.xml).
3. **Attach the fragment to the MCP server**: open the MCP server
   (`mortgage-mcp-local`) → **Policies** → paste
   [`src/authorize-sideband-policy.xml`](../src/authorize-sideband-policy.xml)
   (the outer policy that includes the fragment in its inbound section).
4. **Token validation on PAZ**: the sideband endpoint's access-token-validator
   must accept your test tokens. For jwt-lab, configure a JWT validator with
   issuer `https://jwt-lab-beta.vercel.app` and JWKS path
   `/.well-known/jwks.json`, allowed algorithm RS256.

Sanity check before testing — a tokenless call must be **rejected** once the
fragment is attached (PAZ denies the missing token):

```bash
curl -s -X POST "https://<apim>.azure-api.net/mortgage-mcp-local/mcp/mortgage" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","method":"tools/list","id":1}' -w "\n%{http_code}"
# expect 401; a 200 here means the fragment is not attached to the MCP server
```

## 5. Run the tests

The demo uses **jwt-lab** (`https://jwt-lab-beta.vercel.app`) as the
authorization server: a public token playground that mints real RS256-signed
JWTs from any claims you supply, and publishes its JWKS so PAZ can validate
them like production tokens. It plays two roles here:

- **The trusted issuer (AS)** for all scenario tokens — the PAZ
  `JWT-Lab` validator trusts its issuer/JWKS, so minted tokens pass real
  signature, expiry and issuer validation.
- **The transaction-token service (TTS)** in the HITL flow: the "human
  approval" step is modeled as the AS minting a token that carries the
  approval and the transaction context (`approved_for` + `tctx`) after the
  step-up — mirroring the draft-ietf-oauth-transaction-tokens model, with
  the token-exchange output conveyed in the access token.

The test harness mints every scenario token from jwt-lab on the fly (no
presets — claims are spelled out per scenario), runs the matrix below, and
retries the rare transient APIM→PAZ 502s. To run against a different issuer,
swap the PAZ validator's `authorization-server`/JWKS and the harness's
`JWT_LAB` env var.

```bash
cd azure-apim/test
APIM_URL=https://<your-apim>.azure-api.net/mortgage-mcp-local/mcp/mortgage \
AUD=https://<your-apim>.azure-api.net \
./policy-e2e-tests.sh
```

## 6. Inspect results

**Script output**: 14 PASS lines + `Result: 14 passed, 0 failed`. Any FAIL
means either the policies or the APIM wiring — check which stage produced the
wrong status (401 = token validation, 403 = policy, 502 = sideband transport).

**Recent decisions on PAZ**: the PAP decision audit log shows every evaluation
with full context, statements and the evaluation trace:

```bash
# on the PAP pod / host:
tail -1 /opt/out/instance/logs/decision-audit.log | python3 -m json.tool
```

Fields worth eyeballing:
- `decision` — PERMIT / DENY
- `statements[]` — the machine-readable denial reasons (e.g.
  `approval_required`, `delegation_not_permitted`)
- `evaluationLog[]` — rule-by-rule trace: which policy matched, which
  attributes were resolved (`HttpRequest.AccessToken.tctx_*`,
  `MCP Change Type`, …) and their timings
- `request.attributes` — exactly what the sideband envelope carried (token,
  headers, body), redacted only if you configured it so

In the Policy Editor web UI: **Decision Audit / Testing** shows the same trace
graphically — useful for demos (watch the FirstApplicable order walk down the
policy set until one rule fires).

## 7. What the policies actually enforce

The imported policy set (`APIM Mortgage MCP`, evaluated FirstApplicable —
first policy to match wins) layers four independent controls over a single
tool, `submit_mortgage_change_request`:

| # | Policy | What it does | Outcome |
|---|---|---|---|
| 1 | **Allow Session Methods** | Lets through MCP session plumbing (`initialize`, `tools/list`, `ping`) — no token scopes needed. | PERMIT |
| 2 | **Allow Delegated Token by VIP Users Only** | If the call is delegated (RFC 8693 `act.sub` present = an agent is acting for a user) and that user is not `vip_user`, deny. Direct users (no `act`) are untouched. | DENY `delegation_not_permitted` |
| 3 | **Allow read operations** | Permits the read tools (`get_mortgage_summary`, `calculate_affordability`, `generate_rate_quote`) when the token carries `mortgage:read`. | PERMIT |
| 4 | **Allow low risk changes** | Permits `changeType=PAYMENT_DATE` (renaming a due date — no economic risk) on `mortgage:write`. No human needed. | PERMIT |
| 5 | **Deny High Risk Changes Without HITL** | For economically risky changes (`RATE_SWITCH`, `TERM_CHANGE`, `OVERPAYMENT`): if the token does **not** carry an approval whose transaction context mirrors this exact payload, deny with a machine-readable challenge. | DENY 403 `approval_required` |
| 6 | **Allow High Risk Changes with HITL** | Permits risky changes **only** when the token's transaction claims match the payload claim-by-claim (see HITL below). | PERMIT |
| 7 | **Default Deny** | Everything else — unknown tools, wrong scopes, anything unmatched. | DENY |

(Plus the global **Token Validation** policy ahead of all of these: expired,
badly signed or wrong-issuer tokens are rejected 401 before any MCP logic.)

### The four controls, and the HITL logic

**a) Scopes are capability classes, not permissions.** Tokens carry coarse
scopes (`mortgage:read`, `mortgage:write`); the policies map tools onto
those classes. Adding a new tool never requires re-issuing tokens — one
policy edit maps it to a class.

**b) Risk lives in the payload, not the tool.** The same tool call is
permitted or challenged based on the *argument* `changeType`, parsed from
the JSON-RPC body by a JSONPath attribute (`MCP Change Type`). Tool-level
authorization alone would be too coarse: paying a mortgage date vs.
switching the rate are both "a write" but not both acceptable without a
human.

**c) Human-in-the-loop is deny-then-challenge, then re-authorization.** A
PDP decision is synchronous — it cannot pause for a human. So the risky
path works as a two-phase loop:

1. The agent submits a risky change → policy 5 **denies 403** with
   `{"message": "approval_required", ...}`. Nothing executed.
2. A human approves (in a portal). The AS performs the approval step-up and
   issues a new short-lived transaction token whose claims mirror **the
   exact approved transaction**:

   ```json
   {
     "approved_for": "submit_mortgage_change_request",
     "tctx": {
       "tool": "submit_mortgage_change_request",
       "changeType": "TERM_CHANGE",
       "mortgageId": "MORT-90001",
       "requestedValue": "30 years"
     }
   }
   ```

   This follows the transaction-token idea
   ([draft-ietf-oauth-transaction-tokens](https://datatracker.ietf.org/doc/html/draft-ietf-oauth-transaction-tokens)):
   the AS mints short-lived, narrowly scoped tokens whose `tctx` carries
   the signed transaction details that downstream authorization compares
   against. In this demo the transaction claims are conveyed **inside the
   access token itself** (as if the AS had minted it after the approval
   step-up), rather than in a separate `Txn-Token` header.
3. The agent retries the **identical call** with that token. Policy 6
   compares every `tctx` claim against the payload, attribute-to-attribute:
   `tctx.tool == MCP Tool Name`, `tctx.changeType == MCP Change Type`,
   `tctx.mortgageId == MCP Mortgage Id`. Any drift — a different change
   type, a different mortgage — breaks the mirror and policy 5 denies
   again. Same call + token without approval → 403; same call + approval
   token → 200. The enforcement point never changes; only the credential
   does.
4. The approval is **purpose-bound and short-lived**. It isn't a blanket
   capability: replaying the token against a different mortgage is denied
   (the mirror breaks), and expiry is the revocation. (Production
   hardening — beyond the demo: the backend should reject a transaction
   context it never issued, and a spent `jti`/transaction id should not be
   redeemable twice.)

**d) Delegation is a first-class gate.** Classic token-exchange tokens
carry the human in `sub` (+ a `sub_type`, e.g. `vip_user`) and the acting
agent in `act.sub`. Policy 2 enforces "only VIP subjects may be operated
via the delegated agent": a `standard_user` behind the same
`customer_support_agent` gets `403 delegation_not_permitted`, while direct
(non-delegated) users are untouched. Agent identity is thus *evaluated*,
not just logged.

### Denials are machine-readable

Every deny carries a `denied-reason` statement the gateway relays to the
client, so an MCP agent can *react* to authorization rather than just
fail: `approval_required` triggers the human-approval loop,
`delegation_not_permitted` tells the agent the subject may not use this
agent, and token failures surface as 401.
