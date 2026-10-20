# Server profiles — agentgateway-stack bootstrap

The Ping chart clones these profiles into the PAZ and PAP containers at
startup (`SERVER_PROFILE_URL` points at this repo, `SERVER_PROFILE_PATH` at
each layer below — no parent profile: PAZ bootstraps standalone from this
layer alone). Two layers:

- **`pingauthorize/`** — dsconfig additions applied at PAZ first start via
  `pd.profile/dsconfig/`: the jwt-lab external server + JWT token validator,
  the sideband shared secret + endpoint (endpoint service = the GENERIC
  `AgentGateway` service — see the comment in `40-agp.dsconfig.subst`), and
  the PAP external decision server wiring (branch + decision-node pin in
  `30-pap-pdp.dsconfig`).
- **`pingauthorizepap/policies/`** — the branch snapshot
  `AgentGatewayPortfolioMCP.SNAPSHOT`, imported into branch
  `AgentGatewayPortfolioMCP` and COMMITTED by the profile hook override
  `pingauthorizepap/hooks/81-install-policies.sh` at first start.
  `pingauthorize/hooks/50-before-post-start.sh` holds PAZ's server start
  until that commit lands (the PDP resolves the branch once at boot; losing
  that race locks in an empty package). Contracts and the manual equivalent
  of both hooks: [`pingauthorizepap/policies/README.md`](pingauthorizepap/policies/README.md).

Environment contract: the PAZ layer substitutes `${SIDEBAND_SHARED_SECRET}`
(pod env injected from the K8s Secret `agentgateway-stack-sideband`, key
`SECRET_HEADER_VALUE` — the same value the adapter reads). All other
`${...}` expansion is environment-variable based per the standard `.subst`
mechanism; the file must not contain any other `$` sequences.

Editing policies: never fork a scratch branch — edit the live branch in
place (export committed head → mutate → delete → re-import same name →
commit), then export the committed head over
`pingauthorizepap/policies/AgentGatewayPortfolioMCP.SNAPSHOT` so the repo
bootstrap stays in sync. The full procedure:
[`pingauthorizepap/policies/README.md`](pingauthorizepap/policies/README.md).
