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
   (keep SYSTEM's copy). The full-branch snapshot re-ships the Global Decision
   Point with the same id the demo bootstrap created — resolve it USE_TARGET.
4. **Commit SYSTEM** — same commit verb; the PDP serves the last COMMITTED
   snapshot, so this step is what makes the policies live. PAZ picks the new
   package up automatically (may take ~15 s).

## Snapshot self-containment

The bootstrap hook's import runs `find` over the staged files, so filenames
must not contain spaces (hence the dot-separated name above). The snapshot
must be a closed package: every referenced id — including bare-UUID entries in
`statements[]` arrays — must ship inside the file. The builder
(`test/policy-snapshot/build-portfolio-snapshot.mjs --full-branch`) performs
the ref-sweep; `test/portfolio-snapshot.test.mjs` asserts it.

## Decision node id

PAZ's policy external server pins `decision-node`, which is PAP's Global
Decision Point id **generated per install** by `setup demo` — not a product
constant. After a PAP state wipe, the new id must be read from PAP (engine H2
db `Symphonic.mv.db`, strings around `Global Decision Point`) and set on PAZ
(`dsconfig set-external-server-prop --server-name pingauthorizepap --set
decision-node:<id>`), which lives in
`server-profiles/pingauthorize/pd.profile/dsconfig/30-pap-pdp.dsconfig`.
