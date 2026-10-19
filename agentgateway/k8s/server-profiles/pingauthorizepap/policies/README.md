# Portfolio MCP policies — deployment runbook

`AgentGatewayPortfolioMCP.SNAPSHOT` is imported into PAP by the bootstrap
hook (profile `policies/` staging) into a branch named after the snapshot
file. Branches deploy directly: PAZ's `branch:` property (see
`server-profiles/pingauthorize/pd.profile/dsconfig/30-pap-pdp.dsconfig`)
points at `AgentGatewayPortfolioMCP`, so no merge into the root SYSTEM branch
is ever needed. This file records the sequence and the two non-obvious
contracts that cost debugging time.

## Import sequence (automated by the bootstrap hook; manual equivalent)

Basic auth `administrator:<admin password>`, headers `X-XSRF-HEADER: ping` and
`x-user-id: <anything>` on every call.

1. **Import** — `POST /api/snapshot/AgentGatewayPortfolioMCP/import` with the
   snapshot file as the RAW body (`application/json`; it is a JSON array).
   Imports ALWAYS create a branch — the name in the URL is the new branch's
   name, never an existing branch id (a taken name 409s).
2. **Commit** — `POST /api/version-control/branches/<id>/commit` with
   `{"message":"…"}`. The PDP serves the last COMMITTED snapshot; an
   uncommitted working copy is invisible to PAZ.
3. **Deploy** — already wired: `dsconfig … --set branch:AgentGatewayPortfolioMCP`
   on PAZ's `pingauthorizepap` external server (~15 s to take effect).

## Editing policies

Never fork a scratch branch per edit — edit the live branch in place:
export its committed tip (`POST /api/snapshot/<headId>/export`, body `[]`),
mutate the objects, DELETE the branch, re-import under the SAME name, commit.
The PDP pin is by branch name, so it survives the delete/reimport (a few
seconds un-served). Snapshot packaging contract: definitions section →
`PackageSeparator` → policy objects → `PackageSeparator` → `EndOfPackage`,
digest = SHA-256 over each element's `JSON.stringify` computed in node.

## Snapshot self-containment

The bootstrap hook's import runs `find` over the staged files, so filenames
must not contain spaces (hence the dot-separated name). The snapshot must be
a closed package: every referenced id — including bare-UUID entries in
`statements[]` arrays — must ship inside the file. PAP entities are
single-parent: a Statement referenced by several rules must exist once per
referencing rule (clone with a fresh id), and a duplicated object in one
package fails with a bogus "outdated version" error.

## Decision node id

PAZ's policy external server pins `decision-node`, the ENGINE-side
DecisionNode id (distinct from the version-control tree's PolicySet ids).
The Global Decision Point (GDP) PolicySet — the DecisionNode the PDP
evaluates — ships INSIDE the branch snapshot (a branch export carries the
whole tree from the GDP down), so the id is whatever the staged
`AgentGatewayPortfolioMCP.SNAPSHOT` says: `a7c4e2d0-…`, pinned in
`pingauthorize/pd.profile/dsconfig/30-pap-pdp.dsconfig`. Deterministic for
this snapshot, NOT a product constant — a snapshot with a re-created GDP
carries a new id and the dsconfig must follow. A mismatched id makes PAZ's
PDP return 503 REQUEST_FAILED. To validate against a running PAP: POST
`/api/governance-engine/?branch=AgentGatewayPortfolioMCP` (JSON `{}` body)
with header `X-Decision-Node: <id>` — 200 with a `decision` field is a
match, 404 NoSuchElement is not.

## Bootstrap hooks (profile overrides)

Both Ping products run numbered hooks from `${STAGING_DIR}/hooks/`; a
server profile's `hooks/` directory merges over the image's stock hooks
(hook 02 does `cp -Rf profile/. staging/`), so same-named files override
stock behavior:

- `pingauthorizepap/hooks/81-install-policies.sh` — overrides the stock
  import hook, which used the filename INCLUDING the `.SNAPSHOT` extension
  as the branch name and never committed (PDP serves only committed
  snapshots). Ours strips the extension and commits; restart-safe (skips
  when the branch is already COMMITTED).
- `pingauthorize/hooks/50-before-post-start.sh` — gates PAZ's server start
  on the PAP branch being present and COMMITTED. Without it PAZ's PDP
  resolves the branch once at boot; losing that race (PAZ ready before PAP
  has committed) locks in an empty package (`snapshotId=""`), every
  decision comes back NOT_APPLICABLE, and no restart of PAP fixes it —
  only a PAZ rebuild after PAP has committed.
