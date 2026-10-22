import { test } from "node:test";
import assert from "node:assert/strict";
import { callSideband, loadConfig } from "../../src/paz-extauthz-adapter.mjs";

const config = { serviceUrl: "https://paz.test", secretHeaderValue: "sec", timeoutMs: 200, debugLogging: false };
const envelope = { source_ip: null, source_port: null, method: "POST", url: "http://h/", http_version: "1.1", headers: [], body: "{}" };

function okFetch(body, status = 200) {
  return async () => ({ ok: status >= 200 && status < 300, status, text: async () => JSON.stringify(body) });
}
const failFetch = async () => {
  throw new Error("ECONNREFUSED");
};

test("PERMIT: sideband 200 without a response object", async () => {
  const r = await callSideband(config, envelope, okFetch({ state: "s1" }));
  assert.equal(r.kind, "permit");
  assert.equal(r.body.state, "s1");
});

test("DENY: sideband 200 with an embedded response object", async () => {
  const deny = { response: { response_code: 403, headers: [{ "www-authenticate": 'Bearer error="insufficient_scope"' }], body: '{"e":1}' } };
  const r = await callSideband(config, envelope, okFetch(deny));
  assert.equal(r.kind, "deny");
  assert.equal(r.body.response_code, 403);
});

test("fail closed after two attempts on transport failure", async () => {
  let calls = 0;
  const counting = async () => {
    calls += 1;
    throw new Error("down");
  };
  const r = await callSideband(config, envelope, counting);
  assert.equal(r.kind, "error");
  assert.equal(r.status, 502);
  assert.equal(calls, 2);
});

test("a fast first failure is retried immediately and recovers", async () => {
  let calls = 0;
  const flaky = async () => {
    calls += 1;
    if (calls === 1) throw new Error("ECONNRESET"); // stale pooled socket
    return okFetch({ state: "s1" })();
  };
  const r = await callSideband(config, envelope, flaky);
  assert.equal(calls, 2);
  assert.equal(r.kind, "permit");
  assert.equal(r.body.state, "s1");
});

test("sideband non-200 is an integration error, not a denial", async () => {
  const r = await callSideband(config, envelope, okFetch({ oops: true }, 503));
  assert.equal(r.kind, "error");
  assert.equal(r.status, 502);
});

test("200 with malformed JSON fails closed", async () => {
  const rawFetch = async () => ({ ok: true, status: 200, text: async () => "not-json{{" });
  const r = await callSideband(config, envelope, rawFetch);
  assert.equal(r.kind, "error");
  assert.equal(r.status, 502);
  assert.match(r.message, /Malformed sideband response/);
});

test("200 with an empty body fails closed", async () => {
  const rawFetch = async () => ({ ok: true, status: 200, text: async () => "" });
  const r = await callSideband(config, envelope, rawFetch);
  assert.equal(r.kind, "error");
  assert.equal(r.status, 502);
  assert.match(r.message, /Malformed sideband response/);
});

test("request carries PDG-TOKEN and the JSON envelope", async () => {
  let seen;
  await callSideband(config, envelope, async (url, init) => {
    seen = { url, init };
    return okFetch({})(url, init);
  });
  assert.equal(seen.url, "https://paz.test/sideband/request");
  assert.equal(seen.init.headers["PDG-TOKEN"], "sec");
  assert.equal(JSON.parse(seen.init.body).url, "http://h/");
});

test("loadConfig requires SERVICE_URL and SECRET_HEADER_VALUE", () => {
  assert.throws(() => loadConfig({ SECRET_HEADER_VALUE: "s" }), /SERVICE_URL/);
  assert.throws(() => loadConfig({ SERVICE_URL: "https://x" }), /SECRET_HEADER_VALUE/);
  const c = loadConfig({ SERVICE_URL: "https://x/", SECRET_HEADER_VALUE: "s" });
  assert.equal(c.serviceUrl, "https://x"); // trailing slash stripped
  assert.equal(c.timeoutMs, 2000);
});

test("TLS trust failure (DEPTH_ZERO_SELF_SIGNED_CERT) marks the result unrecoverable — pod must exit so K8s re-extracts", async () => {
  const tlsFail = async () => {
    const e = new Error("unable to verify the first certificate");
    e.cause = { code: "DEPTH_ZERO_SELF_SIGNED_CERT" };
    throw e;
  };
  const r = await callSideband(config, envelope, tlsFail);
  assert.equal(r.kind, "error");
  assert.equal(r.status, 502);
  assert.ok(r.podRestartRequired === true, "result must flag podRestartRequired so main() can exit");
});
