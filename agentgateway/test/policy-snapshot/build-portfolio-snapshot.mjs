#!/usr/bin/env node
// build-portfolio-snapshot.mjs — generate the Portfolio MCP policy snapshot
// from the mortgage template. Regenerating is idempotent (fresh UUIDs on
// changed objects each run; shared token machinery keeps the mortgage ids so
// a branch merge dedupes instead of duplicating).
//
// Content decisions (spec §8, ledger rulings): service + policy set
// "AgentGateway Portfolio MCP"; scopes portfolio:read/portfolio:write; risk
// tiering amount > 10000 via the GreaterThan op; low-risk policy carries no
// amount condition (FirstApplicable makes non-high-risk calls low-risk, so
// absent amount ⇒ low risk); six-field txn-mirror (tool, customerId, symbol,
// side, quantity, amount) + txn == arguments.txn; the snapshot's Global
// Decision Point keeps the name but gets a new id so importing cannot clobber
// the serving branch's GDP — test.md instructs attaching the portfolio set
// under the existing GDP after merge.
import { readFileSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const mortgagePath = path.join(here, "..", "..", "..", "azure-apim", "test", "policy-snapshot", "Mortgage MCP policies.snapshot");
const mortgage = JSON.parse(readFileSync(mortgagePath, "utf8"));

const byName = new Map(mortgage.filter((o) => o.name).map((o) => [o.name, o]));
// Named lookups must disambiguate ServiceDefinition vs PolicySet (both can
// carry the same name); type-keyed lookup serves the nameless package files.
const firstNamed = (name, objectType) => structuredClone(mortgage.find((o) => o.name === name && (objectType ? o.objectType === objectType : o.objectType === undefined)));
const firstTyped = (type) => structuredClone(mortgage.find((o) => o.type === type));
const M = (name) => structuredClone(byName.get(name)); // mortgage template, deep copy
const mId = (name) => byName.get(name)?.id;

const out = [];

// --- package boilerplate (shapes copied from the mortgage EXPORT, which is
// the format the importer consumes: Header, PackageHeader, ENTITIES, then
// two PackageSeparators and EndOfPackage at the very end. The mortgage
// template file we transform carries its separators up front, but a hand-
// assembled package in that order unpacks as empty — the streaming reader
// treats a Separator before any entity as the end of content.) --------------
out.push({ "@class": "DataStreamHeader", kind: "SnapshotHeader", version: 4 });
const pkgHeader = firstTyped("SnapshotPackageFile$PackageHeader");
out.push({ ...pkgHeader, snapshotId: randomUUID() });

// --- service ---------------------------------------------------------------
const SERVICE_ID = randomUUID();
const svc = firstNamed("APIM Mortgage MCP", "ServiceDefinition");
out.push({ ...svc, id: SERVICE_ID, version: randomUUID(), name: "AgentGateway Portfolio MCP", fullName: "AgentGateway Portfolio MCP" });

// --- request-body attributes (all resolve from RequestBody) ----------------
const REQUEST_BODY_ID = mId("RequestBody");
// Same-named attributes reuse the mortgage template's ID: the merge into the
// serving branch dedupes on id+fullName; a new id with the same name trips
// DUPLICATE_FULL_NAME conflicts against the mortgage branch's attributes.
function reuseId(name) {
  return byName.get(name)?.id ?? randomUUID();
}
function mcpAttr(name, expression, valueType, defaultValue = "_null") {
  const tmpl = M("MCP Tool Name");
  return {
    ...tmpl,
    id: reuseId(name),
    version: randomUUID(),
    name,
    fullName: name,
    valueType,
    defaultValue,
    resolvers: [{ ...tmpl.resolvers[0], id: REQUEST_BODY_ID }],
    valueProcessor: { ...tmpl.valueProcessor, expression, valueType, name },
  };
}

const A = {
  method: mcpAttr("MCP Method", "$.method", "STRING"),
  tool: mcpAttr("MCP Tool Name", "$.params.name", "STRING"),
  txn: mcpAttr("MCP Transaction Id", "$.params.arguments.txn", "STRING"),
  // NUMBER + default "0": an ABSENT amount must resolve to a real number.
  // With "_null" the numeric resolution errors and the high-risk policy's
  // GreaterThan aborts the whole condition evaluation to default-deny
  // (observed live: absent-amount orders denied even with the NotEquals
  // guard). "0" keeps absent = low risk through the normal fall-through.
  amount: mcpAttr("MCP Amount", "$.params.arguments.amount", "NUMBER", "0"),
  amountS: mcpAttr("MCP Amount Mirror", "$.params.arguments.amount", "STRING"),
  customer: mcpAttr("MCP Customer Id", "$.params.arguments.customerId", "STRING"),
  symbol: mcpAttr("MCP Symbol", "$.params.arguments.symbol", "STRING"),
  side: mcpAttr("MCP Side", "$.params.arguments.side", "STRING"),
  qty: mcpAttr("MCP Quantity", "$.params.arguments.quantity", "STRING"),
};
for (const a of Object.values(A)) out.push(a);

// --- access-token claim attributes (resolve from AccessToken) --------------
// Templates: txn / approved_for / tctx_change_type / tctx_mortgage_id all
// resolve through the AccessToken attribute; keep their resolver chain.
function claimAttr(name, expression, valueType = "STRING", template = "txn") {
  const tmpl = M(template);
  // fullName must carry the parent chain (HttpRequest.AccessToken.<name>) or
  // the import's constraint check rejects the attribute.
  const fullName = `HttpRequest.AccessToken.${name}`;
  return { ...tmpl, id: reuseId(name), version: randomUUID(), name, fullName, valueProcessor: { ...tmpl.valueProcessor, expression, valueType, name: "" } };
}

const T = {
  txn: claimAttr("txn", "$.txn"),
  approvedFor: claimAttr("approved_for", "$.approved_for", "STRING", "approved_for"),
  tool: claimAttr("tctx_tool", "$.tctx.tool", "STRING", "tctx_change_type"),
  customer: claimAttr("tctx_customer_id", "$.tctx.customerId", "STRING", "tctx_change_type"),
  symbol: claimAttr("tctx_symbol", "$.tctx.symbol", "STRING", "tctx_change_type"),
  side: claimAttr("tctx_side", "$.tctx.side", "STRING", "tctx_change_type"),
  qty: claimAttr("tctx_quantity", "$.tctx.quantity", "STRING", "tctx_change_type"),
  amount: claimAttr("tctx_amount", "$.tctx.amount", "STRING", "tctx_change_type"),
};
for (const t of Object.values(T)) out.push(t);

// Shared token machinery keeps mortgage ids so the merge dedupes:
const SHARED = {
  scope: mId("scope"),
  audience: mId("audience"),
  actSub: mId("act_sub"),
  subType: mId("sub_type"),
  active: mId("active"),
  accessToken: mId("AccessToken"),
  requestBody: REQUEST_BODY_ID,
};

function cmp(leftAttrId, op, right) {
  return { comparison: { left: { attribute: { id: leftAttrId } }, op, right } };
}
const NULL = { constant: { value: "_null" } };

// --- statements (templates reused; only payloads + references change) ------
function stmt(name, templateName, payload, description) {
  const tmpl = M(templateName);
  const s = { ...tmpl, id: randomUUID(), version: randomUUID(), name, description: description ?? "" };
  if (payload !== undefined) s.payload = JSON.stringify(payload);
  return s;
}

const S = {
  readChallenge: stmt("Insufficient Scope Challenge - Read Tools", "Insufficient Scope Challenge - Read Tools", {
    httpStatus: 403,
    error: "insufficient_scope",
    errorDescription: "Tool requires scope portfolio:read",
    scopes: ["portfolio:read"],
  }, "RFC 6750/MCP challenge: read tools require portfolio:read"),
  lowRiskChallenge: stmt("Insufficient Scope Challenge - Low Risk Orders", "Insufficient Scope Challenge - Low Risk Changes", {
    httpStatus: 403,
    error: "insufficient_scope",
    errorDescription: "Low-risk trade orders require scope portfolio:write",
    scopes: ["portfolio:write"],
  }, "RFC 6750/MCP challenge for low-risk orders missing portfolio:write"),
  highRiskChallenge: stmt("Insufficient Scope Challenge - High Risk Orders", "Insufficient Scope Challenge - High Risk Changes", {
    httpStatus: 403,
    error: "insufficient_scope",
    errorDescription: "High-risk trade orders require scope portfolio:write",
    scopes: ["portfolio:write"],
  }, "RFC 6750/MCP challenge for high-risk orders missing portfolio:write"),
  approvalRequired: stmt("Approval Required", "Approval Required", {
    status: 403,
    message: "approval_required",
    detail: "This trade order requires human approval",
  }),
  delegationDenied: stmt("Delegation Not Permitted", "Delegation Not Permitted", {
    status: 403,
    message: "delegation_not_permitted",
    detail: "This subject is not authorized to operate this portfolio via a delegated agent",
  }),
};
for (const s of Object.values(S)) out.push(s);

// --- rules -----------------------------------------------------------------
function rule(name, { description = "", condition = { empty: {} }, effectSettings, statementIds = [] }) {
  // Shape template: the typed lookup (the name "Default Deny" exists as both
  // Policy and Rule, and the name map keeps the Policy).
  const tmpl = mortgage.find((o) => o.type === "Rule" && o.name === "Default Deny");
  return {
    ...structuredClone(tmpl),
    id: randomUUID(),
    version: randomUUID(),
    name,
    description,
    statements: statementIds,
    targets: [],
    effectSettings,
    condition,
  };
}

// Policy 1 — Allow Session Methods (unconditionalPermit on known session methods)
const R_SESSION = rule("Allow MCP session methods", {
  condition: {
    or: {
      conditions: [A.method.id, A.method.id, A.method.id, A.method.id].map((id, i) =>
        cmp(id, "Equals", { constant: { value: ["initialize", "tools/list", "ping", "notifications/initialized"][i] } }),
      ),
    },
  },
  effectSettings: { type: "unconditionalPermit" },
});

// Policy 2 — Delegation gate: act.sub present AND sub_type != vip_user -> deny
const R_DELEGATION = rule("Deny non-VIP subject behind delegated agent", {
  condition: {
    and: {
      conditions: [cmp(SHARED.actSub, "NotEquals", NULL), cmp(SHARED.subType, "NotEquals", { constant: { value: "vip_user" } })],
    },
  },
  effectSettings: { type: "unconditionalDeny" },
  statementIds: [S.delegationDenied.id],
});

// Policy 3 — Read tools: the rule's MAIN condition selects the tools only
// (scope lives solely in effectSettings, as in the template — that placement
// is what turns a scope miss into the insufficient_scope challenge instead
// of a silent fall-through to Default Deny).
const R_READ = rule("Allow portfolio read tools with portfolio:read scope", {
  condition: {
    and: {
      conditions: [
        {
          or: {
            conditions: [A.tool.id, A.tool.id, A.tool.id].map((id, i) =>
              cmp(id, "Equals", { constant: { value: ["get_portfolio_summary", "list_positions", "simulate_trade"][i] } }),
            ),
          },
        },
      ],
    },
  },
  effectSettings: {
    type: "conditionalPermitElseDeny",
    condition: { and: { conditions: [cmp(SHARED.scope, "Contains", { constant: { value: "portfolio:read" } })] } },
  },
  statementIds: [S.readChallenge.id],
});

// Policy 4 — Low-risk orders: any submit_trade_order (scope checked in
// effectSettings; absent amount ⇒ low risk). The set evaluates policies
// FirstApplicable, so the HIGH-RISK policy must come FIRST in the children
// list (high selects on amount > 10000, low matches every order); ordering
// low first made it swallow high-risk orders (observed live: a 50k order
// without approval PERMITTED).
const R_LOW = rule("Allow low risk orders with portfolio:write scope", {
  condition: { and: { conditions: [cmp(A.tool.id, "Equals", { constant: { value: "submit_trade_order" } })] } },
  effectSettings: {
    type: "conditionalPermitElseDeny",
    condition: { and: { conditions: [cmp(SHARED.scope, "Contains", { constant: { value: "portfolio:write" } })] } },
  },
  statementIds: [S.lowRiskChallenge.id],
});

// Policy 5 — High-risk orders (amount > 10000) with HITL:
//   rule 5a: unconditionalDeny w/ insufficient_scope challenge when write scope missing
const R_HIGH_SCOPE = rule("High-risk orders require portfolio:write scope", {
  condition: {
    and: {
      conditions: [cmp(SHARED.scope, "NotContains", { constant: { value: "portfolio:write" } })],
    },
  },
  effectSettings: { type: "unconditionalDeny" },
  statementIds: [S.highRiskChallenge.id],
});

//   rule 5b: conditionalPermitElseDeny — permit only when the approval token
//   mirrors the payload exactly (six tctx fields + txn + approved_for) AND
//   write scope present; amount equality via the STRING mirror pair.
const R_HIGH_MIRROR = rule("Risky orders require approval bound to the transaction", {
  description: "PERMIT when the approval token's txn/tctx claims mirror the tool-call payload exactly; DENY (with approval_required) otherwise.",
  effectSettings: { type: "conditionalPermitElseDeny" },
  statementIds: [S.approvalRequired.id],
});

const mirrorInner = {
  and: {
    conditions: [
      cmp(T.txn.id, "NotEquals", NULL),
      cmp(T.approvedFor.id, "NotEquals", NULL),
      cmp(T.approvedFor.id, "Equals", { attribute: { id: A.tool.id } }),
      cmp(T.tool.id, "Equals", { attribute: { id: A.tool.id } }),
      cmp(T.customer.id, "Equals", { attribute: { id: A.customer.id } }),
      cmp(T.symbol.id, "Equals", { attribute: { id: A.symbol.id } }),
      cmp(T.side.id, "Equals", { attribute: { id: A.side.id } }),
      cmp(T.qty.id, "Equals", { attribute: { id: A.qty.id } }),
      cmp(T.amount.id, "Equals", { attribute: { id: A.amountS.id } }),
      cmp(T.txn.id, "Equals", { attribute: { id: A.txn.id } }),
    ],
  },
};
R_HIGH_MIRROR.effectSettings.condition = {
  and: { conditions: [mirrorInner, cmp(SHARED.scope, "Contains", { constant: { value: "portfolio:write" } })] },
};

// Policy 6 — Default Deny (shape copied from template, new ids)
const R_DEFAULT = rule("Default Deny", { effectSettings: { type: "unconditionalDeny" } });

// Emit the rules themselves — Policies only reference them by id.
for (const r of [R_SESSION, R_DELEGATION, R_READ, R_LOW, R_HIGH_SCOPE, R_HIGH_MIRROR, R_DEFAULT]) out.push(r);

// --- policies (shape template: mortgage Policy objects) --------------------
function policy(name, childIds, condition = { empty: {} }) {
  const tmpl = M("Default Deny");
  // Default Deny exists as both Policy and Rule; grab the Policy shape
  const polTemplate = mortgage.find((o) => o.type === "Policy" && o.name === "Default Deny");
  return {
    ...structuredClone(polTemplate),
    id: randomUUID(),
    version: randomUUID(),
    name,
    combiningAlgorithm: { algorithm: "FirstApplicable", evaluateAll: false },
    children: childIds.map((id) => ({ id, type: "Rule" })),
    statements: [],
    targets: [],
    condition,
  };
}

const P_SESSION = policy("Allow Session Methods", [R_SESSION.id]);
const P_DELEGATION = policy("Allow Delegated Token by VIP Users Only", [R_DELEGATION.id]);
const P_READ = policy("Allow read operations", [R_READ.id]);
const P_LOW = policy("Allow low risk orders", [R_LOW.id]);

// High Risk Orders with HITL: policy-level condition selects tool + amount>10000.
// The NotEquals-_null guard is load-bearing: with an ABSENT amount the attribute
// resolves to the "_null" sentinel, and a numeric GreaterThan against it aborts
// the whole policy evaluation to default-deny (observed live: absent-amount
// orders were denied with the generic Access Denied after the high policy moved
// before low). The guard keeps absent-amount orders falling through to low.
const P_HIGH = policy("High Risk Orders with HITL", [R_HIGH_SCOPE.id, R_HIGH_MIRROR.id], {
  and: {
    conditions: [
      cmp(A.tool.id, "Equals", { constant: { value: "submit_trade_order" } }),
      cmp(A.amount.id, "NotEquals", NULL),
      cmp(A.amount.id, "GreaterThan", { constant: { value: 10000 } }),
    ],
  },
});

const P_DEFAULT = policy("Default Deny", [R_DEFAULT.id]);
// Emit the policies (rules were pushed above).
for (const p of [P_SESSION, P_DELEGATION, P_READ, P_LOW, P_HIGH, P_DEFAULT]) out.push(p);

// --- shared token machinery --------------------------------------------------
// The claim-attribute resolver chains reference condition definitions and
// attributes by the mortgage ids; those objects must exist in the snapshot.
// Copy them verbatim (same ids) from the template, including the parents the
// claim chain hangs off (HttpRequest, Constants). Everything else a shipped
// object references — condition definitions and the ActionDefinitions they
// point at — is pulled verbatim by the ref-sweep below.
const SHARED_OBJECT_NAMES = ["active", "scope", "audience", "act_sub", "sub_type", "AccessToken", "HttpRequest", "Constants", "RequestBody"];
for (const name of SHARED_OBJECT_NAMES) {
  const o = byName.get(name);
  if (o) out.push(structuredClone(o));
}

function collectRefs(node, acc = new Set()) {
  if (!node || typeof node !== "object") return acc;
  if (Array.isArray(node)) {
    for (const n of node) collectRefs(n, acc);
    return acc;
  }
  for (const [k, v] of Object.entries(node)) {
    if ((k === "id" || k === "reference") && typeof v === "string" && v.includes("-") && !acc.has(v)) {
      // ids are UUIDs; references appear as {reference:{id}} or map keys
      acc.add(v);
    } else if (k === "reference" && v && typeof v === "object" && v.id) {
      acc.add(v.id);
    }
    collectRefs(v, acc);
  }
  return acc;
}

// --- the portfolio policy set + target -------------------------------------
const TARGET_ID = randomUUID();
const targetTemplate = firstNamed("Inline target");
out.push({ ...targetTemplate, id: TARGET_ID, version: randomUUID(), targeted: { services: [SERVICE_ID] } });

const portfolioSet = mortgage.find((o) => o.type === "PolicySet" && o.name === "APIM Mortgage MCP");
out.push({
  ...structuredClone(portfolioSet),
  id: randomUUID(),
  version: randomUUID(),
  name: "AgentGateway Portfolio MCP",
  // TV is owned by the Global Decision Point alone (template layout) — a
  // policy with two parents fails the import's constraint checks.
  // High-risk BEFORE low-risk (FirstApplicable): high selects on the amount
  // condition, so only >10000 orders reach its rules; everything else —
  // including absent amount — falls through to the low-risk policy.
  children: [P_SESSION.id, P_DELEGATION.id, P_READ.id, P_HIGH.id, P_LOW.id, P_DEFAULT.id].map((id) => ({ id, type: "Policy" })),
  targets: [TARGET_ID],
});

// NO Global Decision Point and NO Token Validation ship in the snapshot —
// both already live in the serving branch, and re-shipping them either fails
// the import (their children must resolve inside the package, dragging the
// entire mortgage subtree along) or fails the merge (a fresh-id TV claiming
// the shared inactive rule = two parents). Instead:
//   1. this snapshot merges in the portfolio content (all fresh ids);
//   2. test.md §1.2 step 3 (or the PAP admin API) attaches
//      `AgentGateway Portfolio MCP` as a second PolicySet child of the
//      serving branch's existing GDP — the same manual step the APIM
//      integration documents.
// The ref-sweep (below) closes the package over the objects above only.

// Ref-sweep over EVERY emitted object: any referenced mortgage id that
// hasn't shipped yet — statements, condition definitions, the
// ActionDefinitions they point at — gets copied verbatim.
const produced = new Set(out.map((o) => o.id));
const sweep = [...out];
for (let i = 0; i < sweep.length; i++) {
  for (const ref of collectRefs(sweep[i])) {
    if (produced.has(ref)) continue;
    const o = mortgage.find((x) => x.id === ref);
    if (o) {
      const copy = structuredClone(o);
      out.push(copy);
      sweep.push(copy); // the copy may reference more objects
      produced.add(ref);
    }
  }
}

// --- end boilerplate --------------------------------------------------------
// Entity ORDER matters to the importer: the mortgage export (the format the
// unpacker consumes) streams ALL definition-class objects first, then the
// policy-manager objects (Rules, Statements, Policies, Target, PolicySets)
// at the end. Our construction interleaves them (shared-machinery copies
// land after the policies), so reorder before writing: partition into
// definitions and policy objects, preserving relative order in each group.
const DEFINITION_TYPES = new Set(["ServiceDefinition", "AttributeDefinition", "ActionDefinition", "ConditionDefinition", "TestCaseDefinition", "AssertionDefinition", "TestScenarioDefinition"]);
// leading boilerplate (DataStreamHeader + PackageHeader) stays in front;
// only the ENTITY objects get partitioned.
const isEntity = (o) => !o["@class"] && !(o.type ?? "").startsWith("SnapshotPackageFile");
const lead = out.slice(0, 2).filter((o) => !isEntity(o));
const entities = out.filter(isEntity);
const definitions = entities.filter((o) => DEFINITION_TYPES.has(o.objectType) || DEFINITION_TYPES.has(o.type));
const policyObjects = entities.filter((o) => !definitions.includes(o));
// The unpacker is PHASED (disassembly of SymphonicDataSnapshotUnpacker):
// loadTrustFramework reads Definitions until a PackageSeparator, then
// loadPolicyManagerEntities reads any Entity until the next Separator. A
// separator MUST sit between the definition section and the policy section,
// or the first policy object throws "Expected a Definition object".
const sepTemplate = mortgage.find((x) => x.type === "SnapshotPackageFile$PackageSeparator");
out.length = 0;
out.push(...lead, ...definitions, { ...sepTemplate }, ...policyObjects);

// Second separator + EndOfPackage close the policy section.
for (const o of mortgage.filter((x) => x.type === "SnapshotPackageFile$PackageSeparator").slice(1)) out.push({ ...o });
for (const o of mortgage.filter((x) => x.type === "SnapshotPackageFile$EndOfPackage")) out.push({ ...o });

// The PAP's JsonDataInputStream REQUIRES a DataStreamFooter: it hashes every
// parsed element (SHA-256 of each element's compact JSON, concatenated) and
// refuses the stream with "No footer found in JsonDataInputStream" otherwise.
// Digest scheme reverse-engineered from the shipped encryption jar and
// verified byte-for-byte against the mortgage snapshot's export.
import { createHash } from "node:crypto";
const digest = createHash("sha256");
for (const o of out) digest.update(JSON.stringify(o));
const digestB64 = digest.digest("base64");
out.push({ "@class": "DataStreamFooter", digest: digestB64 });

const target = path.join(here, "Portfolio MCP policies.snapshot");
writeFileSync(target, JSON.stringify(out));
console.log(`wrote ${target} (${out.length} objects, digest ${digestB64.slice(0, 12)}…)`);
