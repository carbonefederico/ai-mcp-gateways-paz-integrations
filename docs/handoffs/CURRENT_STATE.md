# Session Handoff
Updated: 2026-10-14

## Source documents
- [Design spec](../superpowers/specs/2026-10-12-agentgateway-paz-integration-design.md) — the agentgateway↔PAZ integration design (§6 config, §7 PAZ-side, §8 snapshot, §9 test matrix)
- [Implementation plan](../superpowers/plans/2026-10-12-agentgateway-paz-integration.md) — the 11-task plan; all tasks completed and merged before this session's follow-ons

The integration is **complete and live**; the plan/spec are historical context now. This handoff covers what changed *after* the plan finished.

## Session decisions and documentation drift

- **Confirmed — simplified MCP mode (commit `10848ed`).** `src/agentgateway.yaml` uses the top-level `mcp:` block, not the spec §6 routing-based form. Reason: the management UI's MCP page only reads/writes the top-level block (its capability toggle does `t.mcp=`/`delete n.mcp` in the JS bundle); route-attached `routes[].backends[].mcp` renders as disabled in the UI. Docs say both forms configure the same MCP backend with the same policies. Client-facing path moved `/portfolio` → `/mcp` (+`/sse`); extAuthz now under `mcp.policies`. **This drifts from spec §6 and §9's `http://localhost:3001/portfolio` — spec not updated (deliberate).**
- **Confirmed — adapter on :8083 (commit `3d91f65`).** `.env` `LISTEN_PORT=8083`, extAuthz host `localhost:8083`; 8082 was squatted by an unrelated local uvicorn. Spec §6 says 8082 — drift, deliberate.
- **Confirmed — programmatic PAP import (commit `9f12a42`).** Spec §7 step 3 and old test.md §1.2 described a UI merge; replaced by the PAP admin API flow documented in test.md §1.2 (import raw JSON → export tip → multipart merge with `conflict-resolutions` text/plain → PUT GDP child → commit). The snapshot now ships **set-only content** (no GDP, no TV): re-shipping them fails import (children must resolve in-package) or merge (fresh-id TV = two parents on the shared rule).
- **Confirmed — HITL tiering fixes (commit `c41e4cf`), live on branch `ID4AI Control Plane` (head `bf15c337`).** Two PAZ-engine semantics the spec §8 design missed:
  1. FirstApplicable evaluates set children in order — a catch-all low-risk rule before the high-risk policy swallowed 50k orders (permitted without approval). Fix: high-risk policy precedes low-risk in the set's children.
  2. A NUMBER attribute resolving to the `_null` sentinel (absent `amount`) errors on numeric comparison and aborts the whole condition to default-deny — `NotEquals _null` guards in the same `and{}` do **not** save it. Fix: `MCP Amount` defaultValue `0` (absent = low risk via fall-through). Spec §8's "absent ⇒ not high-risk ⇒ policy 4 handles it" needed this mechanism to actually work.
- **Confirmed — PAZ sideband endpoint `base-path: /mcp`** (was `/portfolio` per spec §7; must match the client-facing path the adapter forwards).
- **Confirmed (verified live, 11/11 matrix):** 50k no-approval→403 `approval_required`; wrong txn→403; mirror→200; 3k→200; absent amount→200; 10000/10001 boundary→200/403; read→200; unknown tool→403; read-only writes→403; bad token→401.
- **Confirmed — `statefulMode: stateless` in `agentgateway.yaml` (uncommitted).** Post-turn user edit: every POST is self-contained, no initialize/session handshake; HITL binding stays token⇄payload via the txn mirror. Also uncommitted: e2e script tweaks (T0 bodyless-GET now sends a valid token so the measured verdict is PAZ default-deny, not 401; verbose-mode default-yes), and mermaid architecture diagrams added to both READMEs.
- **Tentative — optional OIDC refresh token.** The kubeconfig's PingOne OIDC exec plugin has no refresh token in its cache, so cluster auth needs a manual browser login whenever the token expires (~hours) and k9s silently hangs meanwhile. Proposed adding `--offline-access` (or equivalent scope) to the exec args; user hasn't decided.

## Progress and discoveries
- PAP admin API contract established (merge by branch **NAME**, commit body `{"message"}`, export body `[]`, import-vs-merge validation split) — saved in session memory `pap-admin-api-contract.md`, along with the dsconfig no-credentials trick (`--port 1636`, image tool-properties auto-auth) and the `/api/trust-framework/{id}` single-object attribute route.
- The policies are LIVE on the shared dev branch; GDP children are `[Token Validation, APIM Mortgage MCP, AgentGateway Portfolio MCP]`; mortgage content untouched.
- Unit suite: 33/33 (`cd agentgateway && npm test`). Snapshot regenerable via `node test/policy-snapshot/build-portfolio-snapshot.mjs`.
- Unbounded `Subject.Id` queries on the encore-test PAZ return empty (all candidates INDETERMINATE) due to the `Subject.Id $.sub` processor trap — unrelated to this integration; workaround + fix proposal captured in memory `paz-query-debugging.md`.
- Security-boundary notes for the next session: do not read/recreate the `AGENTGATEWAY-SIDEBAND` secret value (user confirmed `.env` has it right; both reads and re-creation were classifier-denied); pod-exec to the PAZ pod for writes was approved by the user during this session but re-confirm before doing it unattended; no Claude/Anthropic attribution in commits (global rule).

## Next steps
1. **Commit the pending local changes** (`git status` shows modified `agentgateway/README.md`, `src/agentgateway.yaml` [statelessMode], `test/policy-e2e-tests.sh`, `azure-apim/README.md`) — user-made edits; confirm intent, then commit without attribution trailers.
2. **Run the formal e2e suite** on the live stack (demo-mcp :3000, adapter :8083, gateway :3001): `cd agentgateway/test && ./policy-e2e-tests.sh` — expect 19/19; the 11-case spot matrix already passed.
3. **Decide the OIDC refresh-token change** for `~/.kube/config` (see Tentative above).
4. Open (low priority): spec §6/§7/§9 drift vs. shipped reality — documented here, not silently rewritten into the spec.

## Resume instructions
Read the spec/plan for design intent, then this handoff for what actually shipped and why it differs. Confirm with the user which next step to start before making changes.

## Coverage limitations
- Conversation context before the mid-session compaction is summarized (the summary was itself the basis for resuming); decisions from that era are recorded in the ledger-of-record files (commits, memory files, test.md) rather than recalled verbatim.
- The `statefulMode: stateless` yaml change and the e2e/README edits arrived as user-side edits near session end — their full rationale beyond the in-file comments was not discussed.

---

# K8s deployment session addendum (2026-10-14, second session)

## Source documents (this session)
- [K8s design spec](../superpowers/specs/2026-10-14-agentgateway-k8s-deployment-design.md)
- [K8s implementation plan](../superpowers/plans/2026-10-14-agentgateway-k8s-deployment-plan.md) — 7 tasks, Tasks 1–6 complete; Task 7 (deploy+verify) finishing

## What shipped (helm chart `agentgateway/k8s/helm/agentgateway-stack`)
Self-contained stack in `ping-devops-fcarbone`: PAZ + PAP (Ping chart 0.15.0, StatefulSets, PAZ **standalone**, image pin 2607, PAZ /opt/out ephemeral), adapter, agentgateway (v1.6.0), demo-mcp; public ingresses for AG + PAP via nginx-public, cert-manager letsencrypt-pdo certificates (operator step: CNAMEs `agentgateway-stack-ag.ping-devops.com` + `agentgateway-stack-pap.ping-devops.com` → NLB `aa1deecbf55244617839c90d58862848-b60a19e7b833da4e.elb.eu-west-1.amazonaws.com`).

## The fault chain Task 7 uncovered (all fixed, commits `15bf897`→`f88e551`)
1. **PAZ crashloop** — image 2608 ships a pre-configured instance → hook 183 "Server Already Configured" forever; pinned 2607. Real first-run errors were dsconfig strict-schema issues (missing `--set enabled:true` on JWT-Lab validator; shared-secret ordering).
2. **PD removal (user-directed)** — PAZ/PAP standalone; went parentless (no baseline parent) which ALSO dropped the PAP external-PDP wiring → PDS 503 until `30-pap-pdp.dsconfig` re-added it in our layer.
3. **Sideband secret desync** — randAlphaNum-in-template regenerates per `helm upgrade`; PAZ bakes the value at bootstrap → 401s. Now create-once (lookup-with-fallback).
4. **Stale cert extraction** — init extracted via ClusterIP svc could capture a terminating pod's cert → TLS trust failures. Now targets the PAZ pod FQDN:1443.
5. **PAP branch model** — Ping 11.1 demo bootstrap root branch is `SYSTEM` (not `defaultPolicies.SNAPSHOT`); import creates its own branch; PDP serves the last COMMITTED snapshot. Full import→commit→merge(USE_TARGET)→commit sequence documented in `server-profiles/pingauthorizepap/policies/README.md`.
6. **T9 expired-token permit** — PAZ 2607 leaves `active` INDETERMINATE on TV failure; inactive-deny (active==false) never fired; unconditional session-methods permit let expired tokens through tools/list. Fixed at the policy layer: session permit now requires `active==true` (builder + test RED→GREEN, suite 20/20).

## Verification state
- helm test: Succeeded (tokenless tools/call denied 401/403; chain + demo-mcp health).
- 19-test matrix: 18/19 with T9 PERMITTED (pre-fix); T9 policy fix deployed to PAP (SYSTEM branch committed, PAZ re-bootstrapped with PDP wiring) — **full matrix re-run pending** as the final gate.

## Resume instructions
If the matrix is not yet green: `cd agentgateway/test && AG_URL=https://agentgateway-stack-ag.ping-devops.com/mcp AUD=https://agentgateway-stack-ag.ping-devops.com ./policy-e2e-tests.sh`. Remaining Task 7 close-out: full matrix, final whole-branch review, CURRENT_STATE trim, finishing-a-development-branch.
