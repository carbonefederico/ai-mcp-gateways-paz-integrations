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
DecisionNode id PAP's `setup demo` generates (distinct from the
version-control tree's PolicySet id). Empirically deterministic across
reinstalls of the same demo setup (`7d0e390b-…` survived a full PVC wipe
re-bootstrap; the Ping baseline profile's `e51688ff-…` belongs to Ping's
sample deployment, not this stack). To recover the id for a given PAP:
strings around `Global Decision Point` in the engine H2 db `Symphonic.mv.db`,
then validate by POSTing `/api/governance-engine/?branch=AgentGatewayPortfolioMCP`
with header `X-Decision-Node: <id>`.
