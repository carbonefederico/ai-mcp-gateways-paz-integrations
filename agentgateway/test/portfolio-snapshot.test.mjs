import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), "policy-snapshot");
const snapshotPath = path.join(dir, "Portfolio MCP policies.snapshot");
const fullBranchPath = path.join(dir, "..", "..", "k8s", "server-profiles", "pingauthorizepap", "policies", "Portfolio-MCP-policies.full-branch.SNAPSHOT");

function load() {
  return JSON.parse(readFileSync(snapshotPath, "utf8"));
}

test("generator runs and produces the snapshot", () => {
  execFileSync("node", [path.join(dir, "build-portfolio-snapshot.mjs")], { stdio: "inherit" });
  assert.ok(existsSync(snapshotPath));
});

test("no mortgage vocabulary survives", () => {
  const text = readFileSync(snapshotPath, "utf8").toLowerCase();
  assert.ok(!text.includes("mortgage"), "mortgage string found");
  assert.ok(!text.includes("changetype"), "changeType string found");
});

test("service and policy sets are portfolio-shaped (the GDP attaches post-merge)", () => {
  const d = load();
  const services = d.filter((o) => o.objectType === "ServiceDefinition").map((o) => o.name);
  assert.deepEqual(services, ["AgentGateway Portfolio MCP"]);
  const sets = d.filter((o) => o.type === "PolicySet").map((o) => o.name);
  assert.deepEqual(sets, ["AgentGateway Portfolio MCP"]);
});

test("high-risk policy precedes low-risk in the set (FirstApplicable tiering)", () => {
  const d = load();
  const set = d.find((o) => o.type === "PolicySet" && o.name === "AgentGateway Portfolio MCP");
  const byId = Object.fromEntries(d.filter((o) => o.id).map((o) => [o.id, o]));
  const names = set.children.map((c) => byId[c.id]?.name);
  // The low-risk rule matches EVERY submit_trade_order; if it ran before the
  // high-risk policy, high-risk orders would be permitted without approval.
  assert.ok(names.indexOf("High Risk Orders with HITL") < names.indexOf("Allow low risk orders"),
    `high must precede low, got: ${names.join(", ")}`);
});

test("policy roster matches the six-policy pattern (no TV, no GDP)", () => {
  const d = load();
  const names = d.filter((o) => o.type === "Policy").map((o) => o.name).sort();
  assert.deepEqual(names, [
    "Allow Delegated Token by VIP Users Only",
    "Allow Session Methods",
    "Allow low risk orders",
    "Allow read operations",
    "Default Deny",
    "High Risk Orders with HITL",
  ]);
});

test("MCP attributes point at portfolio JSONPaths; amount exists twice (NUMBER + STRING mirror)", () => {
  const d = load();
  const byName = Object.fromEntries(d.filter((o) => o.objectType === "AttributeDefinition").map((o) => [o.name, o]));
  const jp = (n) => byName[n]?.valueProcessor?.expression;
  assert.equal(jp("MCP Amount"), "$.params.arguments.amount");
  assert.equal(jp("MCP Customer Id"), "$.params.arguments.customerId");
  assert.equal(jp("MCP Symbol"), "$.params.arguments.symbol");
  assert.equal(jp("MCP Side"), "$.params.arguments.side");
  assert.equal(jp("MCP Quantity"), "$.params.arguments.quantity");
  assert.equal(byName["MCP Amount"].valueProcessor.valueType, "NUMBER");
  assert.equal(byName["MCP Amount"].defaultValue, "0", "NUMBER amount must default to 0: the _null sentinel breaks numeric resolution and aborts the high-risk condition to default-deny");
  assert.equal(byName["MCP Amount Mirror"].valueProcessor.valueType, "STRING");
  for (const n of ["MCP Amount", "MCP Customer Id", "MCP Symbol", "MCP Side", "MCP Quantity"]) {
    assert.ok(!byName[n].parentId, `${n} must resolve from the request body, not a parent`);
  }
});

test("risk threshold and mirror comparisons are wired to the right attributes", () => {
  const text = readFileSync(snapshotPath, "utf8");
  assert.ok(text.includes("10000"), "10,000 threshold missing");
  assert.ok(text.includes("GreaterThan"), "numeric GreaterThan op missing");
  const d = load();
  const claimPaths = d
    .filter((o) => o.objectType === "AttributeDefinition" && o.valueProcessor?.expression?.startsWith("$.tctx."))
    .map((o) => o.valueProcessor.expression);
  for (const p of ["$.tctx.tool", "$.tctx.customerId", "$.tctx.symbol", "$.tctx.side", "$.tctx.quantity", "$.tctx.amount"]) {
    assert.ok(claimPaths.includes(p), `missing claim attribute ${p}`);
  }
});

test("denial statements are machine-readable and parse", () => {
  const d = load();
  // auth-challenge statements carry the reason under `error` (RFC 6750);
  // denied-reason statements carry it under `message`. Both parse as JSON.
  const payloads = d.filter((o) => o.type === "Statement" && o.payload).map((o) => JSON.parse(o.payload));
  const reasons = payloads.map((p) => p.message ?? p.error);
  for (const reason of ["insufficient_scope", "approval_required", "delegation_not_permitted"]) {
    assert.ok(reasons.includes(reason), `missing denial reason ${reason}`);
  }
});

test("no object id appears twice in the package", () => {
  const d = load();
  const seen = new Map();
  const dupes = [];
  for (const o of d) {
    if (!o.id) continue;
    if (seen.has(o.id)) dupes.push(`${o.id} (${o.name ?? o.type ?? "?"})`);
    seen.set(o.id, o);
  }
  assert.deepEqual(dupes, []);
});

test("package boilerplate present with a fresh snapshot id", () => {
  const d = load();
  assert.equal(d[0]["@class"], "DataStreamHeader");
  const header = d.find((o) => o.type === "SnapshotPackageFile$PackageHeader");
  assert.equal(header.snapshotFileVersion, 4);
  assert.notEqual(header.snapshotId, "90bf4c90-bd6c-4f14-84b6-8a923a202b34"); // not the mortgage id
  assert.ok(d.some((o) => o.type === "SnapshotPackageFile$EndOfPackage"));
});

test("every child/reference id resolves to an object in the package", () => {
  const d = load();
  const ids = new Set(d.filter((o) => o.id).map((o) => o.id));
  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
  const isRef = (v) => typeof v === "string" && UUID.test(v);
  const bad = [];
  (function walk(node) {
    if (Array.isArray(node)) return node.forEach(walk);
    if (!node || typeof node !== "object") return;
    for (const [k, v] of Object.entries(node)) {
      if ((k === "children" || k === "statements" || k === "targets") && Array.isArray(v)) {
        for (const c of v) {
          const cid = typeof c === "string" ? c : c?.id;
          if (cid === undefined) continue;
          if (!isRef(cid)) bad.push(`${node.name ?? "?"}.${k}: malformed child ${JSON.stringify(c).slice(0, 40)}`);
          else if (!ids.has(cid)) bad.push(`${node.name ?? "?"}.${k}: dangling ${cid}`);
        }
      }
      if (k === "resolvers" && Array.isArray(v)) {
        for (const r of v) {
          if (r?.id !== undefined && !ids.has(r.id)) bad.push(`${node.name ?? "?"}.resolvers: dangling ${r.id}`);
        }
      }
      if (k === "parentId" && isRef(v) && !ids.has(v)) bad.push(`${node.name ?? "?"}.parentId: dangling ${v}`);
      walk(v);
    }
  })(d);
  assert.deepEqual(bad, []);
});

test("every comparison attribute id resolves and all seven rules exist", () => {
  const d = load();
  const ids = new Set(d.filter((o) => o.id).map((o) => o.id));
  const rules = d.filter((o) => o.type === "Rule").map((o) => o.name).sort();
  for (const n of [
    "Allow MCP session methods",
    "Deny non-VIP subject behind delegated agent",
    "Allow portfolio read tools with portfolio:read scope",
    "Allow low risk orders with portfolio:write scope",
    "High-risk orders require portfolio:write scope",
    "Risky orders require approval bound to the transaction",
    "Default Deny",
  ]) {
    assert.ok(rules.includes(n), `missing rule ${n}`);
  }
  // TV ships NO duplicate: the serving branch's Token Validation (and its
  // shared inactive rule) already exist there; re-shipping either fails the
  // merge's ValidPolicyReferences constraint. The GDP linkage is done after
  // the merge (test.md §1.2 step 3), so no TV and no GDP appear here.
  assert.ok(!rules.includes("Access token is inactive"), "shared TV rule must not ship");
  assert.ok(!d.some((o) => o.type === "Policy" && o.name === "Token Validation"), "duplicate TV policy must not ship");
  assert.ok(!d.some((o) => o.type === "PolicySet" && o.name === "Global Decision Point"), "GDP must not ship (attached post-merge)");
  assert.ok(!d.some((o) => o.type === "PolicySet" && o.name === "APIM Mortgage MCP"), "mortgage set must not ship");
  // mirror comparisons: every attribute id on either side of any comparison must exist
  const byName = Object.fromEntries(d.filter((o) => o.objectType === "AttributeDefinition").map((o) => [o.name, o]));
  const cmpIds = [];
  (function find(node) {
    if (Array.isArray(node)) return node.forEach(find);
    if (!node || typeof node !== "object") return;
    if (node.comparison) {
      for (const side of ["left", "right"]) {
        const id = node.comparison[side]?.attribute?.id;
        if (id) cmpIds.push(id);
      }
    }
    Object.values(node).forEach(find);
  })(d);
  for (const id of cmpIds) assert.ok(ids.has(id), `comparison references missing attribute ${id}`);
  // the mirror pair must reference the STRING mirror attribute (right side, matching the template)
  const amountS = byName["MCP Amount Mirror"];
  assert.ok(cmpIds.includes(amountS.id), "mirror rule never compares against MCP Amount Mirror (STRING)");
});

test("high-risk tiering sits in the policy condition; read rule keeps scope only in effectSettings", () => {
  const d = load();
  const byName = Object.fromEntries(d.filter((o) => o.name).map((o) => [o.name, o]));
  const high = byName["High Risk Orders with HITL"];
  const text = JSON.stringify(high.effectSettings?.condition ?? high.condition ?? {});
  assert.ok(text.includes("GreaterThan"), "high-risk policy condition lacks GreaterThan");
  assert.ok(text.includes("10000"), "high-risk policy condition lacks the 10000 threshold");
  // the GreaterThan comparison must use the NUMBER attribute (MCP Amount), not the STRING mirror
  const byId = Object.fromEntries(d.filter((o) => o.id).map((o) => [o.id, o]));
  const comparisons = [];
  (function find(node) {
    if (Array.isArray(node)) return node.forEach(find);
    if (node && typeof node === "object" && node.comparison) comparisons.push(node.comparison);
    if (node && typeof node === "object") Object.values(node).forEach(find);
  })([high.effectSettings?.condition, high.condition]);
  const gt = comparisons.filter((c) => c.op === "GreaterThan");
  assert.equal(gt.length, 1, "exactly one GreaterThan comparison expected");
  const gtAttr = byId[gt[0].left?.attribute?.id];
  assert.equal(gtAttr?.valueProcessor?.valueType, "NUMBER", "GreaterThan must run on the NUMBER attribute");
  assert.equal(gt[0].right?.constant?.value, 10000, "threshold must be 10000");
  // absent amount ⇒ "_null" sentinel; a numeric GreaterThan against it aborts
  // evaluation to default-deny. The NotEquals-_null guard must sit in the same
  // and{} so the numeric compare only runs when a real amount was sent.
  const neqNull = comparisons.filter((c) => c.op === "NotEquals" && c.right?.constant?.value === "_null" && c.left?.attribute?.id === gtAttr.id);
  assert.equal(neqNull.length, 1, "high-risk condition needs a NotEquals-_null guard on the amount attribute before GreaterThan");
  // read rule: main condition has tool selection only; scope lives in effectSettings
  const read = byName["Allow portfolio read tools with portfolio:read scope"];
  assert.ok(!JSON.stringify(read.condition).includes("portfolio:read"), "scope must NOT be in the read rule's main condition");
  assert.ok(JSON.stringify(read.effectSettings.condition).includes("portfolio:read"), "scope must be in the read rule's effectSettings");
});

// --- full-branch mode (k8s bootstrap): the generator writes a SECOND artifact
// with TV + GDP included, so a fresh PAP can auto-import a complete branch.

test("full-branch: generator runs and produces the full-branch snapshot", () => {
  execFileSync("node", [path.join(dir, "build-portfolio-snapshot.mjs"), "--full-branch"], { stdio: "inherit" });
  assert.ok(existsSync(fullBranchPath));
});

test("full-branch: GDP with fixed id and TV(Policy)+portfolio(PolicySet) children", () => {
  const snap = JSON.parse(readFileSync(fullBranchPath, "utf8"));
  const gdp = snap.find((o) => o.name === "Global Decision Point" && o.type === "PolicySet");
  assert.ok(gdp, "GDP missing");
  assert.equal(gdp.id, "a7c4e2d0-8f11-4b5a-9c3d-6e8f2a1b4c7d", "GDP id must be the fixed bootstrap literal");
  // Ground truth from the live branch's export: TV is a POLICY (id kept from
  // the template), the portfolio set is a PolicySet.
  assert.deepEqual(gdp.children.map((c) => c.type), ["Policy", "PolicySet"]);
  const tv = snap.find((o) => o.id === gdp.children[0].id);
  assert.ok(tv?.name === "Token Validation" && tv?.type === "Policy", "TV child missing or wrong type");
  assert.ok(snap.some((o) => o.id === gdp.children[1].id && o.name === "AgentGateway Portfolio MCP"), "portfolio set child missing");
});

test("full-branch: preserves the three live-verified invariants", () => {
  const snap = JSON.parse(readFileSync(fullBranchPath, "utf8"));
  const amount = snap.find((o) => o.name === "MCP Amount");
  assert.equal(amount?.defaultValue, "0", "absent amount must resolve to 0 (low-risk fall-through)");
  const set = snap.find((o) => o.type === "PolicySet" && o.name === "AgentGateway Portfolio MCP");
  const byId = Object.fromEntries(snap.filter((o) => o.id).map((o) => [o.id, o]));
  const names = set.children.map((c) => byId[c.id]?.name);
  const highIdx = names.indexOf("High Risk Orders with HITL");
  const lowIdx = names.indexOf("Allow low risk orders");
  assert.ok(highIdx !== -1 && lowIdx !== -1 && highIdx < lowIdx, "high-risk must precede low-risk");
  const high = snap.find((o) => o.type === "Policy" && o.name === "High Risk Orders with HITL");
  assert.equal(high?.condition?.and?.conditions?.length, 3, "NotEquals-_null guard must be present");
});

test("full-branch: footer present and package closes cleanly", () => {
  const snap = JSON.parse(readFileSync(fullBranchPath, "utf8"));
  assert.equal(snap[0]["@class"], "DataStreamHeader");
  assert.ok(snap.some((o) => o["@class"] === "DataStreamFooter"), "digest footer missing");
  assert.ok(snap.some((o) => o.type === "SnapshotPackageFile$EndOfPackage"));
});

test("full-branch: every child/reference id resolves (fresh-PAP self-containment)", () => {
  const snap = JSON.parse(readFileSync(fullBranchPath, "utf8"));
  const ids = new Set(snap.filter((o) => o.id).map((o) => o.id));
  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
  const bad = [];
  (function walk(node) {
    if (Array.isArray(node)) return node.forEach(walk);
    if (!node || typeof node !== "object") return;
    // children AND statements: TV ships with a bare-UUID statements[] entry
    if ((node.type === "Policy" || node.type === "PolicySet") && Array.isArray(node.children)) {
      for (const c of node.children) {
        if (!ids.has(c.id)) bad.push(`${node.name}.${node.type}: dangling child ${c.id}`);
      }
    }
    for (const [k, v] of Object.entries(node)) {
      if (k === "statements" && Array.isArray(v)) {
        for (const s of v) {
          if (typeof s === "string" && UUID.test(s) && !ids.has(s)) bad.push(`${node.name}: dangling statement ${s}`);
        }
      }
      walk(v);
    }
  })(snap);
  assert.deepEqual(bad, []);
});

test("default mode: merge variant unchanged (no GDP, no TV policy set)", () => {
  execFileSync("node", [path.join(dir, "build-portfolio-snapshot.mjs")], { stdio: "inherit" });
  const snap = JSON.parse(readFileSync(snapshotPath, "utf8"));
  assert.ok(!snap.some((o) => o.name === "Global Decision Point" && o.type === "PolicySet"), "merge variant must not ship a GDP");
  assert.ok(!snap.some((o) => o.type === "PolicySet" && o.name === "Token Validation"), "merge variant must not ship a TV set");
});

test("session-methods permit requires an active token (T9: expired token cannot ride through)", () => {
  const d = load();
  const byName = Object.fromEntries(d.filter((o) => o.name).map((o) => [o.name, o]));
  const session = byName["Allow MCP session methods"];
  const active = byName["active"];
  assert.ok(session && active, "session rule and active attribute must exist");
  // The method OR must sit inside an AND whose other operand is active == true.
  const text = JSON.stringify(session.condition);
  const activeId = `"attribute":{"id":"${active.id}"}`;
  assert.ok(text.includes(activeId), "session permit does not reference the active attribute");
  assert.ok(text.includes('"op":"Equals"') && text.includes('"value":"true"'), "session permit does not require active == true");
  // And the method OR must remain: all four session methods still matched.
  for (const m of ["initialize", "tools/list", "ping", "notifications/initialized"]) {
    assert.ok(text.includes(`"value":"${m}"`), `session permit lost method ${m}`);
  }
});

test("expired/indeterminate token on session methods denies 401 (invalid_token), not 403", () => {
  const d = load();
  const byName = Object.fromEntries(d.filter((o) => o.name).map((o) => [o.name, o]));
  const deny = byName["Session methods with invalid token"];
  assert.ok(deny, "missing deny rule for session methods with invalid token");
  const text = JSON.stringify(deny);
  assert.ok(text.includes('"unconditionalDeny"'), "deny rule must deny unconditionally");
  // carries the shared Invalid Token statement (401 invalid_token)
  const invalid = byName["Invalid Token"];
  assert.ok(invalid, "Invalid Token statement must exist");
  assert.ok(JSON.stringify(deny.statements ?? []).includes(invalid.id), "deny rule does not carry Invalid Token statement");
  // gated on active != true (covers false AND indeterminate)
  const active = byName["active"];
  assert.ok(text.includes(`"attribute":{"id":"${active.id}"}`), "deny rule does not reference active");
  assert.ok(text.includes('"op":"NotEquals"') || text.includes('"op":"NotEqualTo"'), "deny rule does not test active != true");
});
