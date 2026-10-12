import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import path from "node:path";
import protoLoader from "@grpc/proto-loader";

const protoDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src", "proto");

test("vendored ext_authz.proto loads and exposes the Envoy Authorization service", async () => {
  const def = await protoLoader.load(path.join(protoDir, "ext_authz.proto"), {
    includeDirs: [protoDir],
    keepCase: false,
  });
  const pkg = (await import("@grpc/grpc-js")).loadPackageDefinition(def);
  const auth = pkg.envoy?.service?.auth?.v3?.Authorization;
  assert.ok(auth, "envoy.service.auth.v3.Authorization not found");
  // grpc-js exposes the service definition at .service; Check is its handler
  // descriptor object (path, requestSerialize, ...), not a bare function.
  assert.ok(auth.service?.Check, "Check handler descriptor missing");
});
