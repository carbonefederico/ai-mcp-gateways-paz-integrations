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

// --- package boilerplate (shapes copied from the mortgage package) ---------
out.push({ "@class": "DataStreamHeader", kind: "SnapshotHeader", version: 4 });
const pkgHeader = firstTyped("SnapshotPackageFile$PackageHeader");
out.push({ ...pkgHeader, snapshotId: randomUUID() });
for (const o of mortgage.filter((x) => x.type === "SnapshotPackageFile$PackageSeparator")) out.push({ ...o });

// --- service ---------------------------------------------------------------
const SERVICE_ID = randomUUID();
const svc = firstNamed("APIM Mortgage MCP", "ServiceDefinition");
out.push({ ...svc, id: SERVICE_ID, version: randomUUID(), name: "AgentGateway Portfolio MCP", fullName: "AgentGateway Portfolio MCP" });

// --- request-body attributes (all resolve from RequestBody) ----------------
const REQUEST_BODY_ID = mId("RequestBody");
function mcpAttr(name, expression, valueType) {
  const tmpl = M("MCP Tool Name");
  return {
    ...tmpl,
    id: randomUUID(),
    version: randomUUID(),
    name,
    fullName: name,
    valueType,
    defaultValue: "_null",
    resolvers: [{ ...tmpl.resolvers[0], id: REQUEST_BODY_ID }],
    valueProcessor: { ...tmpl.valueProcessor, expression, valueType, name },
  };
}

const A = {
  method: mcpAttr("MCP Method", "$.method", "STRING"),
  tool: mcpAttr("MCP Tool Name", "$.params.name", "STRING"),
  txn: mcpAttr("MCP Transaction Id", "$.params.arguments.txn", "STRING"),
  amount: mcpAttr("MCP Amount", "$.params.arguments.amount", "NUMBER"),
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
  return { ...tmpl, id: randomUUID(), version: randomUUID(), name, fullName: name, valueProcessor: { ...tmpl.valueProcessor, expression, valueType, name: "" } };
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
  const tmpl = M("Default Deny"); // shape template for a Rule
  return {
    ...tmpl,
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

// Policy 3 — Read tools: permit if portfolio:read in scope, else challenge
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
        cmp(SHARED.scope, "Contains", { constant: { value: "portfolio:read" } }),
      ],
    },
  },
  effectSettings: {
    type: "conditionalPermitElseDeny",
    condition: { and: { conditions: [cmp(SHARED.scope, "Contains", { constant: { value: "portfolio:read" } })] } },
  },
  statementIds: [S.readChallenge.id],
});

// Policy 4 — Low-risk orders: any submit_trade_order that is NOT high-risk
// (no amount condition — FirstApplicable ordering handles the tiering, and
// absent amount ⇒ low risk). Permit if portfolio:write in scope, else challenge.
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

// Token Validation — copy the template policy/rules but keep shared ids
const TV_INACTIVE_RULE_SRC = M("Access token is inactive");
const TV_INACTIVE_RULE = {
  ...TV_INACTIVE_RULE_SRC,
  id: mId("Access token is inactive"),
  version: randomUUID(),
  name: "Access token is inactive",
};
const R_AUDIENCE = rule("Validate Audience", {
  effectSettings: {
    type: "conditionalPermitElseDeny",
    condition: { and: { conditions: [cmp(SHARED.audience, "Equals", { attribute: { id: mId("MCP Audience") } })] } },
  },
});

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

// High Risk Orders with HITL: policy-level condition selects tool + amount>10000
const P_HIGH = policy("High Risk Orders with HITL", [R_HIGH_SCOPE.id, R_HIGH_MIRROR.id], {
  and: {
    conditions: [
      cmp(A.tool.id, "Equals", { constant: { value: "submit_trade_order" } }),
      cmp(A.amount.id, "GreaterThan", { constant: { value: 10000 } }),
    ],
  },
});

const P_DEFAULT = policy("Default Deny", [R_DEFAULT.id]);
const P_TOKEN_VALIDATION = policy("Token Validation", [TV_INACTIVE_RULE.id, R_AUDIENCE.id]);
for (const p of [P_TOKEN_VALIDATION, P_SESSION, P_DELEGATION, P_READ, P_LOW, P_HIGH, P_DEFAULT]) out.push(p);

// --- Token Validation's token-claim attributes (shared machinery) ----------
// The inactive rule references condition definitions and attributes by the
// mortgage ids; those objects must exist in the snapshot. Copy them verbatim
// (same ids) from the template.
const SHARED_OBJECT_NAMES = ["active", "scope", "audience", "act_sub", "sub_type", "AccessToken", "RequestBody", "MCP Audience", "Invalid Token", "Unauthorized Audience"];
for (const name of SHARED_OBJECT_NAMES) {
  const o = byName.get(name);
  if (o) out.push(structuredClone(o));
}
// Condition definitions referenced by the inactive rule (any object type the
// rule references that we haven't produced yet): copy by id sweep.
const produced = new Set(out.map((o) => o.id));
for (const ref of collectRefs(TV_INACTIVE_RULE)) {
  if (!produced.has(ref)) {
    const o = mortgage.find((x) => x.id === ref);
    if (o) out.push(structuredClone(o));
  }
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
  children: [P_TOKEN_VALIDATION.id, P_SESSION.id, P_DELEGATION.id, P_READ.id, P_LOW.id, P_HIGH.id, P_DEFAULT.id].map((id) => ({ id, type: "Policy" })),
  targets: [TARGET_ID],
});

// Global Decision Point — same NAME, NEW id (merge-safe; see header comment)
const gdp = mortgage.find((o) => o.type === "PolicySet" && o.name === "Global Decision Point");
out.push({
  ...structuredClone(gdp),
  id: randomUUID(),
  version: randomUUID(),
  name: "Global Decision Point",
  children: [P_TOKEN_VALIDATION.id, { id: portfolioSetChildPlaceholder(), type: "PolicySet" }],
});

function portfolioSetChildPlaceholder() {
  // The GDP references the portfolio set by id; emit after the set exists.
  return out.find((o) => o.type === "PolicySet" && o.name === "AgentGateway Portfolio MCP").id;
}

// --- end boilerplate --------------------------------------------------------
for (const o of mortgage.filter((x) => x.type === "SnapshotPackageFile$EndOfPackage")) out.push({ ...o });

const target = path.join(here, "Portfolio MCP policies.snapshot");
writeFileSync(target, JSON.stringify(out));
console.log(`wrote ${target} (${out.length} objects)`);
