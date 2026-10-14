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

## Architecture

```mermaid
flowchart LR
    client["MCP clients"]
    agw["agentgateway — PEP<br/>:3001 /mcp"]
    adapter["paz-extauthz-adapter<br/>separate Node process<br/>gRPC :8083"]
    paz["Ping Authorize / PingOne Authorize<br/>Policy Decision Point (PDP)"]
    backend["MCP backend<br/>:3000"]

    client -- "MCP call" --> agw
    agw -- "extAuthz policy<br/>Authorization/Check" --> adapter
    adapter -- "sideband envelope<br/>POST /sideband/request<br/>(PDG-TOKEN)" --> paz
    paz -- "permit / deny /<br/>deny-with-challenge" --> adapter
    adapter -- "allow or PAZ denial" --> agw
    agw -- "on permit" --> backend
```

The adapter is **not** part of the agentgateway binary: it runs as its own
process (`npm start`), and agentgateway's extAuthz policy simply points at it
over gRPC on `:8083` (`LISTEN_PORT`). Locally the two run side by side, but
the adapter can be deployed anywhere reachable — it speaks the vendored Envoy
ext_authz contract, so any Envoy-compatible PEP can use it.

Fail-closed throughout: a sideband transport failure or non-200 PDP response
becomes a 502 (`sideband-unavailable` / `sideband-error`), and
`failureMode: deny` covers an adapter outage.

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
(simplified MCP mode — the top-level `mcp:` block, which is also the form
the management UI's MCP page reads and writes — validated with
`agentgateway --validate-only`):

- **`/mcp`** (and `/sse`) — the aggregated MCP endpoint: proxies
  `http://localhost:3000/mcp/portfolio` with `extAuthz` attached under
  `mcp.policies` (gRPC to `localhost:8083` — `LISTEN_PORT` in `.env`, the
  code default is 8082; `failureMode: deny`, request body forwarded up
  to 64 KiB, 5s callout budget).
- **`/.well-known/oauth-protected-resource`** — plain HTTP passthrough to
  demo-mcp, which serves the RFC 9728 protected-resource metadata document;
  the route rewrites the client-facing suffix to the backend's expected
  path and injects `X-Client-Host`/`X-Client-Proto` so the backend builds
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
cd agentgateway && cp .env.example .env && npm start      # 2. the adapter       :8083 (LISTEN_PORT)
/usr/local/bin/agentgateway -f src/agentgateway.yaml      # 3. the gateway       :3001
```

Then point an MCP client at `http://localhost:3001/mcp` (management UI at
`http://localhost:15000/ui`).

## Pointing at the policies

The adapter never references policies directly — it POSTs the request context
to the PAZ sideband endpoint, and the **endpoint's `service` property**
selects which policy set evaluates. The portfolio policy snapshot, the PAZ
sideband configuration, and the full test walkthrough are in
[`test/test.md`](test/test.md).

**➡️ Continue with [`test/test.md`](test/test.md)** — the sample mortgage-era
policies ported to the portfolio MCP (`amount`-tiered HITL with a six-field
transaction mirror), the PAZ setup, the local wiring, and the 19-test matrix.

## Kubernetes deployment (self-contained stack)

`k8s/helm/agentgateway-stack/` deploys the whole chain into a single
namespace: PAZ + PAP (Ping chart, StatefulSets, PAZ standalone with its
embedded store),
paz-extauthz-adapter, agentgateway (standalone mode, config from ConfigMap),
and demo-mcp. Policies, the jwt-lab token validator, and the sideband
endpoint bootstrap automatically from the server profiles in
`k8s/server-profiles/` (PAZ dsconfig layer + full-branch policy snapshot).
The snapshot is imported at first start, but **import alone is not live**:
the bootstrap imports it into its own branch and it must be merged into
SYSTEM and committed — a manual admin-API step, exactly sequenced in
[`k8s/server-profiles/pingauthorizepap/policies/README.md`](k8s/server-profiles/pingauthorizepap/policies/README.md).

Public surface: the AG MCP endpoint (`agentgateway-stack-ag.ping-devops.com`)
and the PAP UI (`agentgateway-stack-pap.ping-devops.com`), TLS via
cert-manager (`letsencrypt-pdo`). Everything else is cluster-internal.

Deploy (dev posture — `ping-devops.com` hosts, DevOps default credentials):

    cd k8s/helm/agentgateway-stack
    helm dependency update
    helm install agentgateway-stack . -n ping-devops-fcarbone

Operator steps: DNS records for the two hosts above → the cluster's
nginx-public NLB. TLS issues automatically once DNS resolves.

Verify:

    helm test agentgateway-stack -n ping-devops-fcarbone   # wiring: 401/200/reachable
    cd test && AG_URL=https://agentgateway-stack-ag.ping-devops.com/mcp \
      AUD=https://agentgateway-stack-ag.ping-devops.com ./policy-e2e-tests.sh   # 19/19

AG management UI: `kubectl port-forward -n ping-devops-fcarbone
deploy/agentgateway-stack-agentgateway 15000:15000` (loopback-only port —
never expose it; agentgateway docs forbid publishing the admin interface).

The full Kubernetes deployment is now in `k8s/` (self-contained stack, above).
