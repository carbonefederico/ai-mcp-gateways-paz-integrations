# agentgateway — Ping Authorize Sideband Integration

This folder contains the [agentgateway](https://agentgateway.dev/) (standalone
binary) integration that uses Ping Authorize (self-hosted) or PingOne
Authorize (cloud) as the centralized Policy Decision Point (PDP) for MCP
(Model Context Protocol) traffic, using the **Sideband API**.

The gateway acts as the Policy Enforcement Point (PEP): it intercepts every
MCP call, its extAuthz policy forwards the call context to a small adapter,
the adapter POSTs the original request to the authorization server's sideband
endpoint, and the decision — permit, deny with a machine-readable reason, or
deny-with-challenge for human-in-the-loop flows — is enforced, fail-closed.

---

## Folder layout

```
agentgateway/
├── README.md                          # this file
├── package.json                       # @grpc/grpc-js + @grpc/proto-loader; npm test / npm start
├── src/
│   ├── paz-extauthz-adapter.mjs       # the gRPC adapter (Envoy ext_authz ⇄ sideband)
│   ├── agentgateway.yaml              # agentgateway standalone config
│   └── proto/
│       ├── ext_authz.proto            # vendored from agentgateway 1.5.0 (do not modify)
│       └── shared_envoy.proto
└── test/
    ├── policy-e2e-tests.sh            # 19-test end-to-end policy matrix
    ├── test.md                        # testing: sample MCP, policies, local setup, tests
    ├── *.test.mjs                     # adapter unit + loopback tests (npm test)
    └── policy-snapshot/
        ├── Portfolio MCP policies.snapshot   # importable Policy Editor snapshot
        └── build-portfolio-snapshot.mjs      # regenerates the snapshot from the mortgage template
```

## Why an adapter exists at all

PAZ signals **deny with HTTP 200 + an embedded `response` object**;
agentgateway's extAuthz treats every 2xx from the authorization service as
**allow**. Pointing extAuthz straight at PAZ would pass every denial
silently. The adapter flips that encoding and builds the sideband envelope —
the same job the APIM policy fragment does inline, as a standalone service.

It speaks the **Envoy External Authorization gRPC protocol**
(`envoy.service.auth.v3.Authorization/Check` — the exact proto agentgateway
consumes, vendored from the installed binary's revision), which makes it
reusable with any Envoy-compatible PEP (agentgateway k8s mode, Istio) later.

## How the adapter works

1. **Extract the call context** from the `CheckRequest`: method, path,
   headers (Envoy's map — duplicates merged per the HTTP spec), body, and the
   real client source IP/port (a fidelity gain over the APIM fragment, which
   had to fake the source port).
2. **Build the sideband envelope** exactly as the APIM fragment does:
   headers as an array of single-key objects, body as a string, bare
   `http_version`, `source_port` as text.
3. **POST to `{SERVICE_URL}/sideband/request`** with the shared secret in the
   `PDG-TOKEN` header; on transport failure retry twice (one immediate, one
   after 1s — the decision probe is idempotent).
4. **Translate the decision**:

| PAZ says | Adapter CheckResponse | Client sees |
|---|---|---|
| 200, no `response` object | gRPC OK | normal MCP response |
| 200, `response` = deny | `DeniedHttpResponse` with PAZ's status/headers/body | PAZ denial (401/403, `WWW-Authenticate` challenge, JSON-RPC error `-32001`/`-32003`) |
| sideband unreachable ×3 | `DeniedHttpResponse` 502 `sideband-unavailable` | fail-closed |
| PAZ non-200 | `DeniedHttpResponse` 502 `sideband-error` | fail-closed |
| adapter down | gRPC error → agentgateway `failureMode: deny` | fail-closed |

On a deny without a body, the adapter synthesizes a JSON-RPC error envelope
(`-32001` for 401, `-32003` for 403) echoing the original JSON-RPC `id`, so
MCP clients can correlate the denial with their pending request. No
permit-on-error path exists anywhere in the chain.

## Configuration

The adapter reads environment variables (`.env` is loaded by `npm start`;
see [`.env.example`](.env.example)):

| Variable | Meaning | Default |
|---|---|---|
| `SERVICE_URL` | PAZ sideband base URL, **without** `/sideband/request` | — (required) |
| `SECRET_HEADER_VALUE` | sideband shared secret (sent as `PDG-TOKEN`) | — (required) |
| `SIDEBAND_TIMEOUT_MS` | per-attempt sideband call timeout | `5000` |
| `DEBUG_LOGGING` | redacted request/response diagnostics | `false` |
| `LISTEN_PORT` | adapter gRPC listen port | `8082` |

The gateway side is [`src/agentgateway.yaml`](src/agentgateway.yaml)
(routing-based mode, validated with `agentgateway --validate-only`):

- **`/portfolio`** — the MCP route: proxies
  `http://localhost:3000/mcp/portfolio` with the `extAuthz` policy attached
  (gRPC to `localhost:8082`, `failureMode: deny`, request body forwarded up
  to 64 KiB, 5s callout budget).
- **`/.well-known/oauth-protected-resource`** — plain HTTP passthrough to
  demo-mcp, which serves the RFC 9728 protected-resource metadata document;
  the route injects `X-Client-Host`/`X-Client-Proto` so the backend builds
  the client-facing `resource` identifier (RFC 8707). The same reason APIM
  needed a second, plain API for metadata.

Deliberate omissions, mirroring the APIM integration: **no
`mcpAuthentication`** (PAZ validates the bearer token from the envelope via
the sideband endpoint's token validator), no `backendAuth` (the demo backend
is open — see the disclaimer in `test/test.md`), no decision caching
(decisions depend on token + body; a cache key would be the whole request).

## Running locally

```bash
cd ~/Documents/projects/ai/demo-mcp && npm run dev        # 1. the MCP backend  :3000
cd agentgateway && cp .env.example .env && npm start      # 2. the adapter       :8082
/usr/local/bin/agentgateway -f src/agentgateway.yaml      # 3. the gateway       :3001
```

Then point an MCP client at `http://localhost:3001/portfolio`.

## Pointing at the policies

The adapter never references policies directly — it POSTs the request context
to the PAZ sideband endpoint, and the **endpoint's `service` property**
selects which policy set evaluates. The portfolio policy snapshot, the PAZ
sideband configuration, and the full test walkthrough are in
[`test/test.md`](test/test.md).

**➡️ Continue with [`test/test.md`](test/test.md)** — the sample mortgage-era
policies ported to the portfolio MCP (`amount`-tiered HITL with a six-field
transaction mirror), the PAZ setup, the local wiring, and the 19-test matrix.

## Out of scope / next phase

A full Kubernetes deployment. The adapter is container-runnable as-is
(`node src/paz-extauthz-adapter.mjs` + env vars); in k8s, agentgateway's
controller-mode `extAuth` policy and any Envoy/Istio PEP speak the same
vendored `Authorization/Check` contract this adapter implements.
