# Server profiles — agentgateway-stack bootstrap

The Ping chart clones these profiles into the PAZ and PAP containers at
startup (`SERVER_PROFILE_URL` points at this repo). Two layers:

- **`pingauthorize/`** — dsconfig additions applied at PAZ first start via
  `pd.profile/dsconfig/`: the jwt-lab external server + JWT token validator
  and the sideband shared secret + endpoint. Layered UNDER the stock
  `paz-pap-integration/pingauthorize` profile (`SERVER_PROFILE_PARENT`),
  which wires the PAP external decision server and `pdp-mode: external`.
- **`pingauthorizepap/policies/`** — policy snapshots the PAP imports as new
  branches at first start (standard hook: `/opt/staging/policies/*.SNAPSHOT`
  → `POST /api/snapshot/<name>/import`).

Environment contract: the PAZ layer substitutes `${SIDEBAND_SHARED_SECRET}`
(pod env injected from the K8s Secret `agentgateway-stack-sideband`, key
`SECRET_HEADER_VALUE` — the same value the adapter reads). All other
`${...}` expansion is environment-variable based per the standard `.subst`
mechanism; the file must not contain any other `$` sequences.

Regenerate the full-branch snapshot after policy changes:

```bash
cd agentgateway
node test/policy-snapshot/build-portfolio-snapshot.mjs --full-branch
```
