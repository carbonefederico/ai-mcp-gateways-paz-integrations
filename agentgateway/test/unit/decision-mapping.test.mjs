import { test } from "node:test";
import assert from "node:assert/strict";
import { toCheckResponse } from "../../src/paz-extauthz-adapter.mjs";

const RPC_BODY = '{"jsonrpc":"2.0","method":"tools/call","id":42,"params":{}}';

test("permit maps to gRPC OK with no http_response", () => {
  const cr = toCheckResponse({ kind: "permit", body: {} }, RPC_BODY);
  assert.equal(cr.status.code, 0);
  assert.equal(cr.deniedResponse, undefined);
});

test("deny relays PAZ status, headers and body verbatim", () => {
  const cr = toCheckResponse(
    {
      kind: "deny",
      body: {
        response_code: 403,
        headers: [{ "www-authenticate": 'Bearer error="insufficient_scope", scope="portfolio:write"' }],
        body: '{"jsonrpc":"2.0","id":42,"error":{"code":-32003,"message":"Access denied"}}',
      },
    },
    RPC_BODY,
  );
  assert.equal(cr.status.code, 7); // PERMISSION_DENIED
  assert.equal(cr.deniedResponse.status.code, 403);
  assert.deepEqual(cr.deniedResponse.headers, [
    { header: { key: "www-authenticate", value: 'Bearer error="insufficient_scope", scope="portfolio:write"' } },
  ]);
  assert.equal(cr.deniedResponse.body, '{"jsonrpc":"2.0","id":42,"error":{"code":-32003,"message":"Access denied"}}');
});

test("deny without a body falls back to the JSON-RPC error envelope (-32003)", () => {
  const cr = toCheckResponse({ kind: "deny", body: { response_code: 403 } }, RPC_BODY);
  assert.equal(cr.deniedResponse.status.code, 403);
  const parsed = JSON.parse(cr.deniedResponse.body);
  assert.equal(parsed.id, 42);
  assert.equal(parsed.error.code, -32003);
});

test("deny 401 falls back to -32001 with WWW-Authenticate passthrough", () => {
  const cr = toCheckResponse(
    { kind: "deny", body: { response_code: 401, headers: [{ "www-authenticate": 'Bearer error="invalid_token"' }] } },
    RPC_BODY,
  );
  assert.equal(cr.deniedResponse.status.code, 401);
  assert.equal(JSON.parse(cr.deniedResponse.body).error.code, -32001);
  assert.equal(cr.deniedResponse.headers[0].header.key, "www-authenticate");
});

test("bodyless request (id-less) still gets a valid fallback envelope", () => {
  const cr = toCheckResponse({ kind: "deny", body: { response_code: 403 } }, "");
  assert.equal(JSON.parse(cr.deniedResponse.body).id, null);
});

test("sideband error maps to denied 502, fail closed", () => {
  const cr = toCheckResponse({ kind: "error", status: 502, message: "Sideband unavailable: down" }, RPC_BODY);
  assert.equal(cr.status.code, 7);
  assert.equal(cr.deniedResponse.status.code, 502);
  assert.equal(JSON.parse(cr.deniedResponse.body).error.code, -32603);
});
