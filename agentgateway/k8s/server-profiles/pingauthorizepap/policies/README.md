# Portfolio MCP policies — deployment runbook

`Portfolio-MCP-policies.full-branch.SNAPSHOT` is imported into PAP by the
bootstrap hook (profile `policies/` staging). The Ping 11.1 `setup demo`
bootstrap names the root branch **SYSTEM**; the import lands in its OWN branch
(named after the snapshot file) and must be merged + committed before PAZ's
external PDP sees the policies. This file records the exact sequence and the
two non-obvious contracts that cost debugging time.

## Import/merge/commit sequence (PAP admin API)

Basic auth `administrator:<admin password>`, headers `X-XSRF-HEADER: ping` and
`x-user-id: <anything>` on every call.

1. **Import** — `POST /api/snapshot/<branch-name>/import` with the snapshot
   file as the RAW body (`application/json`; it is a JSON array). Creates a
   branch named `<branch-name>`.
2. **Commit the import branch** — `POST /api/version-control/branches/<id>/commit`
   with `{"message":"…"}`. Merging an uncommitted source branch fails with
   `MergeFailure: source branch has uncommitted deltas`.
3. **Merge into SYSTEM** — `POST /api/version-control/branches/<SYSTEM-id>/merge`
   with `{"fromBranchId":"<import-branch-id>","resolutions":[…]}`. Resolutions
   use `{"entityReference":{"id":…,"type":"PolicySet"},"resolutionType":"USE_TARGET"}`
   (keep SYSTEM's copy). **Two id namespaces — do not conflate them:** the
   PolicySet named `Global Decision Point` in the version-control tree shares
   the snapshot's pinned id (`a7c4e2d0-…`, inherited from the mortgage
   template), while PAZ's `decision-node` property pins the ENGINE-side
   DecisionNode id (`7d0e390b-…`, the demo bootstrap's — see the next
   section). They are different entities and different values by design. On
   merge, a `Global Decision Point` PolicySet id conflict resolves USE_TARGET.
4. **Commit SYSTEM** — same commit verb; the PDP serves the last COMMITTED
   snapshot, so this step is what makes the policies live. PAZ picks the new
   package up automatically (may take ~15 s).
5. **If a re-import collides** (fresh-id duplicates of definitions SYSTEM
   already has → 13 `ValidDefinition` violations on merge), patch the affected
   rule/policy IN PLACE instead: GET with `?branch=<SYSTEM-id>`, mutate, PUT
   (same `version` for updates; POST-create takes NO `version`), then commit.
   This is how the T9 session-permit gate + invalid-token deny rule landed.

## Snapshot self-containment

The bootstrap hook's import runs `find` over the staged files, so filenames
must not contain spaces (hence the dot-separated name above). The snapshot
must be a closed package: every referenced id — including bare-UUID entries in
`statements[]` arrays — must ship inside the file. The builder
(`test/policy-snapshot/build-portfolio-snapshot.mjs --full-branch`) performs
the ref-sweep at build time; the integration plan then proves the imported
tree end-to-end against live PAP.

## Decision node id

PAZ's policy external server pins `decision-node`, the ENGINE-side
DecisionNode id PAP's `setup demo` generates (distinct from the
version-control tree's PolicySet id — see step 3 above). Empirically
deterministic across reinstalls of the same demo setup (`7d0e390b-…`
survived a full PVC wipe re-bootstrap; the Ping baseline profile's
`e51688ff-…` belongs to Ping's sample deployment, not this stack). To
recover the id for a given PAP: strings around `Global Decision Point` in
the engine H2 db `Symphonic.mv.db`, then validate by POSTing
`/api/governance-engine/?branch=SYSTEM` with header `X-Decision-Node: <id>`
(404 `NoSuchElement` = wrong id). It is pinned in
`server-profiles/pingauthorize/pd.profile/dsconfig/30-pap-pdp.dsconfig`.
