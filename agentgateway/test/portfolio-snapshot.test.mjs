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

test("service and policy sets are portfolio-shaped", () => {
  const d = load();
  const services = d.filter((o) => o.objectType === "ServiceDefinition").map((o) => o.name);
  assert.deepEqual(services, ["AgentGateway Portfolio MCP"]);
  const sets = d.filter((o) => o.type === "PolicySet").map((o) => o.name);
  assert.deepEqual(sets.sort(), ["AgentGateway Portfolio MCP", "Global Decision Point"]);
});

test("policy roster matches the six-policy pattern plus Token Validation", () => {
  const d = load();
  const names = d.filter((o) => o.type === "Policy").map((o) => o.name).sort();
  assert.deepEqual(names, [
    "Allow Delegated Token by VIP Users Only",
    "Allow Session Methods",
    "Allow low risk orders",
    "Allow read operations",
    "Default Deny",
    "High Risk Orders with HITL",
    "Token Validation",
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

test("package boilerplate present with a fresh snapshot id", () => {
  const d = load();
  assert.equal(d[0]["@class"], "DataStreamHeader");
  const header = d.find((o) => o.type === "SnapshotPackageFile$PackageHeader");
  assert.equal(header.snapshotFileVersion, 4);
  assert.notEqual(header.snapshotId, "90bf4c90-bd6c-4f14-84b6-8a923a202b34"); // not the mortgage id
  assert.ok(d.some((o) => o.type === "SnapshotPackageFile$EndOfPackage"));
});
