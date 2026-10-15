import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import grpc from "@grpc/grpc-js";
import protoLoader from "@grpc/proto-loader";
import { createCheckHandler } from "../../src/paz-extauthz-adapter.mjs";

const protoDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "../..", "src", "proto");
const def = await protoLoader.load(path.join(protoDir, "ext_authz.proto"), { includeDirs: [protoDir], keepCase: false });
const pkg = grpc.loadPackageDefinition(def);

async function startServer(config, fetchImpl) {
  const server = new grpc.Server();
  server.addService(pkg.envoy.service.auth.v3.Authorization.service, {
    Check: createCheckHandler(config, fetchImpl),
  });
  const port = await new Promise((resolve, reject) => {
    server.bindAsync("127.0.0.1:0", grpc.ServerCredentials.createInsecure(), (err, bound) =>
      err ? reject(err) : resolve(bound),
    );
  });
  return { server, clientUrl: `127.0.0.1:${port}`, stop: () => server.tryShutdown(() => {}) };
}

function check(client, attributes) {
  return new Promise((resolve, reject) => {
    client.Check({ attributes }, (err, response) => (err ? reject(err) : resolve(response)));
  });
}

const httpReq = (over = {}) => ({
  method: "POST",
  scheme: "http",
  host: "localhost:3001",
  path: "/portfolio",
  protocol: "HTTP/1.1",
  headers: { authorization: "Bearer t" },
  body: '{"jsonrpc":"2.0","method":"tools/call","id":9}',
  ...over,
});

test("permit round-trips over real gRPC", async () => {
  const { clientUrl, stop } = await startServer(
    { serviceUrl: "https://paz.test", secretHeaderValue: "s", timeoutMs: 300, debugLogging: false },
    async () => ({ ok: true, status: 200, text: async () => "{}" }),
  );
  const client = new pkg.envoy.service.auth.v3.Authorization(clientUrl, grpc.credentials.createInsecure());
  const res = await check(client, { request: { http: httpReq() } });
  assert.equal(res.status.code, 0);
  client.close();
  stop();
});

test("deny relays WWW-Authenticate over real gRPC", async () => {
  const deny = {
    response: {
      response_code: 403,
      headers: [{ "www-authenticate": 'Bearer error="insufficient_scope", scope="portfolio:write"' }],
      body: '{"jsonrpc":"2.0","id":9,"error":{"code":-32003,"message":"Access denied"}}',
    },
  };
  const { clientUrl, stop } = await startServer(
    { serviceUrl: "https://paz.test", secretHeaderValue: "s", timeoutMs: 300, debugLogging: false },
    async () => ({ ok: true, status: 200, text: async () => JSON.stringify(deny) }),
  );
  const client = new pkg.envoy.service.auth.v3.Authorization(clientUrl, grpc.credentials.createInsecure());
  const res = await check(client, { request: { http: httpReq() } });
  assert.equal(res.status.code, 7);
  assert.equal(res.deniedResponse.status.code, 403);
  assert.equal(res.deniedResponse.headers[0].header.key, "www-authenticate");
  client.close();
  stop();
});

test("PAZ unreachable still answers (denied 502), never an adapter crash", async () => {
  const { clientUrl, stop } = await startServer(
    { serviceUrl: "http://127.0.0.1:9", secretHeaderValue: "s", timeoutMs: 200, debugLogging: false },
    globalThis.fetch,
  );
  const client = new pkg.envoy.service.auth.v3.Authorization(clientUrl, grpc.credentials.createInsecure());
  const res = await check(client, { request: { http: httpReq() } });
  assert.equal(res.status.code, 7);
  assert.equal(res.deniedResponse.status.code, 502);
  client.close();
  stop();
});

test("bodyless GET produces a decision, not an error (Review Focus 1)", async () => {
  const { clientUrl, stop } = await startServer(
    { serviceUrl: "https://paz.test", secretHeaderValue: "s", timeoutMs: 300, debugLogging: false },
    async () => ({ ok: true, status: 200, text: async () => "{}" }),
  );
  const client = new pkg.envoy.service.auth.v3.Authorization(clientUrl, grpc.credentials.createInsecure());
  const res = await check(client, {
    request: { http: { method: "GET", scheme: "http", host: "localhost:3001", path: "/portfolio", protocol: "HTTP/1.1", headers: {} } },
  });
  assert.ok([0, 7].includes(res.status.code)); // a decision arrived; envelope built without throwing
  client.close();
  stop();
});
