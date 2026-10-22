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
//
// --full-branch: emit a SECOND artifact (k8s/server-profiles/pingauthorizepap/
// policies/…) that additionally ships the Token Validation policy set and a
// Global Decision Point whose children are [TV, portfolio set] — the complete
// branch a FRESH PAP imports at first start (hook 81). The merge variant's
// output path and content are untouched in this mode.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

const FULL_BRANCH = process.argv.includes("--full-branch");
// Fixed GDP id: the PAZ profile layer (k8s/server-profiles/.../pd.profile)
// pins its external-server decision-node wiring to this literal. DO NOT
// randomize — the PAZ→PAP bootstrap must resolve the same node every import.
const GDP_ID = "a7c4e2d0-8f11-4b5a-9c3d-6e8f2a1b4c7d";

// Stable ids for the portfolio-owned objects, pinned to the values COMMITTED
// on the live serving branch. Portfolio-only names aren't in the mortgage
// template, so reuseId() used to fall through to randomUUID() — every
// builder run minted fresh ids, and re-importing into a branch that already
// held the previous run's content hit DUPLICATE_FULL_NAME violations the
// merge API cannot skip (it only resolves conflicts, not violating CREATEs).
// Pinning keeps regeneration idempotent: re-imports dedupe to plain
// same-id conflicts, resolvable with USE_TARGET.
const LIVE = {
  service: "d7ce04dc-4d4c-491b-8f6f-2046e0668a04",
  set: "7d0e390b-2b24-49a0-aa67-a85639640722",
  target: "ae233328-0377-4cc0-965f-503ec05893b6",
  attr_amount: "0c62c853-89f1-4b92-874e-645289feac98",
  attr_amount_mirror: "dba0471d-5f17-4f82-a5b0-564df45c8d39",
  attr_customer: "94037ec1-3f2d-49f2-becb-6b408fab2dbb",
  attr_symbol: "b3680251-7c48-4e67-b91a-dbb7921ae12b",
  attr_side: "48b21574-7238-42ef-8f28-a207e7c626ec",
  attr_qty: "f23bd62b-5b25-4046-907f-338f3df77598",
  attr_tctx_amount: "3bf6ec43-9482-4c58-9036-954248161511",
  attr_tctx_customer_id: "e7b6cf1d-4e23-4ac3-9bc8-1123e1520c6e",
  attr_tctx_quantity: "87d0ba1f-d8d9-4ffd-9004-dca9bb759c42",
  attr_tctx_side: "77fee6c4-62b5-4fab-9e9a-0eaff14d8bd7",
  attr_tctx_symbol: "b40753b6-adaf-4c3a-8345-568baa6214c4",
  attr_tctx_tool: "51d2c466-c9e0-4448-b1e1-d3a7a0d7516e",
  stmt_read: "6239d2e1-e0f2-44fd-8c6d-de20a59ee802",
  stmt_low: "ae57e179-4520-478c-85d0-6bc52f3de681",
  stmt_high: "6cd9496f-575e-4738-ae24-7db63b1b6e70",
  stmt_approval: "21cbb461-05e7-4e49-83c2-04f81ef116fd",
  stmt_delegation: "5ec3e0c2-ea0c-4d26-9b20-59356d9d2abd",
  rule_session: "4429ea9a-eca5-4409-9288-832f2105a923",
  rule_session_invalid: "967df7ee-63a0-4ecb-bfbb-a39cc3d38f8a",
  rule_delegation: "7ba55878-40ba-4d5a-ae0a-3131a96400d7",
  rule_read: "ec8fe0e0-34d6-464b-b3f5-5dd8560451b2",
  rule_low: "80fc7785-51d1-490b-9f45-ac1c489da232",
  rule_high_scope: "f39d4abe-f1fd-47d7-a312-6b038215ca17",
  rule_high_mirror: "c2ff86c1-9741-4d19-9ea6-7b77768fd89c",
  rule_default: "6e82ab78-fdf6-42b6-ba4f-af4259e118f7",
  pol_session: "bef782ac-1c97-4f8a-aeed-7d2b0a67fa6b",
  pol_delegation: "c8cbb351-32b9-47df-b631-dd4204a1f341",
  pol_read: "86fa1593-59ff-4cfa-a47f-0074dcf936dc",
  pol_high: "87693d9a-5414-4360-a043-8f153d52608b",
  pol_low: "4f3ca0f0-b7dd-4b14-83b8-ee72cbb275b7",
  pol_default: "a7d01939-808b-4588-98f0-5138d4c730be",
};

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
// Attribute ids already emitted, so the full-branch baseline block (below)
// doesn't re-ship a portfolio attribute with the same template id.
const producedAttrs = new Set();

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
const SERVICE_ID = LIVE.service;
const svc = firstNamed("APIM Mortgage MCP", "ServiceDefinition");
out.push({ ...svc, id: SERVICE_ID, version: randomUUID(), name: "AgentGateway Portfolio MCP", fullName: "AgentGateway Portfolio MCP" });

// --- request-body attributes (all resolve from RequestBody) ----------------
const REQUEST_BODY_ID = mId("RequestBody");
// Same-named attributes reuse the mortgage template's ID: the merge into the
// serving branch dedupes on id+fullName; a new id with the same name trips
// DUPLICATE_FULL_NAME conflicts against the mortgage branch's attributes.
function reuseId(name) {
  return byName.get(name)?.id ?? ATTR_LIVE_IDS[name] ?? randomUUID();
}

// Portfolio attribute names -> live committed ids (see LIVE above).
const ATTR_LIVE_IDS = {
  "MCP Amount": LIVE.attr_amount,
  "MCP Amount Mirror": LIVE.attr_amount_mirror,
  "MCP Customer Id": LIVE.attr_customer,
  "MCP Symbol": LIVE.attr_symbol,
  "MCP Side": LIVE.attr_side,
  "MCP Quantity": LIVE.attr_qty,
  tctx_amount: LIVE.attr_tctx_amount,
  tctx_customer_id: LIVE.attr_tctx_customer_id,
  tctx_quantity: LIVE.attr_tctx_quantity,
  tctx_side: LIVE.attr_tctx_side,
  tctx_symbol: LIVE.attr_tctx_symbol,
  tctx_tool: LIVE.attr_tctx_tool,
};
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
for (const a of Object.values(A)) { out.push(a); producedAttrs.add(a.id); }

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
for (const t of Object.values(T)) { out.push(t); producedAttrs.add(t.id); }

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
  const s = { ...tmpl, id: STMT_LIVE_IDS[name] ?? randomUUID(), version: randomUUID(), name, description: description ?? "" };
  if (payload !== undefined) s.payload = JSON.stringify(payload);
  return s;
}

// Statement names -> live committed ids.
const STMT_LIVE_IDS = {
  "Insufficient Scope Challenge - Read Tools": LIVE.stmt_read,
  "Insufficient Scope Challenge - Low Risk Orders": LIVE.stmt_low,
  "Insufficient Scope Challenge - High Risk Orders": LIVE.stmt_high,
  "Approval Required": LIVE.stmt_approval,
  "Delegation Not Permitted": LIVE.stmt_delegation,
};

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
    id: RULE_LIVE_IDS[name] ?? randomUUID(),
    version: randomUUID(),
    name,
    description,
    statements: statementIds,
    targets: [],
    effectSettings,
    condition,
  };
}

// Policy 1 — Allow Session Methods (unconditionalPermit on known session
// methods, gated on an ACTIVE token: active == true. Without the positive
// gate, an expired/indeterminate token rides through on the method match
// alone — the shared inactive-deny rule only fires on a resolvable
// active == false, and PAZ leaves active indeterminate when the token
// validator fails outright (observed live on PAZ 2607 sideband: T9 expired
// token PERMITTED on tools/list). With the gate, invalid or indeterminate
// tokens fall through to default deny.)
// Rule / Policy names -> live committed ids.
const RULE_LIVE_IDS = {
  "Allow MCP session methods": LIVE.rule_session,
  "Session methods with invalid token": LIVE.rule_session_invalid,
  "Deny non-VIP subject behind delegated agent": LIVE.rule_delegation,
  "Allow portfolio read tools with portfolio:read scope": LIVE.rule_read,
  "Allow low risk orders with portfolio:write scope": LIVE.rule_low,
  "High-risk orders require portfolio:write scope": LIVE.rule_high_scope,
  "Risky orders require approval bound to the transaction": LIVE.rule_high_mirror,
  "Default Deny": LIVE.rule_default,
};
const POLICY_LIVE_IDS = {
  "Allow Session Methods": LIVE.pol_session,
  "Allow Delegated Token by VIP Users Only": LIVE.pol_delegation,
  "Allow read operations": LIVE.pol_read,
  "High Risk Orders with HITL": LIVE.pol_high,
  "Allow low risk orders": LIVE.pol_low,
  "Default Deny": LIVE.pol_default,
};

const R_SESSION = rule("Allow MCP session methods", {
  condition: {
    and: {
      conditions: [
        cmp(SHARED.active, "Equals", { constant: { value: "true" } }),
        {
          or: {
            conditions: [A.method.id, A.method.id, A.method.id, A.method.id].map((id, i) =>
              cmp(id, "Equals", { constant: { value: ["initialize", "tools/list", "ping", "notifications/initialized"][i] } }),
            ),
          },
        },
      ],
    },
  },
  effectSettings: { type: "unconditionalPermit" },
});

// Policy 1b — Session methods with an inactive/indeterminate token -> 401
// (carries the shared TV "Invalid Token" statement). Without this, an
// expired/indeterminate token falls past the gated permit to the generic
// Default Deny (403) instead of the correct 401 invalid_token. The
// NotEquals-true comparison covers active == false AND active unresolved
// (indeterminate) — both are non-valid tokens.
// The statement itself ships via the TV policy in full-branch mode; the
// ref-sweep pulls it in for the rule's statements[] reference.
const R_SESSION_INVALID = rule("Session methods with invalid token", {
  description: "Session methods are permitted only for a valid token; anything else gets the 401 invalid_token challenge.",
  condition: {
    and: {
      conditions: [
        cmp(SHARED.active, "NotEquals", { constant: { value: "true" } }),
        {
          or: {
            conditions: [A.method.id, A.method.id, A.method.id, A.method.id].map((id, i) =>
              cmp(id, "Equals", { constant: { value: ["initialize", "tools/list", "ping", "notifications/initialized"][i] } }),
            ),
          },
        },
      ],
    },
  },
  effectSettings: { type: "unconditionalDeny" },
  statementIds: ["cde26a38-2035-4385-bbfe-159ee1822976"], // mortgage TV's Invalid Token statement (401 invalid_token)
});
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
for (const r of [R_SESSION, R_SESSION_INVALID, R_DELEGATION, R_READ, R_LOW, R_HIGH_SCOPE, R_HIGH_MIRROR, R_DEFAULT]) out.push(r);

// --- policies (shape template: mortgage Policy objects) --------------------
function policy(name, childIds, condition = { empty: {} }) {
  const tmpl = M("Default Deny");
  // Default Deny exists as both Policy and Rule; grab the Policy shape
  const polTemplate = mortgage.find((o) => o.type === "Policy" && o.name === "Default Deny");
  return {
    ...structuredClone(polTemplate),
    id: POLICY_LIVE_IDS[name] ?? randomUUID(),
    version: randomUUID(),
    name,
    combiningAlgorithm: { algorithm: "FirstApplicable", evaluateAll: false },
    children: childIds.map((id) => ({ id, type: "Rule" })),
    statements: [],
    targets: [],
    condition,
  };
}

const P_SESSION = policy("Allow Session Methods", [R_SESSION_INVALID.id, R_SESSION.id]);
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
  if (o) { out.push(structuredClone(o)); if (o.objectType === "AttributeDefinition") producedAttrs.add(o.id); }
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
    } else if (k === "statements" && Array.isArray(v)) {
      // statements[] holds bare-UUID entity refs — e.g. the mortgage TV
      // policy's Statement — that must ship for the import to validate.
      for (const s of v) {
        if (typeof s === "string" && s.includes("-")) acc.add(s);
      }
    }
    collectRefs(v, acc);
  }
  return acc;
}

// --- the portfolio policy set + target -------------------------------------
const TARGET_ID = LIVE.target;
const targetTemplate = firstNamed("Inline target");
out.push({ ...targetTemplate, id: TARGET_ID, version: randomUUID(), targeted: { services: [SERVICE_ID] } });

const portfolioSet = mortgage.find((o) => o.type === "PolicySet" && o.name === "APIM Mortgage MCP");
const PORTFOLIO_SET_ID = LIVE.set;
out.push({
  ...structuredClone(portfolioSet),
  id: PORTFOLIO_SET_ID,
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

// NO Global Decision Point and NO Token Validation ship in the MERGE variant —
// both already live in the serving branch, and re-shipping them either fails
// the import (their children must resolve inside the package, dragging the
// entire mortgage subtree along) or fails the merge (a fresh-id TV claiming
// the shared inactive rule = two parents). Instead:
//   1. the merge snapshot brings in the portfolio content (all fresh ids);
//   2. test.md §1.2 step 3 (or the PAP admin API) attaches
//      `AgentGateway Portfolio MCP` as a second PolicySet child of the
//      serving branch's existing GDP — the same manual step the APIM
//      integration documents.
// The ref-sweep (below) closes the package over the objects above only.

// --- full-branch variant: baseline trust framework + TV + GDP ship INSIDE ---
// A FRESH PAP has no serving branch, so the package must carry the product's
// baseline trust framework, not just the policy tree: the stock 11.1 demo
// defines HttpRequest with 12 children (RequestURI, ResourcePath→leaf,
// RequestHeaders, QueryParameters, CorrelationId, IPAddress, ClientCertificate,
// Response*, AccessToken) plus Gateway{BasePath, TrailingPath}, and the
// AccessToken claim set (client_id, issuer, expiration, subject, username,
// token_owner, token_type, user_token, roles, authentication_*, Actor*). The
// ref-sweep below only copies REFERENCED objects — no portfolio policy points
// at RequestURI/leaf/Gateway, so without this block the sweep silently ships a
// 2-child HttpRequest and every fresh boot inherits a gutted baseline (the
// engine still populates the built-ins, but the editor can't author
// conditions against them). Emitted verbatim from the mortgage template —
// canonical product ids, byte-identical to a stock demo bootstrap export.
if (FULL_BRANCH) {
  for (const a of mortgage.filter((o) => o.objectType === "AttributeDefinition")) {
    if (producedAttrs.has(a.id)) continue;
    producedAttrs.add(a.id);
    out.push(structuredClone(a));
  }
  const tvPolicy = structuredClone(mortgage.find((o) => o.type === "Policy" && o.name === "Token Validation"));
  out.push(tvPolicy);
  out.push({
    ...structuredClone(mortgage.find((o) => o.type === "PolicySet" && o.name === "Global Decision Point")),
    id: GDP_ID,
    version: randomUUID(),
    children: [
      { id: tvPolicy.id, type: "Policy" },
      { id: PORTFOLIO_SET_ID, type: "PolicySet" },
    ],
  });
}

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

const target = FULL_BRANCH
  // no spaces in the name: the PAP import hook's `for f in $(find …)`
  // word-splits, so any space in the filename breaks the import
  ? path.join(here, "..", "..", "k8s", "server-profiles", "pingauthorizepap", "policies", "Portfolio-MCP-policies.full-branch.SNAPSHOT")
  : path.join(here, "Portfolio MCP policies.snapshot");
mkdirSync(path.dirname(target), { recursive: true });
writeFileSync(target, JSON.stringify(out));
console.log(`wrote ${target} (${out.length} objects, digest ${digestB64.slice(0, 12)}…)`);
