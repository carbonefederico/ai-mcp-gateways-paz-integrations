import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), "policy-snapshot");
const snapshotPath = path.join(dir, "Portfolio MCP policies.snapshot");

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
  // read rule: main condition has tool selection only; scope lives in effectSettings
  const read = byName["Allow portfolio read tools with portfolio:read scope"];
  assert.ok(!JSON.stringify(read.condition).includes("portfolio:read"), "scope must NOT be in the read rule's main condition");
  assert.ok(JSON.stringify(read.effectSettings.condition).includes("portfolio:read"), "scope must be in the read rule's effectSettings");
});
