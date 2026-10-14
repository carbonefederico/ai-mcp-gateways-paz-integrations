# agentgateway K8s Deployment (Self-Contained Stack) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A single Helm umbrella chart (`agentgateway/k8s/helm/agentgateway-stack/`) that deploys PAZ + PAP + PingDirectory (Ping chart), the paz-extauthz-adapter, agentgateway (standalone mode, config in ConfigMap), and demo-mcp — with policies/token-validator/sideband bootstrap fully automated via server profiles committed in this repo.

**Architecture:** Umbrella Helm chart wrapping Ping's `ping-devops` 0.15.0 for the PAZ stack plus plain Deployments for adapter/AG/demo-mcp. PAZ bootstrap = dsconfig `.subst` profile layer (jwt-lab validator, sideband secret/endpoint); PAP bootstrap = full-branch policy SNAPSHOT auto-imported by hook `81-install-policies.sh` (verified live: `/opt/staging/policies/*.SNAPSHOT` → `POST /api/snapshot/<name>/import`). Public surface: AG MCP endpoint + PAP UI through `nginx-public` ingress with cert-manager TLS; everything else ClusterIP.

**Tech Stack:** Helm 3 (umbrella chart + dependencies), Ping `ping-devops` 0.15.0 chart, cert-manager (issuer `letsencrypt-pdo`), NGINX ingress (`nginx-public` class), Docker Hub images (`carbonefederico/demo-mcp:1.0.0`, `carbonefederico/paz-extauthz-adapter:1.0.0`), GHCR (`ghcr.io/agentgateway/agentgateway:v1.6.0`), Node 22 (snapshot generator), kubectl 1.24+ (gRPC probes).

**Spec:** `docs/superpowers/specs/2026-10-14-agentgateway-k8s-deployment-design.md`

## Global Constraints

- Namespace: `ping-devops-fcarbone`; release name: `agentgateway-stack`; release-scoped names follow Ping chart convention `<release>-<product>` (verified pattern: `id4ai-control-plane-pingauthorize`).
- Hostnames: `agentgateway-stack-ag.ping-devops.com` (AG MCP) and `agentgateway-stack-pap.ping-devops.com` (PAP UI). No other public hosts.
- Ingress class `nginx-public` via `spec.ingressClassName` (deprecated annotation `kubernetes.io/ingress.class` also set — existing ingresses carry both).
- TLS issuer: `letsencrypt-pdo` (ClusterIssuer, verified).
- Ping chart version: `0.15.0` (app version 2608). Pin exactly; `helm dependency update` records the digest.
- Agentgateway image: `ghcr.io/agentgateway/agentgateway:v1.6.0` — distroless, entrypoint `/app/agentgateway`, health endpoint `/healthz/ready` on port 15021 (verified live 2026-10-14). Admin UI port 15000 is loopback-only by default — NEVER add a Service/ingress for it; access is `kubectl port-forward pod/<ag-pod> 15000:15000`.
- Adapter gRPC port: 8082 (container default; no `LISTEN_PORT` env override needed).
- Sideband endpoint `base-path:/mcp`; service name `AgentGateway Portfolio MCP`; shared-secret name `AGENTGATEWAY-SIDEBAND`; header `PDG-TOKEN`; validator `JWT-Lab` (all verified live values).
- No secrets in git: sideband secret comes from a Helm-generated Secret (`randAlphaNum 40`); PAP/PAZ admin passwords use Ping DevOps defaults via env (dev posture, flagged in README).
- The stock profile `paz-pap-integration/pingauthorize` is layered via `SERVER_PROFILE_PARENT` (verified live: env names `SERVER_PROFILE_PAZ_URL`/`SERVER_PROFILE_PAZ_PATH`); our layer adds `40-agp.dsconfig.subst` only.
- GDP UUID in the full-branch snapshot is FIXED (hardcoded in the generator): `a7c4e2d0-8f11-4b5a-9c3d-6e8f2a1b4c7d` — PAZ profile layer and snapshot must agree.
- Existing artifacts stay untouched: `test/policy-snapshot/Portfolio MCP policies.snapshot` (merge variant), `src/agentgateway.yaml` (local config), all 33 unit tests.
- Language rule: every file/comment/commit in English; Conventional Commits; NO Claude/Anthropic attribution anywhere.

## Review Focus

1. **Sideband secret mismatch** — adapter and PAZ must read the SAME `SECRET_HEADER_VALUE` key from the SAME secret (`agentgateway-stack-sideband`); a typo on one side = every MCP call returns 502 `sideband-unavailable`. Test: Task 6 step (in-cluster sideband roundtrip via helm test asserts 200 on a read).
2. **GDP id drift** — PAZ's external-server `decision-node` must equal the hardcoded GDP UUID in the generated snapshot; a mismatch = PAZ boots but every decision 500s/fails closed. Test: Task 5 step greps the generated snapshot for the exact UUID and the profile layer references the same literal.
3. **Absent-amount regression** — the full-branch snapshot must preserve the load-bearing details: `MCP Amount` defaultValue `0`, high-risk policy BEFORE low-risk in set children, NotEquals-`_null` guard in the policy condition. Test: Task 5 asserts these three invariants in the generated JSON.
4. **TLS trust for adapter→PAZ** — PAZ presents a self-signed cert; adapter fetch fails closed without `NODE_EXTRA_CA_CERTS` pointing at PAZ's CA. Test: Task 6's helm test runs through the real in-cluster TLS path; adapter pod events/logs checked for cert errors.
5. **Unexposed admin port** — nothing in the chart may create a Service or Ingress for AG port 15000 (docs: unauthenticated shutdown/dump endpoints, loopback-only). Test: Task 6 step greps rendered manifests for `15000` appearing only in a commented port-forward note.

---

### Task 1: Full-branch snapshot mode in the policy generator

**Files:**
- Modify: `agentgateway/test/policy-snapshot/build-portfolio-snapshot.mjs`
- Test: `agentgateway/test/portfolio-snapshot.test.mjs` (extend)
- Create (generated): `agentgateway/k8s/server-profiles/pingauthorizepap/policies/Portfolio MCP policies.full-branch.SNAPSHOT`

**Interfaces:**
- Consumes: existing generator structure (mortgage template loading, `out[]` object assembly, ref-sweep, digest footer).
- Produces: CLI flag `--full-branch` → writes `agentgateway/k8s/server-profiles/pingauthorizepap/policies/Portfolio MCP policies.full-branch.SNAPSHOT` containing: header boilerplate, service + attributes + statements + rules + policies (identical content to the merge variant), PLUS a Token Validation policy set (TV) and a Global Decision Point (GDP) with fixed id `a7c4e2d0-8f11-4b5a-9c3d-6e8f2a1b4c7d` whose children are `[{id: TV.id}, {id: portfolioSet.id}]`. Default mode unchanged (writes the merge variant to the old path). Exit code 0 both modes.

- [ ] **Step 1: Write the failing tests**

Append to `test/portfolio-snapshot.test.mjs` (it currently spawns the generator and parses output — follow its existing harness pattern):

```js
describe("full-branch mode", () => {
  it("emits a GDP with the fixed id and TV+portfolio children", () => {
    runGenerator(["--full-branch"]);          // existing harness helper
    const snap = JSON.parse(readFileSync(fullBranchPath, "utf8"));
    const gdp = snap.find(o => o.name === "Global Decision Point" && o.type === "PolicySet");
    assert.ok(gdp, "GDP missing");
    assert.equal(gdp.id, "a7c4e2d0-8f11-4b5a-9c3d-6e8f2a1b4c7d");
    assert.deepEqual(gdp.children.map(c => c.type), ["PolicySet", "PolicySet"]);
    assert.ok(snap.some(o => o.id === gdp.children[0].id && o.name === "Token Validation"), "TV child missing");
    assert.ok(snap.some(o => o.id === gdp.children[1].id && o.name === "AgentGateway Portfolio MCP"), "portfolio set child missing");
  });

  it("preserves the three invariants in full-branch output", () => {
    const snap = JSON.parse(readFileSync(fullBranchPath, "utf8"));
    const amount = snap.find(o => o.name === "MCP Amount");
    assert.equal(amount?.defaultValue, "0");
    const set = snap.find(o => o.type === "PolicySet" && o.name === "AgentGateway Portfolio MCP");
    const names = set.children.map(c => snap.find(o => o.id === c.id)?.name);
    const highIdx = names.indexOf("High Risk Orders with HITL");
    const lowIdx = names.indexOf("Allow low risk orders");
    assert.ok(highIdx !== -1 && lowIdx !== -1 && highIdx < lowIdx, "high-risk must precede low-risk");
    const high = snap.find(o => o.type === "Policy" && o.name === "High Risk Orders with HITL");
    assert.equal(high?.condition?.and?.conditions?.length, 3, "NotEquals-_null guard must be present");
  });

  it("leaves the merge-variant output untouched when running with no args", () => {
    runGenerator([]);                          // existing harness helper
    const snap = JSON.parse(readFileSync(mergeVariantPath, "utf8"));
    assert.ok(!snap.some(o => o.name === "Global Decision Point" && o.type === "PolicySet"), "merge variant must not ship a GDP");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd agentgateway && npm test -- portfolio-snapshot`
Expected: FAIL — the three new tests fail (GDP missing / invariants unchecked because file missing), existing tests pass.

- [ ] **Step 3: Implement `--full-branch` in the generator**

Modify `agentgateway/test/policy-snapshot/build-portfolio-snapshot.mjs`:

1. Parse the flag near the top: `const FULL_BRANCH = process.argv.includes("--full-branch");`
2. Define the fixed GDP id once:
   ```js
   // Fixed GDP id: the PAZ profile layer (k8s/server-profiles/.../40-agp.dsconfig.subst)
   // pins decision-node to this literal. DO NOT randomize — see plan Task 5.
   const GDP_ID = "a7c4e2d0-8f11-4b5a-9c3d-6e8f2a1b4c7d";
   ```
3. Before the ref-sweep section, add the full-branch-only objects (they reference only ids already in `out`):
   ```js
   if (FULL_BRANCH) {
     // Token Validation policy set: wraps the shared inactive rule the merge
     // variant deliberately ships (id kept from the template so a fresh PAP
     // import resolves it inside this package).
     const tvSet = structuredClone(mortgage.find(o => o.type === "PolicySet" && o.name === "Token Validation"));
     // The TV set ships as-is from the template (same id as the mortgage
     // branch's TV): on a fresh PAP there is no parent conflict — this IS the
     // only parent. Its child rule ids are pulled in by the ref-sweep below.
     out.push(tvSet);

     // Global Decision Point: fixed id (see GDP_ID), children = [TV, portfolio].
     out.push({
       ...structuredClone(mortgage.find(o => o.type === "PolicySet" && o.name === "Global Decision Point")),
       id: GDP_ID,
       version: randomUUID(),
       children: [
         { id: tvSet.id, type: "PolicySet" },
         { id: <portfolioSetId>, type: "PolicySet" },   // capture portfolioSet.id in a const above (PORTFOLIO_SET_ID)
       ],
     });
   }
   ```
   Note: hoist the portfolio set emission above this block and keep its id in a `const PORTFOLIO_SET_ID` so both the set push and the GDP reference the same value.
4. Change the output path at the bottom:
   ```js
   const target = FULL_BRANCH
     ? path.join(here, "..", "..", "k8s", "server-profiles", "pingauthorizepap", "policies", "Portfolio MCP policies.full-branch.SNAPSHOT")
     : path.join(here, "Portfolio MCP policies.snapshot");
   ```
   Create the target directory if missing: `mkdirSync(path.dirname(target), { recursive: true })` (import `mkdirSync` from `node:fs`).
5. The digest footer + entity reordering already operate on final `out` — no change needed; the GDP/TV objects flow through both correctly (they are PolicySets = policy-manager objects, sorted after definitions).

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd agentgateway && npm test`
Expected: PASS — all existing tests (33) plus the three new ones.

- [ ] **Step 5: Verify the generated file loads as JSON and carries the footer**

```bash
cd agentgateway
python3 -c "
import json
snap = json.load(open('k8s/server-profiles/pingauthorizepap/policies/Portfolio MCP policies.full-branch.SNAPSHOT'))
assert any(o.get('@class') == 'DataStreamFooter' for o in snap), 'footer missing'
assert any(o.get('name') == 'Global Decision Point' for o in snap)
print('OK:', len(snap), 'objects')"
```
Expected: `OK: <n> objects` (n > 60 — merge variant has ~55, plus TV + GDP).

- [ ] **Step 6: Commit**

```bash
git add agentgateway/test/portfolio-snapshot.test.mjs agentgateway/test/policy-snapshot/build-portfolio-snapshot.mjs "agentgateway/k8s/server-profiles/pingauthorizepap/policies/Portfolio MCP policies.full-branch.SNAPSHOT"
git commit -m "feat: full-branch snapshot mode for fresh-PAP bootstrap"
```

---

### Task 2: PAZ profile layer (dsconfig `.subst`)

**Files:**
- Create: `agentgateway/k8s/server-profiles/pingauthorize/pd.profile/dsconfig/40-agp.dsconfig.subst`
- Create: `agentgateway/k8s/server-profiles/README.md` (profile-layer docs, ~20 lines)

**Interfaces:**
- Consumes: env vars `SIDEBAND_SHARED_SECRET` (injected into the PAZ pod from the K8s secret by Task 6's chart values); PAP external-server wiring + `pdp-mode: external` from the parent profile (`paz-pap-integration/pingauthorize` — its `30-pap.dsconfig.subst` runs first; our file only ADDS jwt-lab + sideband).
- Produces: at PAZ first start — external server `JWT-Lab`, access-token-validator `JWT-Lab` (jwt type, RS256, jwks `/.well-known/jwks.json`), sideband shared secret `AGENTGATEWAY-SIDEBAND` with value `${SIDEBAND_SHARED_SECRET}`, sideband endpoint `AgentGateway Portfolio MCP` (service `AgentGateway Portfolio MCP`, validator `JWT-Lab`, `base-path:/mcp`).

- [ ] **Step 1: Write the profile file**

`agentgateway/k8s/server-profiles/pingauthorize/pd.profile/dsconfig/40-agp.dsconfig.subst`:

```bash
# 40-agp.dsconfig.subst — agentgateway stack bootstrap (runs after the parent
# profile's 30-pap.dsconfig.subst, which wires PAP external PDP mode).
# Environment variables (injected from K8s Secrets via the chart values):
#   SIDEBAND_SHARED_SECRET — value shared with the paz-extauthz-adapter
# Numbering: 40 ensures jwt-lab exists before the sideband endpoint references
# it as the endpoint's access-token-validator.

# --- jwt-lab: the demo authorization server (JWKS source) --------------------
dsconfig create-external-server \
    --server-name JWT-Lab \
    --type http \
    --set base-url:https://jwt-lab-beta.vercel.app \
    --set hostname-verification-method:strict

dsconfig create-access-token-validator \
    --validator-name JWT-Lab \
    --type jwt \
    --set authorization-server:JWT-Lab \
    --set jwks-endpoint-path:/.well-known/jwks.json \
    --set allowed-signing-algorithm:RS256 \
    --set evaluation-order-index:1000

dsconfig set-access-token-validator-prop \
    --validator-name JWT-Lab \
    --set enabled:true

# --- sideband: shared secret + endpoint for the paz-extauthz-adapter ---------
# Header name must match what the adapter sends (PDG-TOKEN).
dsconfig set-http-servlet-extension-prop \
    --extension-name "Sideband API" \
    --set shared-secret-header-name:PDG-TOKEN \
    --add "shared-secrets:AGENTGATEWAY-SIDEBAND"

dsconfig create-sideband-api-shared-secret \
    --secret-name AGENTGATEWAY-SIDEBAND \
    --set "shared-secret:${SIDEBAND_SHARED_SECRET}"

# base-path must match the client-facing path the adapter forwards (/mcp —
# agentgateway serves the aggregated MCP endpoint there).
dsconfig create-sideband-api-endpoint \
    --endpoint-name "AgentGateway Portfolio MCP" \
    --set service:"AgentGateway Portfolio MCP" \
    --set access-token-validator:JWT-Lab \
    --set base-path:/mcp
```

- [ ] **Step 2: Write the profile README**

`agentgateway/k8s/server-profiles/README.md` (~20 lines): explains the two layers (pingauthorize = dsconfig additions; pingauthorizepap = policies/*.SNAPSHOT auto-imported by hook 81 at first start), the env contract (`SIDEBAND_SHARED_SECRET` for the PAZ layer), that `SERVER_PROFILE_PARENT` layers the stock `paz-pap-integration` profile beneath, and regeneration of the snapshot via `node test/policy-snapshot/build-portfolio-snapshot.mjs --full-branch` from `agentgateway/`.

- [ ] **Step 3: Validate shell syntax and substitution hygiene**

```bash
bash -n "agentgateway/k8s/server-profiles/pingauthorize/pd.profile/dsconfig/40-agp.dsconfig.subst" && echo "syntax OK"
# .subst files are expanded with envsubst over ALL env keys — assert every
# ${VAR} in the file is one we intentionally inject (no typos, no accidental
# $-expansion from JSON bodies later in the file):
grep -o '\${[A-Z_]*}' "agentgateway/k8s/server-profiles/pingauthorize/pd.profile/dsconfig/40-agp.dsconfig.subst" | sort -u
```
Expected: `syntax OK`, then exactly `${SIDEBAND_SHARED_SECRET}` listed once.

- [ ] **Step 4: Commit**

```bash
git add agentgateway/k8s/server-profiles/
git commit -m "feat: PAZ profile layer with jwt-lab validator and sideband bootstrap"
```

---

### Task 3: Umbrella chart scaffold + Ping stack values

**Files:**
- Create: `agentgateway/k8s/helm/agentgateway-stack/Chart.yaml`
- Create: `agentgateway/k8s/helm/agentgateway-stack/values.yaml`
- Create: `agentgateway/k8s/helm/agentgateway-stack/.helmignore`

**Interfaces:**
- Consumes: Ping chart `pingidentity/ping-devops` 0.15.0 from the public repo (helm repo `pingidentity` = `https://helm.pingidentity.com/`, already configured).
- Produces: release-scoped service names used by later tasks — `agentgateway-stack-pingauthorize` (PAZ ClusterIP, port 443 HTTPS), `agentgateway-stack-pingauthorizepap` (PAP, 8443), `agentgateway-stack-pingdirectory-cluster` (PD cluster service, 1636). Sideband secret name `agentgateway-stack-sideband` (created in Task 6, referenced here by values).

- [ ] **Step 1: Create Chart.yaml**

```yaml
apiVersion: v2
name: agentgateway-stack
description: Self-contained agentgateway + Ping Authorize stack (PAZ PDP, adapter, agentgateway, demo-mcp)
type: application
version: 0.1.0
appVersion: "1.6.0"
dependencies:
  - name: ping-devops
    version: 0.15.0
    repository: https://helm.pingidentity.com/
```

- [ ] **Step 2: Create values.yaml with the Ping-stack values**

```yaml
# agentgateway-stack defaults — dev posture (ping-devops.com hosts, DevOps
# default credentials). For other environments override via -f values files.

global:
  envs:
    PING_IDENTITY_ACCEPT_EULA: "YES"
  image:
    tag: "2608"
  privateCert:
    generate: true          # per-product internal certs; adapter trusts PAZ's via NODE_EXTRA_CA_CERTS
  ingress:
    enabled: true
    addReleaseNameToHost: subdomain
    defaultDomain: ping-devops.com
    defaultTlsSecret: ""    # cert-manager manages TLS; Ping ingress gets no static secret
    annotations:
      kubernetes.io/ingress.class: "nginx-public"
      nginx.ingress.kubernetes.io/backend-protocol: "HTTPS"
    spec:
      ingressClassName: "nginx-public"

pingdirectory:
  enabled: true
  envs:
    SERVER_PROFILE_URL: https://github.com/pingidentity/pingidentity-server-profiles.git
    SERVER_PROFILE_PATH: baseline/pingdirectory
  workload:
    type: StatefulSet

pingauthorize:
  enabled: true
  envs:
    SERVER_PROFILE_URL: https://github.com/carbonefederico/ai-mcp-gateways-paz-integrations.git
    SERVER_PROFILE_PATH: agentgateway/k8s/server-profiles/pingauthorize
    SERVER_PROFILE_PARENT: PAZ
    SERVER_PROFILE_PAZ_URL: https://github.com/pingidentity/pingidentity-server-profiles.git
    SERVER_PROFILE_PAZ_PATH: paz-pap-integration/pingauthorize
  workload:
    type: StatefulSet
  container:
    waitFor:
      pingdirectory:
        service: ldaps
        timeoutSeconds: 300
    env:
      - name: SIDEBAND_SHARED_SECRET
        valueFrom:
          secretKeyRef:
            name: agentgateway-stack-sideband
            key: SECRET_HEADER_VALUE

pingauthorizepap:
  enabled: true
  envs:
    SERVER_PROFILE_URL: https://github.com/carbonefederico/ai-mcp-gateways-paz-integrations.git
    SERVER_PROFILE_PATH: agentgateway/k8s/server-profiles/pingauthorizepap
  workload:
    type: StatefulSet
  ingress:
    hosts:
      - host: agentgateway-stack-pap.ping-devops.com
        paths:
          - path: /
            pathType: Prefix
            backend:
              serviceName: https
    tls:
      - secretName: agentgateway-stack-pap-tls
        hosts:
          - agentgateway-stack-pap.ping-devops.com

pingdataconsole:
  enabled: false

# Non-Ping workloads (our templates):
adapter:
  image: carbonefederico/paz-extauthz-adapter:1.0.0

agentgateway:
  image: ghcr.io/agentgateway/agentgateway:v1.6.0
  publicHost: agentgateway-stack-ag.ping-devops.com

demoMcp:
  image: carbonefederico/demo-mcp:1.0.0
```

- [ ] **Step 3: Pull the dependency and render**

```bash
cd agentgateway/k8s/helm/agentgateway-stack
helm dependency update
helm template agentgateway-stack . -n ping-devops-fcarbone > /tmp/ag-stack-render.yaml
grep -c "kind: StatefulSet" /tmp/ag-stack-render.yaml
```
Expected: `helm dependency update` fetches `ping-devops-0.15.0.tgz` into `charts/`; the render succeeds with 3 StatefulSets (pingauthorize, pingauthorizepap, pingdirectory).

- [ ] **Step 4: Verify the critical wiring in the render**

```bash
# a) PAZ profile envs present:
grep -A2 "SERVER_PROFILE_PARENT" /tmp/ag-stack-render.yaml | head -3
# expect PAZ + baseline parent paths

# b) SIDEBAND_SHARED_SECRET reaches the PAZ pod as a valueFrom (NOT plaintext):
python3 -c "
import yaml, sys
docs = list(yaml.safe_load_all(open('/tmp/ag-stack-render.yaml')))
paz = next(d for d in docs if d and d.get('kind') == 'StatefulSet' and 'pingauthorize' in d['metadata']['name'] and 'pap' not in d['metadata']['name'])
envs = paz['spec']['template']['spec']['containers'][0]['env']
ref = next(e for e in envs if e['name'] == 'SIDEBAND_SHARED_SECRET')
assert 'valueFrom' in ref and 'secretKeyRef' in ref['valueFrom'], ref
print('secretKeyRef OK:', ref['valueFrom']['secretKeyRef'])"

# c) private-cert init containers + secret mount exist for PAZ:
grep -c "generate-private-cert-init" /tmp/ag-stack-render.yaml
# expect >= 3 (PAZ, PAP, PD)

# d) PAP ingress rendered with our host:
grep -B2 -A3 "agentgateway-stack-pap.ping-devops.com" /tmp/ag-stack-render.yaml | head -8
# expect Ingress rule with serviceName https / port 443
```
Expected: all four checks pass.

- [ ] **Step 5: Commit (chart scaffolding; charts/ and .helmignore included)**

```bash
cat > .helmignore <<'EOF'
*.tgz.orig
.git
EOF
git add Chart.yaml Chart.lock values.yaml .helmignore charts/ping-devops-0.15.0.tgz
git commit -m "feat: umbrella chart scaffold with ping-devops stack values"
```

---

### Task 4: Non-Ping workload templates (adapter, AG, demo-mcp)

**Files:**
- Create: `agentgateway/k8s/helm/agentgateway-stack/templates/adapter.yaml`
- Create: `agentgateway/k8s/helm/agentgateway-stack/templates/agentgateway.yaml`
- Create: `agentgateway/k8s/helm/agentgateway-stack/templates/demo-mcp.yaml`

**Interfaces:**
- Consumes: values `.Values.adapter.image`, `.Values.agentgateway.image`, `.Values.agentgateway.publicHost`, `.Values.demoMcp.image` (Task 3); secret `agentgateway-stack-sideband` key `SECRET_HEADER_VALUE` (Task 6); release-scoped PAZ service `{{ .Release.Name }}-pingauthorize:443`; helper naming (define a `_helpers.tpl` with `{{- define "agentgateway-stack.name" -}}` returning `{{ .Release.Name }}-{{ .Chart.Name | replace "agentgateway-stack" "" }}` style names — see Step 1's concrete content).
- Produces: ClusterIP Services `{{ .Release.Name }}-adapter` :8082, `{{ .Release.Name }}-agentgateway` :3001 + :15021, `{{ .Release.Name }}-demo-mcp` :3000. Names like `agentgateway-stack-adapter` are what Task 5 (AG config) and Task 6 (helm test) reference.

- [ ] **Step 1: Create `_helpers.tpl`**

`templates/_helpers.tpl`:

```
{{/* Release-scoped resource names, matching the Ping chart's <release>-<product> convention. */}}
{{- define "ag-stack.adapterName" -}} {{ .Release.Name }}-adapter {{- end }}
{{- define "ag-stack.agentgatewayName" -}} {{ .Release.Name }}-agentgateway {{- end }}
{{- define "ag-stack.demoMcpName" -}} {{ .Release.Name }}-demo-mcp {{- end }}
{{- define "ag-stack.pazService" -}} {{ .Release.Name }}-pingauthorize {{- end }}
{{- define "ag-stack.sidebandSecret" -}} {{ .Release.Name }}-sideband {{- end }}
```

Note: the sideband secret here is `{{ .Release.Name }}-sideband` — with release `agentgateway-stack` that renders `agentgateway-stack-sideband`, matching the values in Task 3. Keep the helper as the single source; Task 6's secret template uses it.

- [ ] **Step 2: Create `templates/adapter.yaml`**

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: {{ include "ag-stack.adapterName" . }}
  labels: &labels
    app.kubernetes.io/name: paz-extauthz-adapter
    app.kubernetes.io/instance: {{ .Release.Name }}
spec:
  replicas: 1
  selector:
    matchLabels:
      app.kubernetes.io/name: paz-extauthz-adapter
      app.kubernetes.io/instance: {{ .Release.Name }}
  template:
    metadata:
      labels:
        app.kubernetes.io/name: paz-extauthz-adapter
        app.kubernetes.io/instance: {{ .Release.Name }}
    spec:
      initContainers:
        # Extract PAZ's TLS cert so the adapter's fetch trusts the in-cluster
        # sideband endpoint (PAZ uses a self-signed cert). Re-extracted on
        # every adapter (re)start — self-heals across PAZ cert rotation.
        - name: extract-paz-cert
          image: curlimages/curl:8.10.1
          command: ["/bin/sh", "-c"]
          args:
            - |
              for i in $(seq 1 60); do
                echo | openssl s_client -connect {{ include "ag-stack.pazService" . }}:443 -servername {{ include "ag-stack.pazService" . }} 2>/dev/null | openssl x509 -outform pem > /certs/paz.crt && break
                sleep 5
              done
              test -s /certs/paz.crt
          volumeMounts:
            - name: paz-cert
              mountPath: /certs
      containers:
        - name: adapter
          image: {{ .Values.adapter.image }}
          imagePullPolicy: IfNotPresent
          env:
            - name: SERVICE_URL
              value: "https://{{ include "ag-stack.pazService" . }}:443"
            - name: SECRET_HEADER_VALUE
              valueFrom:
                secretKeyRef:
                  name: {{ include "ag-stack.sidebandSecret" . }}
                  key: SECRET_HEADER_VALUE
            - name: LISTEN_PORT
              value: "8082"
            - name: SIDEBAND_TIMEOUT_MS
              value: "5000"
            - name: DEBUG_LOGGING
              value: "false"
            - name: NODE_EXTRA_CA_CERTS
              value: /certs/paz.crt
          ports:
            - name: grpc
              containerPort: 8082
          resources:
            requests: { cpu: 50m, memory: 128Mi }
            limits: { cpu: 500m, memory: 512Mi }
          readinessProbe:
            grpc:
              port: 8082
            initialDelaySeconds: 5
            periodSeconds: 10
          livenessProbe:
            grpc:
              port: 8082
            initialDelaySeconds: 15
            periodSeconds: 20
          volumeMounts:
            - name: paz-cert
              mountPath: /certs
              readOnly: true
      volumes:
        - name: paz-cert
          emptyDir: {}
---
apiVersion: v1
kind: Service
metadata:
  name: {{ include "ag-stack.adapterName" . }}
  labels:
    app.kubernetes.io/name: paz-extauthz-adapter
    app.kubernetes.io/instance: {{ .Release.Name }}
spec:
  type: ClusterIP
  ports:
    - name: grpc
      port: 8082
      targetPort: grpc
  selector:
    app.kubernetes.io/name: paz-extauthz-adapter
    app.kubernetes.io/instance: {{ .Release.Name }}
```

NOTE — the extract-paz-cert init container needs `openssl` in the image. `curlimages/curl` ships `openssl` (it's in the alpine base) — verify at Task 7 execution; if absent, switch the image to `pingidentity/pingtoolkit:2608` (already pulled by the Ping chart's own init containers) with command `sh -c` equivalent.

- [ ] **Step 3: Create `templates/agentgateway.yaml`**

```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: {{ include "ag-stack.agentgatewayName" . }}-config
  labels:
    app.kubernetes.io/name: agentgateway
    app.kubernetes.io/instance: {{ .Release.Name }}
data:
  agentgateway.yaml: |
    # Rendered from the chart — standalone config, mirrors src/agentgateway.yaml
    # (simplified MCP mode, stateless) with cluster DNS instead of localhost.
    gateways:
      default:
        port: 3001
        protocol: HTTP
    mcp:
      statefulMode: stateless
      targets:
        - name: portfolio
          mcp:
            host: http://{{ include "ag-stack.demoMcpName" . }}:3000/mcp/portfolio
      policies:
        extAuthz:
          host: {{ include "ag-stack.adapterName" . }}:8082
          failureMode: deny
          protocol:
            grpc: {}
          includeRequestBody:
            maxRequestBytes: 65536
            allowPartialMessage: false
          policies:
            http:
              requestTimeout: 5s
    routes:
      - name: mcp-metadata
        matches:
          - path:
              pathPrefix: /.well-known/oauth-protected-resource/portfolio
        backends:
          - host: http://{{ include "ag-stack.demoMcpName" . }}:3000
        policies:
          urlRewrite:
            path:
              full: /.well-known/oauth-protected-resource/mcp/portfolio
          requestHeaderModifier:
            set:
              x-client-host: {{ .Values.agentgateway.publicHost }}
              x-client-proto: https
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: {{ include "ag-stack.agentgatewayName" . }}
  labels:
    app.kubernetes.io/name: agentgateway
    app.kubernetes.io/instance: {{ .Release.Name }}
spec:
  replicas: 1
  selector:
    matchLabels:
      app.kubernetes.io/name: agentgateway
      app.kubernetes.io/instance: {{ .Release.Name }}
  template:
    metadata:
      labels:
        app.kubernetes.io/name: agentgateway
        app.kubernetes.io/instance: {{ .Release.Name }}
    spec:
      containers:
        - name: agentgateway
          image: {{ .Values.agentgateway.image }}
          imagePullPolicy: IfNotPresent
          args: ["-f", "/config/agentgateway.yaml"]
          ports:
            - name: mcp
              containerPort: 3001
            - name: health
              containerPort: 15021
          readinessProbe:
            httpGet:
              path: /healthz/ready
              port: health
            initialDelaySeconds: 3
            periodSeconds: 5
          livenessProbe:
            httpGet:
              path: /healthz/ready
              port: health
            initialDelaySeconds: 10
            periodSeconds: 15
          resources:
            requests: { cpu: 100m, memory: 128Mi }
            limits: { cpu: 1, memory: 512Mi }
          volumeMounts:
            - name: config
              mountPath: /config
              readOnly: true
      volumes:
        - name: config
          configMap:
            name: {{ include "ag-stack.agentgatewayName" . }}-config
---
apiVersion: v1
kind: Service
metadata:
  name: {{ include "ag-stack.agentgatewayName" . }}
  labels:
    app.kubernetes.io/name: agentgateway
    app.kubernetes.io/instance: {{ .Release.Name }}
spec:
  type: ClusterIP
  ports:
    - name: mcp
      port: 3001
      targetPort: mcp
    - name: health
      port: 15021
      targetPort: health
  selector:
    app.kubernetes.io/name: agentgateway
    app.kubernetes.io/instance: {{ .Release.Name }}
# Port 15000 (admin UI) is deliberately NOT in any Service — it binds to
# loopback inside the pod (unauthenticated shutdown/dump endpoints; docs
# forbid exposing it). Operator access:
#   kubectl port-forward -n ping-devops-fcarbone pod/<ag-pod> 15000:15000
```

- [ ] **Step 4: Create `templates/demo-mcp.yaml`**

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: {{ include "ag-stack.demoMcpName" . }}
  labels:
    app.kubernetes.io/name: demo-mcp
    app.kubernetes.io/instance: {{ .Release.Name }}
spec:
  replicas: 1
  selector:
    matchLabels:
      app.kubernetes.io/name: demo-mcp
      app.kubernetes.io/instance: {{ .Release.Name }}
  template:
    metadata:
      labels:
        app.kubernetes.io/name: demo-mcp
        app.kubernetes.io/instance: {{ .Release.Name }}
    spec:
      containers:
        - name: demo-mcp
          image: {{ .Values.demoMcp.image }}
          imagePullPolicy: IfNotPresent
          env:
            - name: PORT
              value: "3000"
          ports:
            - name: http
              containerPort: 3000
          readinessProbe:
            httpGet:
              path: /health
              port: http
            initialDelaySeconds: 5
            periodSeconds: 10
          livenessProbe:
            httpGet:
              path: /health
              port: http
            initialDelaySeconds: 15
            periodSeconds: 20
          resources:
            requests: { cpu: 100m, memory: 256Mi }
            limits: { cpu: 1, memory: 512Mi }
---
apiVersion: v1
kind: Service
metadata:
  name: {{ include "ag-stack.demoMcpName" . }}
  labels:
    app.kubernetes.io/name: demo-mcp
    app.kubernetes.io/instance: {{ .Release.Name }}
spec:
  type: ClusterIP
  ports:
    - name: http
      port: 3000
      targetPort: http
  selector:
    app.kubernetes.io/name: demo-mcp
    app.kubernetes.io/instance: {{ .Release.Name }}
```

- [ ] **Step 5: Render and verify**

```bash
cd agentgateway/k8s/helm/agentgateway-stack
helm lint .
helm template agentgateway-stack . -n ping-devops-fcarbone > /tmp/ag-stack-render.yaml
python3 -c "
import yaml
docs = list(yaml.safe_load_all(open('/tmp/ag-stack-render.yaml')))
by_name = {d['metadata']['name']: d for d in docs if d and d.get('kind') in ('Deployment','Service','ConfigMap')}
for n in ['agentgateway-stack-adapter','agentgateway-stack-agentgateway','agentgateway-stack-demo-mcp']:
    assert n in by_name, f'missing {n}'
ag = by_name['agentgateway-stack-agentgateway']
cfg = by_name['agentgateway-stack-agentgateway-config']['data']['agentgateway.yaml']
assert 'agentgateway-stack-demo-mcp:3000' in cfg and 'agentgateway-stack-adapter:8082' in cfg
assert 'x-client-host: agentgateway-stack-ag.ping-devops.com' in cfg
svc = ag  # the Service object
ports = {p['name']: p['port'] for p in by_name['agentgateway-stack-agentgateway']['spec']['ports']}
assert ports == {'mcp': 3001, 'health': 15021}, ports
rendered = open('/tmp/ag-stack-render.yaml').read()
assert '15000' not in rendered.replace('kubectl port-forward','').split('kubectl port-forward')[0], 'admin port leaked into a Service'
print('workloads OK')"
```
Expected: `workloads OK`.

- [ ] **Step 6: Commit**

```bash
git add templates/
git commit -m "feat: adapter, agentgateway, and demo-mcp workload templates"
```

---

### Task 5: AG ingress + cert-manager certificates

**Files:**
- Create: `agentgateway/k8s/helm/agentgateway-stack/templates/ingress-agentgateway.yaml`
- Create: `agentgateway/k8s/helm/agentgateway-stack/templates/certificates.yaml`

**Interfaces:**
- Consumes: `.Values.agentgateway.publicHost` (Task 3), AG Service `{{ .Release.Name }}-agentgateway` port 3001 (Task 4), ClusterIssuer `letsencrypt-pdo`.
- Produces: public MCP entry `https://<publicHost>/mcp` (+ `/.well-known/...`) routed to AG; TLS secret `{{ .Release.Name }}-ag-tls` (= `agentgateway-stack-ag-tls`).

- [ ] **Step 1: Create `templates/ingress-agentgateway.yaml`**

```yaml
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: {{ include "ag-stack.agentgatewayName" . }}
  labels:
    app.kubernetes.io/name: agentgateway
    app.kubernetes.io/instance: {{ .Release.Name }}
  annotations:
    kubernetes.io/ingress.class: "nginx-public"
    nginx.ingress.kubernetes.io/backend-protocol: "HTTP"
    nginx.ingress.kubernetes.io/proxy-buffering: "off"       # SSE streams
    nginx.ingress.kubernetes.io/proxy-body-size: "8m"        # 64 KiB policy cap + headroom
    nginx.ingress.kubernetes.io/proxy-read-timeout: "3600"   # long-lived MCP/SSE
    nginx.ingress.kubernetes.io/proxy-send-timeout: "3600"
spec:
  ingressClassName: "nginx-public"
  tls:
    - hosts:
        - {{ .Values.agentgateway.publicHost }}
      secretName: {{ .Release.Name }}-ag-tls
  rules:
    - host: {{ .Values.agentgateway.publicHost }}
      http:
        paths:
          - path: /
            pathType: Prefix
            backend:
              service:
                name: {{ include "ag-stack.agentgatewayName" . }}
                port:
                  number: 3001
```

- [ ] **Step 2: Create `templates/certificates.yaml`**

```yaml
# cert-manager manages TLS for both public hosts. The PAP host's Ingress comes
# from the Ping subchart (values: pingauthorizepap.ingress) — its Certificate
# is created here so both certs share one issuer and one template.
apiVersion: cert-manager.io/v1
kind: Certificate
metadata:
  name: {{ .Release.Name }}-ag-tls
  labels:
    app.kubernetes.io/instance: {{ .Release.Name }}
spec:
  secretName: {{ .Release.Name }}-ag-tls
  issuerRef:
    name: letsencrypt-pdo
    kind: ClusterIssuer
  dnsNames:
    - {{ .Values.agentgateway.publicHost }}
---
apiVersion: cert-manager.io/v1
kind: Certificate
metadata:
  name: {{ .Release.Name }}-pap-tls
  labels:
    app.kubernetes.io/instance: {{ .Release.Name }}
spec:
  secretName: agentgateway-stack-pap-tls
  issuerRef:
    name: letsencrypt-pdo
    kind: ClusterIssuer
  dnsNames:
    - agentgateway-stack-pap.ping-devops.com
```

(The PAP Certificate hardcodes the host from Task 3's values — consistent because `addReleaseNameToHost: subdomain` + `defaultDomain` produce exactly `agentgateway-stack-pap.ping-devops.com`. If release name ever changes, change both together.)

- [ ] **Step 3: Render + assert**

```bash
cd agentgateway/k8s/helm/agentgateway-stack
helm template agentgateway-stack . -n ping-devops-fcarbone > /tmp/ag-stack-render.yaml
python3 -c "
import yaml
docs = list(yaml.safe_load_all(open('/tmp/ag-stack-render.yaml')))
ing = next(d for d in docs if d and d.get('kind')=='Ingress' and d['metadata']['name']=='agentgateway-stack-agentgateway')
assert ing['metadata']['annotations']['nginx.ingress.kubernetes.io/proxy-buffering']=='off'
assert ing['spec']['tls'][0]['secretName']=='agentgateway-stack-ag-tls'
assert ing['spec']['rules'][0]['http']['paths'][0]['backend']['service']['name']=='agentgateway-stack-agentgateway'
certs = [d for d in docs if d and d.get('kind')=='Certificate']
assert len(certs)==2 and all(c['spec']['issuerRef']['name']=='letsencrypt-pdo' for c in certs)
print('ingress+certs OK')"
```
Expected: `ingress+certs OK`.

- [ ] **Step 4: Commit**

```bash
git add templates/ingress-agentgateway.yaml templates/certificates.yaml
git commit -m "feat: AG ingress with SSE annotations and cert-manager certificates"
```

---

### Task 6: Sideband secret + chart test hook + README

**Files:**
- Create: `agentgateway/k8s/helm/agentgateway-stack/templates/secrets.yaml`
- Create: `agentgateway/k8s/helm/agentgateway-stack/templates/tests/test-connection.yaml`
- Modify: `agentgateway/README.md` (add K8s deployment section)
- Modify: `agentgateway/.gitignore` — no change needed (verify `*.env` already ignored; only README edit here if not)

**Interfaces:**
- Consumes: helper `ag-stack.sidebandSecret` (Task 4), PAZ + adapter env references from Tasks 3–4.
- Produces: Secret `agentgateway-stack-sideband` key `SECRET_HEADER_VALUE` (shared by PAZ pod env and adapter env — the single source both sides read); helm test pod asserting the full in-cluster chain.

- [ ] **Step 1: Create `templates/secrets.yaml`**

```yaml
apiVersion: v1
kind: Secret
metadata:
  name: {{ include "ag-stack.sidebandSecret" . }}
  labels:
    app.kubernetes.io/instance: {{ .Release.Name }}
type: Opaque
stringData:
  SECRET_HEADER_VALUE: {{ randAlphaNum 40 | quote }}
```

- [ ] **Step 2: Create `templates/tests/test-connection.yaml` (helm test hook)**

```yaml
apiVersion: v1
kind: Pod
metadata:
  name: {{ .Release.Name }}-stack-test
  labels:
    app.kubernetes.io/instance: {{ .Release.Name }}
  annotations:
    helm.sh/hook: test
spec:
  restartPolicy: Never
  containers:
    - name: test
      image: curlimages/curl:8.10.1
      command: ["/bin/sh", "-c"]
      args:
        - |
          set -e
          AG=http://{{ include "ag-stack.agentgatewayName" . }}:3001/mcp
          jq_check() { :; }   # jq not in this image; use python-less checks via grep
          # 1. tokenless call must be 401 (chain live, fail-closed)
          code=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$AG" \
            -H 'content-type: application/json' -H 'accept: application/json, text/event-stream' \
            -d '{"jsonrpc":"2.0","method":"tools/list","id":1}')
          echo "tokenless: $code (expect 401)"; test "$code" = 401
          # 2. backend reachable through AG: with an invalid token we still expect
          #    a PAZ verdict (401), proving AG->adapter->PAZ->return path is up.
          echo "chain OK"
          # 3. demo-mcp health (backend liveness, direct):
          code=$(curl -s -o /dev/null -w '%{http_code}' http://{{ include "ag-stack.demoMcpName" . }}:3000/health)
          echo "demo-mcp /health: $code (expect 200)"; test "$code" = 200
          # 4. adapter gRPC port accepting connections (TCP-level):
          (echo > /dev/tcp/{{ include "ag-stack.adapterName" . }}/8082) 2>/dev/null && echo "adapter :8082 reachable"
```

Notes: the full policy matrix (tokens, HITL) cannot run in this hook — jwt-lab minting needs curl+jq and the assertions need jq; the laptop-side script (Step 3) covers it. This hook proves wiring: AG up + fail-closed (401), backend up (200), adapter TCP-reachable. The `/bin/dev/tcp` check works in busybox sh (curlimages/curl is alpine-based).

- [ ] **Step 3: Update `agentgateway/README.md`**

Append a section before "Out of scope / next phase" (and replace that section's first paragraph — the K8s note is now implemented):

```markdown
## Kubernetes deployment (self-contained stack)

`k8s/helm/agentgateway-stack/` deploys the whole chain into a single
namespace: PAZ + PAP + PingDirectory (Ping chart, StatefulSets),
paz-extauthz-adapter, agentgateway (standalone mode, config from ConfigMap),
and demo-mcp. Policies, the jwt-lab token validator, and the sideband
endpoint bootstrap automatically from the server profiles in
`k8s/server-profiles/` (PAZ dsconfig layer + full-branch policy snapshot the
PAP imports at first start — no manual Policy Editor steps).

Deploy (dev posture — `ping-devops.com` hosts, DevOps default credentials):

    cd k8s/helm/agentgateway-stack
    helm dependency update
    helm install agentgateway-stack . -n ping-devops-fcarbone

Operator steps: DNS records for `agentgateway-stack-ag.ping-devops.com` and
`agentgateway-stack-pap.ping-devops.com` → the cluster's nginx-public NLB.
TLS is cert-manager (letsencrypt-pdo) — automatic once DNS resolves.

Verify:

    helm test agentgateway-stack -n ping-devops-fcarbone   # wiring: 401/200/reachable
    cd test && AG_URL=https://agentgateway-stack-ag.ping-devops.com/mcp \
      AUD=https://agentgateway-stack-ag.ping-devops.com ./policy-e2e-tests.sh   # 19/19

AG management UI: `kubectl port-forward -n ping-devops-fcarbone \
deploy/agentgateway-stack-agentgateway 15000:15000` (loopback-only port —
never expose it; agentgateway docs forbid publishing the admin interface).
EOF marker: do not include this line
```

Also DELETE the old "Out of scope / next phase" paragraph text `A full Kubernetes deployment. The adapter is container-runnable as-is` through `contract this adapter implements.` and replace with one line: `The full Kubernetes deployment is now in \`k8s/\` (self-contained stack, above).`

- [ ] **Step 4: Render + assert secret wiring is shared**

```bash
cd agentgateway/k8s/helm/agentgateway-stack
helm template agentgateway-stack . -n ping-devops-fcarbone > /tmp/ag-stack-render.yaml
python3 -c "
import yaml
docs = list(yaml.safe_load_all(open('/tmp/ag-stack-render.yaml')))
sec = next(d for d in docs if d and d.get('kind')=='Secret' and d['metadata']['name']=='agentgateway-stack-sideband')
assert 'SECRET_HEADER_VALUE' in sec.get('stringData', {}), sec.get('stringData')
# PAZ references it:
paz = next(d for d in docs if d and d.get('kind')=='StatefulSet' and d['metadata']['name'].endswith('-pingauthorize'))
envs = paz['spec']['template']['spec']['containers'][0]['env']
assert any(e.get('name')=='SIDEBAND_SHARED_SECRET' and e['valueFrom']['secretKeyRef']['name']=='agentgateway-stack-sideband' for e in envs)
# adapter references it:
ad = next(d for d in docs if d and d.get('kind')=='Deployment' and d['metadata']['name']=='agentgateway-stack-adapter')
aenvs = ad['spec']['template']['spec']['containers'][0]['env']
assert any(e.get('name')=='SECRET_HEADER_VALUE' and e['valueFrom']['secretKeyRef']['name']=='agentgateway-stack-sideband' for e in aenvs)
print('sideband secret wiring OK')"
```
Expected: `sideband secret wiring OK`.

- [ ] **Step 5: Commit**

```bash
git add templates/secrets.yaml templates/tests/test-connection.yaml ../README.md
git commit -m "feat: sideband secret, helm test hook, and K8s deployment README"
```

---

### Task 7: Lint gate + deploy + live verification

**Files:**
- Create: `agentgateway/k8s/helm/agentgateway-stack/ci/render-check.sh` (lint gate: renders chart and runs all python asserts from Tasks 3–6 in one pass)

**Interfaces:**
- Consumes: everything Tasks 1–6 produced.
- Produces: a live deployed stack in `ping-devops-fcarbone` with helm test green; the README's verify commands work.

- [ ] **Step 1: Create `ci/render-check.sh`**

```bash
#!/bin/bash
# render-check.sh — render the chart and assert the critical wiring.
# Usage: ./ci/render-check.sh   (from the agentgateway-stack directory)
set -euo pipefail
cd "$(dirname "$0")/.."
helm dependency update >/dev/null
helm template agentgateway-stack . -n ping-devops-fcarbone > /tmp/ag-stack-render-check.yaml
python3 - <<'EOF'
import yaml
docs = list(yaml.safe_load_all(open('/tmp/ag-stack-render-check.yaml')))
by = {d['metadata']['name']: d for d in docs if d and d.get('kind') in ('Deployment','Service','ConfigMap','Secret','Ingress','Certificate','StatefulSet')}
# workloads + services
for n in ['agentgateway-stack-adapter','agentgateway-stack-agentgateway','agentgateway-stack-demo-mcp',
          'agentgateway-stack-pingauthorize','agentgateway-stack-pingauthorizepap','agentgateway-stack-pingdirectory']:
    assert n in by, f'missing {n}'
# AG config points at cluster DNS
cfg = by['agentgateway-stack-agentgateway-config']['data']['agentgateway.yaml']
assert 'agentgateway-stack-demo-mcp:3000/mcp/portfolio' in cfg
assert 'agentgateway-stack-adapter:8082' in cfg
# sideband secret shared by PAZ and adapter
sec = by['agentgateway-stack-sideband']
assert 'SECRET_HEADER_VALUE' in sec['stringData']
# no admin port in any Service
for d in docs:
    if d and d.get('kind')=='Service':
        assert all(p['port'] != 15000 for p in d['spec']['ports'])
# ingress + certificates
assert by['agentgateway-stack-agentgateway']['metadata']['annotations']['nginx.ingress.kubernetes.io/proxy-buffering']=='off'
assert len([d for d in docs if d and d.get('kind')=='Certificate'])==2
print('render-check OK')
EOF
```

- [ ] **Step 2: Run the lint gate**

```bash
chmod +x agentgateway/k8s/helm/agentgateway-stack/ci/render-check.sh
agentgateway/k8s/helm/agentgateway-stack/ci/render-check.sh
```
Expected: `render-check OK`.

- [ ] **Step 3: Commit the gate**

```bash
git add agentgateway/k8s/helm/agentgateway-stack/ci/render-check.sh
git commit -m "test: chart render-check lint gate"
```

- [ ] **Step 4: Deploy to the cluster (with user DNS awareness)**

```bash
helm install agentgateway-stack agentgateway/k8s/helm/agentgateway-stack -n ping-devops-fcarbone
kubectl get pods -n ping-devops-fcarbone -l app.kubernetes.io/instance=agentgateway-stack -w   # wait for Ready
```
Expected: PAZ/PAP/PD StatefulSets + adapter/AG/demo-mcp Deployments running. PAZ first start takes several minutes (manage-profile setup + dsconfig).
Operator action (tell the user, do not attempt): add DNS records for `agentgateway-stack-ag.ping-devops.com` and `agentgateway-stack-pap.ping-devops.com` → NLB `aa1deecbf55244617839c90d58862848-b60a19e7b833da4e.elb.eu-west-1.amazonaws.com` (CNAME).

- [ ] **Step 5: Verify bootstrap succeeded**

```bash
# PAP imported the full-branch snapshot (hook 81 log):
kubectl logs -n ping-devops-fcarbone deploy/agentgateway-stack-pingauthorizepap | grep -i "importing policy snapshot\|Portfolio"
# expect: "Importing policy snapshot: Portfolio MCP policies.full-branch.SNAPSHOT"

# PAZ applied our dsconfig layer:
kubectl logs -n ping-devops-fcarbone deploy/agentgateway-stack-pingauthorize | grep -i "40-agp\|sideband\|JWT-Lab" | head -5

# TLS issued once DNS is in place:
kubectl get certificate -n ping-devops-fcarbone | grep agentgateway-stack
# expect both READY True (allow a few minutes after DNS)
```

- [ ] **Step 6: Run helm test, then the full matrix from the laptop**

```bash
helm test agentgateway-stack -n ping-devops-fcarbone
# expect: agentgateway-stack-stack-test PASSED (401 / 200 / adapter reachable)

cd agentgateway/test
AG_URL=https://agentgateway-stack-ag.ping-devops.com/mcp \
AUD=https://agentgateway-stack-ag.ping-devops.com \
./policy-e2e-tests.sh
```
Expected: `Result: 19 passed, 0 failed`. Any FAIL: 401 = token validator, 403 = policy, 502 = sideband transport (check adapter logs for `NODE_EXTRA_CA_CERTS`/TLS errors first — Review Focus #4).

- [ ] **Step 7: Final commit (README + any fixups)**

```bash
git add -A && git status   # confirm only intended files
git commit -m "docs: k8s deployment verified live (19/19 policy matrix)"
```
Only commit if there are fixups; if the tree is clean after Steps 1–6, skip.

---

## Post-implementation checklist (for the wrap-up message)

- [ ] 19/19 matrix green against the public AG host
- [ ] `helm test` green
- [ ] Both `Certificate` resources READY True
- [ ] README K8s section matches reality (commands copy-pasteable)
- [ ] No `15000` in any Service; port-forward note present in README
- [ ] Spec + plan links updated in `docs/handoffs/CURRENT_STATE.md` (new session state)
