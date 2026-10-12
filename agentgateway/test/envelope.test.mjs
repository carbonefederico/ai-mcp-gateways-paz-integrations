import { test } from "node:test";
import assert from "node:assert/strict";
import { buildSidebandEnvelope } from "../src/paz-extauthz-adapter.mjs";

const checkRequest = {
  attributes: {
    source: { address: { socketAddress: { address: "127.0.0.1", portValue: 51422 } } },
    request: {
      http: {
        method: "POST",
        scheme: "http",
        host: "localhost:3001",
        path: "/portfolio",
        protocol: "HTTP/1.1",
        headers: {
          // Envoy merges duplicates per the HTTP spec and lowercases keys;
          // the adapter must pass them through as-is.
          accept: "application/json, text/event-stream",
          authorization: "Bearer eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJhbGljZSJ9.sig",
          "content-type": "application/json",
        },
        body: '{"jsonrpc":"2.0","method":"tools/list","id":1}',
      },
    },
  },
};

test("envelope matches the sideband schema the APIM fragment produces", () => {
  const env = buildSidebandEnvelope(checkRequest);
  assert.deepEqual(env, {
    source_ip: "127.0.0.1",
    source_port: "51422", // sideband models the port as text
    method: "POST",
    url: "http://localhost:3001/portfolio",
    http_version: "1.1", // bare version, not "HTTP/1.1"
    headers: [
      { accept: "application/json, text/event-stream" },
      { authorization: "Bearer eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJhbGljZSJ9.sig" },
      { "content-type": "application/json" },
    ],
    body: '{"jsonrpc":"2.0","method":"tools/list","id":1}',
  });
});

test("bodyless GET degrades to null body and nulls stay null", () => {
  const env = buildSidebandEnvelope({
    attributes: {
      request: {
        http: { method: "GET", scheme: "http", host: "localhost:3001", path: "/portfolio", protocol: "HTTP/1.1", headers: {} },
      },
    },
  });
  assert.equal(env.body, null);
  assert.equal(env.method, "GET");
});

test("raw_body bytes win over body string", () => {
  const env = buildSidebandEnvelope({
    attributes: {
      request: {
        http: { method: "POST", host: "h", path: "/", protocol: "HTTP/1.1", headers: {}, body: "ignored", rawBody: Buffer.from('{"a":1}') },
      },
    },
  });
  assert.equal(env.body, '{"a":1}');
});
