# Design — agentgateway K8s deployment (self-contained stack)

Date: 2026-10-14
Status: draft for review
Supersedes: the "out of scope / next phase" note in `agentgateway/README.md`

## 1. Goal

Deploy the complete agentgateway ⇄ Ping Authorize stack as a **self-contained
Kubernetes deployment**: a single Helm umbrella chart that brings up the PAZ
policy stack (PAZ + PAP + PingDirectory), the paz-extauthz-adapter,
agentgateway, and the demo-mcp backend — bootstrap of policies, token
validator, and sideband endpoint fully automated via standard Ping server
profiles committed in this repo. Minimal public surface: only the agentgateway
MCP endpoint and the PAP UI are exposed through the cluster's NGINX ingress.

Target cluster: the user's dev cluster (context `ping-devops-aws-eu-west-1-oidc`),
namespace `ping-devops-fcarbone`, ingress class `nginx-public`, TLS via the
`letsencrypt-pdo` cert-manager ClusterIssuer (all verified live).

Success criteria:

- `helm install` (plus DNS records for two new hosts) produces a working
  stack with **zero manual PAZ/PAP configuration**.
- The existing 19-test policy matrix passes against the deployed stack by
  re-running `agentgateway/test/policy-e2e-tests.sh` with env overrides.
- No policy content or secrets live anywhere but this repo (policies) and
  the cluster (secrets).

## 2. Decisions taken during design (with the user)

| Decision | Choice |
|---|---|
| PAZ source | **B — self-contained**: the chart deploys its own PAZ/PAP/PingDirectory; not the shared `id4ai-control-plane` release |
| Bootstrap mechanism | **Standard Ping server profiles**, profiles live in this repo (the user's explicit requirement) |
| Images | demo-mcp and adapter built in-repo and published to Docker Hub (`carbonefederico/demo-mcp:1.0.0`, `carbonefederico/paz-extauthz-adapter:1.0.0`, both pushed 2026-10-14); agentgateway uses the official `ghcr.io/agentgateway/agentgateway:v1.6.0` (distroless, entrypoint `/app/agentgateway`, validated against our config) |
| Public surface | **Minimal**: AG MCP endpoint + PAP UI public; PAZ, PingDirectory, demo-mcp, adapter, AG UI cluster-internal |
| AG management UI | **Port-forward access only** (`kubectl port-forward svc/... 15000:15000`), no ingress |
| Hostnames | `agentgateway-stack-ag.ping-devops.com`, `agentgateway-stack-pap.ping-devops.com` |
| Namespace | `ping-devops-fcarbone` (existing; LB/cert pattern proven there) |
| PingDataConsole | Not deployed (PAP UI suffices; one less public surface) |

## 3. Topology

```
NGINX ingress (class nginx-public, TLS via cert-manager letsencrypt-pdo)
  ├── agentgateway-stack-ag.ping-devops.com  → AG :3001      (HTTP backend)
  └── agentgateway-stack-pap.ping-devops.com → PAP :8443     (HTTPS backend)

cluster-internal (ClusterIP services, no ingress):
  AG extAuthz  → adapter :8082 (gRPC, Envoy ext_authz Authorization/Check)
  AG /mcp      → demo-mcp :3000 (/mcp/portfolio)
  adapter      → PAZ :443 (sideband /sideband/request, in-cluster DNS)
  PAZ          → PAP :8443 (policy evaluation, external PDP mode)
  PAZ          → PingDirectory (LDAP/LDAPS)
  (operator)   → AG :15000 via kubectl port-forward (management UI)
```

## 4. Chart layout

```
agentgateway/k8s/
├── helm/
│   └── agentgateway-stack/
│       ├── Chart.yaml                 # umbrella; dependency ping-devops 0.15.0
│       ├── values.yaml                # defaults (dev posture)
│       └── templates/
│           ├── agentgateway.yaml      # Deployment + Service + ConfigMap (config)
│           ├── adapter.yaml           # Deployment + Service (+ cert bootstrap)
│           ├── demo-mcp.yaml          # Deployment + Service
│           ├── ingress.yaml           # two hosts (AG + PAP)
│           ├── certificates.yaml      # cert-manager Certificate resources
│           └── secrets.yaml           # sideband secret (generated at install)
├── server-profiles/
│   ├── pingauthorize/
│   │   └── pd.profile/dsconfig/
│   │       └── 40-agp.dsconfig.subst  # jwt-lab validator + sideband secret/endpoint
│   └── pingauthorizepap/
│       └── policies/
│           └── Portfolio MCP policies.full-branch.SNAPSHOT
└── README.md                          # deploy + verify guide (K8s section)
```

The PAZ→PAP wiring (`create-external-server pingauthorizepap`, `pdp-mode:
external`, trust-framework v2) comes from the **stock**
`paz-pap-integration/pingauthorize` profile, layered as
`SERVER_PROFILE_PARENT` — not duplicated. Our profile layer only adds what
the stock one lacks (jwt-lab, sideband).

## 5. PAZ stack (Ping chart dependency)

`ping-devops` 0.15.0 as a Chart.yaml dependency; enabled products and key
values:

- **pingauthorize** (StatefulSet) — profile:
  - `SERVER_PROFILE_URL` → this GitHub repo
    (`https://github.com/carbonefederico/ai-mcp-gateways-paz-integrations.git`),
    `SERVER_PROFILE_PATH=agentgateway/k8s/server-profiles/pingauthorize`
  - `SERVER_PROFILE_PARENT=PAZ`, `SERVER_PROFILE_PAZ_URL=…pingidentity-server-profiles.git`,
    `SERVER_PROFILE_PAZ_PATH=paz-pap-integration/pingauthorize` (PAP wiring + baseline)
  - `container.waitFor.pingdirectory: ldaps`
- **pingauthorizepap** (StatefulSet) — profile: our repo
  (`…/server-profiles/pingauthorizepap`); the `policies/*.SNAPSHOT` file is
  auto-imported as a new branch at first startup (standard PAP mechanism).
- **pingdirectory** (StatefulSet) — stock `baseline/pingdirectory`.
- Global: `PING_IDENTITY_ACCEPT_EULA=YES`; the Ping subchart's own ingress
  mechanism renders **both** public ingresses (`global.ingress` values +
  per-product `ingress.hosts`) — one Ingress owner, the Ping chart, and
  cert-manager Certificate resources are templated by our umbrella chart
  (the Ping chart doesn't know about cert-manager). The AG ingress (non-Ping
  workload) is templated by our umbrella chart directly.
- Dev credentials: the standard Ping DevOps default (`2FederateM0re` /
  `N0Password!` conventions) via `global.envs` — consistent with the rest of
  the user's cluster. Flagged in the README: dev-only posture, rotate for
  anything sensitive.

### 5.1 Our PAZ profile layer — `40-agp.dsconfig.subst`

Runs at PAZ first start (`.subst` = env-substituted dsconfig script):

```bash
# jwt-lab as the demo authorization server + JWT token validator
dsconfig create-external-server --server-name JWT-Lab --type http \
  --set base-url:https://jwt-lab-beta.vercel.app \
  --set hostname-verification-method:strict
dsconfig create-access-token-validator --validator-name JWT-Lab --type jwt \
  --set authorization-server:JWT-Lab \
  --set jwks-endpoint-path:/.well-known/jwks.json \
  --set allowed-signing-algorithm:RS256 --set evaluation-order-index:1000
dsconfig set-access-token-validator-prop --validator-name JWT-Lab --set enabled:true

# sideband shared secret + endpoint for the adapter
dsconfig set-http-servlet-extension-prop --extension-name "Sideband API" \
  --set shared-secret-header-name:PDG-TOKEN --add "shared-secrets:AGENTGATEWAY-SIDEBAND"
dsconfig create-sideband-api-shared-secret --secret-name AGENTGATEWAY-SIDEBAND \
  --set "shared-secret:${SIDEBAND_SHARED_SECRET}"
dsconfig create-sideband-api-endpoint --endpoint-name "AgentGateway Portfolio MCP" \
  --set service:"AgentGateway Portfolio MCP" \
  --set access-token-validator:JWT-Lab \
  --set base-path:/mcp
```

- `${SIDEBAND_SHARED_SECRET}` is injected into the PAZ pod env from the
  chart-created K8s Secret via `container.env` + `valueFrom` (Ping chart
  mechanism, verified in chart 0.15.0 values: `container.env` supports
  `valueFrom`).
- `base-path:/mcp` must match the client-facing path the adapter forwards —
  AG serves MCP at `/mcp` (confirmed live in the current integration;
  handoff note: base-path was moved from `/portfolio` to `/mcp`).
- Idempotency: first-start only by design (server profile semantics); the
  file mirrors the commands already proven live in the cluster.

### 5.2 Full-branch PAP snapshot (new artifact)The existing `test/policy-snapshot/Portfolio MCP policies.snapshot` is
**set-only** (built for merging into a branch that already has a Global
Decision Point and Token Validation). A fresh PAP needs a full branch.

`test/policy-snapshot/build-portfolio-snapshot.mjs` gains a `--full-branch`
mode that emits, alongside the merge variant:

`agentgateway/k8s/server-profiles/pingauthorizepap/policies/Portfolio MCP
policies.full-branch.SNAPSHOT` containing: the `AgentGateway Portfolio MCP`
service + policy set, the six policies with rules/statements, the two
attributes, **plus** a Token Validation policy set wrapping the JWT-Lab
validator and a **Global Decision Point** whose children are
`[Token Validation, AgentGateway Portfolio MCP]`.

The GDP id is **fixed** (hardcoded UUID in the generator, not random) so the
PAZ profile layer and the snapshot always agree. The PAZ→PAP external-server
`branch:` / `decision-node:` values (from the stock `30-pap.dsconfig.subst`,
substituted via its env contract) point at this branch name and GDP id;
`SERVER_PROFILE_*` env additions in the values pass them through.

The merge-variant snapshot and its live-cluster import flow remain
untouched (they document the shared-cluster story).

## 6. Non-Ping workloads (templates in the umbrella chart)

### 6.1 adapter — `carbonefederico/paz-extauthz-adapter:1.0.0`

- Deployment, 1 replica, non-root (image runs as `node`), resources modest
  (128Mi request / 512Mi limit).
- Env: `SERVICE_URL=https://agentgateway-stack-pingauthorize:443`
  (in-cluster ClusterIP DNS), `SECRET_HEADER_VALUE` ← sideband K8s Secret,
  `LISTEN_PORT=8082`, `SIDEBAND_TIMEOUT_MS=5000`, `DEBUG_LOGGING=false`.
- Service `adapter` (ClusterIP) exposing 8082; consumed only by AG's
  extAuthz policy — never via ingress.
- Probes: gRPC liveness/readiness on `/envoy.service.auth.v3.Authorization/Check`
  (native gRPC probes; the app speaks the protocol).
- **TLS trust for the sideband call (design detail caught late):** PAZ
  presents a self-signed certificate, and the adapter's `fetch` verifies TLS
  by default. Mechanism: an init container in the adapter pod (image
  `pingidentity/pingtoolkit` or `alpine + openssl` — already pulled by the
  chart) waits for the PAZ service to accept TLS, extracts the served
  certificate into a shared `emptyDir` volume, and the adapter container sets
  `NODE_EXTRA_CA_CERTS=/certs/paz.crt`. If PAZ's cert is PVC-persistent (it
  is — StatefulSet out-dir), the extracted trust file stays valid across PAZ
  restarts; the init container re-extracts on every adapter start anyway, so
  PAZ cert rotation self-heals on adapter restart. Preference: use the
  chart's `global.privateCert.generate` mechanism if it yields a usable PEM
  CA at install time (mount secret, no runtime extraction); fall back to
  init-container extraction otherwise.

### 6.2 agentgateway — `ghcr.io/agentgateway/agentgateway:v1.6.0`

**Deployment-pattern choice: standalone mode with config-in-git (the GitOps
pattern), not controller mode.** agentgateway's two run modes are not
prod-worthiness tiers — standalone with the config managed in git is the
same class of pattern as nginx (static conf in a ConfigMap), Envoy (static
bootstrap), or Kong DB-less (declarative yaml), all ubiquitous in
production. The GitOps loop is: PR → merge → `helm upgrade` → pod rolls;
byte-identical local/prod config; every change reviewable in git; no
controller to install or break. Controller mode (CRDs + operator) is the
*platform* pattern — its advantage is reconciliation without restarts and
CRD status, which pays off with many gateways and multiple teams writing
routing/policy config. For a single gateway owned by one team, that is
speculative scale. Trade accepted: every config change is a (brief) pod
restart, dropping in-flight SSE connections. If the deployment later grows
into a fleet, the adapter carries over untouched — it speaks the vendored
Envoy `Authorization/Check` contract, which both modes consume.

- Deployment, 1 replica, resources 256Mi/512Mi.
- Config: ConfigMap `agentgateway-config` mounted read-only; args:
  `-f /config/agentgateway.yaml`. Content = the existing
  `src/agentgateway.yaml` with three deltas:
  - MCP target host: `http://agentgateway-stack-demo-mcp:3000/mcp/portfolio`
  - extAuthz host: `agentgateway-stack-adapter:8082`
  - metadata route: backend `agentgateway-stack-demo-mcp:3000`;
    `x-client-host: agentgateway-stack-ag.ping-devops.com`;
    `x-client-proto: https` (public TLS terminates at NGINX)
- `statefulMode: stateless` stays; `failureMode: deny` stays; the 64 KiB
  body cap and 5s callout budget stay.
- Service `agentgateway` (ClusterIP): ports 3001 (MCP), 15000 (UI, internal
  only).
- Probes: the image is distroless (no shell, no curl) — HTTP readiness +
  liveness probes on `/mcp` port 3001; any response (including 401) proves
  the listener lives. No gRPC probe possible on 15000/3001 beyond HTTP.

### 6.3 demo-mcp — `carbonefederico/demo-mcp:1.0.0`

- Deployment, 1 replica, resources 256Mi/512Mi.
- Env: `PORT=3000`, `ALLOWED_HOSTS` unset (accepts in-cluster hostnames),
  `OAUTH_ENABLED` unset (enforcement is at the gateway — same deliberate
  demo posture as local, documented in test.md).
- Service `demo-mcp` (ClusterIP): 3000. No ingress.
- Probes: HTTP `/health` (the endpoint exists and returns 200 + JSON).

## 7. Ingress + TLS

Two Ingress objects (one per host, class `nginx-public`), templated by us:

| Host | Service | Backend protocol | Annotations |
|---|---|---|---|
| `agentgateway-stack-ag.ping-devops.com` | agentgateway:3001 | HTTP | `proxy-buffering: off` (SSE), `proxy-body-size: 8m`, `proxy-read-timeout: 3600` (long-lived MCP/SSE) |
| `agentgateway-stack-pap.ping-devops.com` | PAP:8443 | HTTPS | as existing cluster ingresses |

TLS: one `Certificate` per host, `issuerRef: letsencrypt-pdo` (ClusterIssuer,
same as the user's `agentless-mcpgw` workload), secret names
`agentgateway-stack-ag-tls` / `agentgateway-stack-pap-tls`; cert-manager
solves HTTP-01 on the ingress hosts.

**Deploy-time prerequisite (operator step, documented in the README):** DNS
records for the two new hosts → the cluster's `ping-devops.com` NLB
(`aa1deecbf55244617839c90d58862848-…elb.eu-west-1.amazonaws.com`), same as
every existing ingress host in the namespace. Everything else is automated.

Ingress ownership: the Ping subchart renders the PAP ingress via its own
`global.ingress`/per-product values; our umbrella chart templates the AG
ingress. cert-manager `Certificate` resources for **both** hosts come from
our umbrella chart (§7 table).

## 8. Secrets

| K8s Secret | Keys | Consumed by | Source |
|---|---|---|---|
| `agentgateway-stack-sideband` | `SECRET_HEADER_VALUE` (random, generated at install) | adapter (env), PAZ (env → `.subst` substitution) | `templates/secrets.yaml` (Helm `randAlphaNum`) |
| Ping default DevOps credentials | admin passwords | PAZ/PAP/PD (chart conventions) | `global.envs` (dev posture; README flags rotation) |

`SECRET_HEADER_VALUE` must be identical on both sides — hence one secret,
referenced by both workloads via `container.env.valueFrom.secretKeyRef`
(PAZ) / plain `env.valueFrom` (adapter). Nothing secret lands in git or in
ConfigMaps.

## 9. Testing & verification

1. **Render**: `helm template` / `helm lint` locally.
2. **Install**: `helm install agentgateway-stack -n ping-devops-fcarbone` +
   add the two DNS records.
3. **Bootstrap verification**: PAP UI (public host) shows the imported
   `Portfolio MCP policies.full-branch` branch with the GDP wiring; PAZ
   decision audit (pod logs / PAP API) shows service
   `AgentGateway Portfolio MCP` on first test call.
4. **Helm test**: `helm test` hook pod (image with curl+jq, e.g.
  `pingidentity/pingtoolkit`) runs the core of the 19-test matrix against
  `http://agentgateway-stack-agentgateway:3001/mcp` in-cluster — tokenless
  401, read 200, low-risk write 200, 50k-order 403 `approval_required`,
  adapter-outage 403 (fail-closed) as the essential five; full matrix
  remains the laptop-side suite.
5. **Full matrix from laptop**: existing script unchanged, env-overridden:
   `AG_URL=https://agentgateway-stack-ag.ping-devops.com/mcp
   AUD=https://agentgateway-stack-ag.ping-devops.com
   ./policy-e2e-tests.sh` → expect 19/19.
6. **Unit suite**: `npm test` (33 tests) unaffected; adapter Dockerfile
   smoke-tested (done at image build time).

## 10. Out of scope

HA/autoscaling, mTLS between components, production secret management
(Vault/CSI), PingDataConsole, telemetry beyond stdout, PAZ license
procurement (dev runs on Ping DevOps eval images; production needs a real
license), multi-environment values promotion.
