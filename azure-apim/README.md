# Azure API Management — Ping Authorize Sideband Integration

This folder contains the Azure API Management (APIM) integration that uses Ping
Authorize (self-hosted) or PingOne Authorize (cloud) as the centralized Policy
Decision Point (PDP) for MCP (Model Context Protocol) traffic, using the
**Sideband API**.

The gateway acts as the Policy Enforcement Point (PEP): it intercepts every MCP
call, forwards the original HTTP request to the authorization server's sideband
endpoint, and enforces the decision — permit, deny with a machine-readable
reason, or deny-with-challenge for human-in-the-loop flows.

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
    ├── test.md                           # testing: sample MCP, policies, local setup, harness
    └── policy-snapshot/                  # exported PAZ policy branch (import via Policy Editor)
        └── attributes.json … policysets.json
```

---

## 1. The APIM policy fragment

`src/authorize-sideband-fragment.xml` is an APIM inbound policy fragment named
**`AuthorizeSidebandAuthorization`**. The outer policy
(`src/authorize-sideband-policy.xml`) includes it in the inbound section:

The fragment is product-neutral: the sideband protocol is shared between
PingOne Authorize (cloud) and PingAuthorize (self-hosted), so the same policy
works against either, given different named values.

This is how the fragment works.

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
     whatever the server's Sideband API servlet extension is configured with
     — this integration uses `PDG-TOKEN`),
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



## Deploying in the APIM portal

### 1. Create the named values

APIM portal → your instance → **APIs → Named values → + Create**. Repeat for
each row (mark the client token as **secret** — check "Enable secret" /
"Yes" in the value step of the wizard):

| Named Value | Value |
|---|---|
| `AuthorizeSidebandRequestEndpoint` | Base URL of the authorization server **without** `/sideband/request`. Example (PingAuthorize): `https://paz.example.com` — the fragment appends the path. |
| `AuthorizeSidebandClientToken` (**secret**) | The sideband shared secret. On PingAuthorize this is a Sideband API Shared Secret; on PingOne Authorize it is the gateway credential. |
| `AuthorizeSidebandDebug` | `false` by default. Set `true` temporarily to get a redacted sideband request plus the full authorization response in error bodies. Remove before production. |

### 2. Create the policy fragment

APIM portal → **APIs → Policy fragments → + Create**:

1. **Name**: `AuthorizeSidebandAuthorization` (the fragment id the outer
   policy includes by name).
2. Paste the full contents of [`src/authorize-sideband-fragment.xml`](src/authorize-sideband-fragment.xml)
   into the fragment editor (APIM → APIs → Policy fragments → your new
   fragment → **Policies** tab).
3. **Save**.

### 3. Attach the fragment to your MCP server

The fragment is included by an outer policy file —
[`src/authorize-sideband-policy.xml`](src/authorize-sideband-policy.xml),
whose entire job is `<include-fragment fragment-id="AuthorizeSidebandAuthorization" />`
in the inbound section.

APIM portal → **MCP Servers** → your MCP server → **Policies** → paste the
full contents of `src/authorize-sideband-policy.xml` → **Save**. Every MCP
call routed through that server now runs the sideband check before reaching
the backend MCP server.

This is also how the fragment is "pointed at the actual policies": it never
references policies directly — it POSTs the request context to the PAZ
sideband endpoint, and the **endpoint's `service` property** selects which
policy set evaluates (see the PAZ side configuration in
[`test/test.md`](test/test.md)).

### 4. Point at the authorization server

Make sure the `AuthorizeSidebandRequestEndpoint` named value reaches your
PingAuthorize server, the shared secret value matches the one configured
server-side (`Sideband API Shared Secret`), and the header name in the
fragment (`PDG-TOKEN`) matches the server's
`shared-secret-header-name`.

---

The fragment is generic — it authorizes *whatever MCP traffic flows through
the MCP server it is attached to*, against whatever policies your PAZ
evaluates for that service. What those policies actually decide, and the
sample MCP server they guard, is the subject of the test guide:

**➡️ Continue with [`test/test.md`](test/test.md)** — it walks through the
sample mortgage MCP server, the test policies (importable from
`test/policy-snapshot/`), the full local setup (PAZ, ngrok, APIM), the
14-test matrix, and how to inspect the decisions.
