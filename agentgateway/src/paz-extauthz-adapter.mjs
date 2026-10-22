// paz-extauthz-adapter.mjs — Envoy ext_authz (gRPC) ⇄ Ping Authorize sideband bridge.
//
// agentgateway's extAuthz policy calls Authorization/Check here per MCP call.
// We rebuild the sideband envelope exactly the way the Azure APIM fragment
// does (headers as array-of-single-key objects, body as a string), POST it to
// the PAZ sideband API, and translate the decision back into Envoy terms:
//   permit            -> CheckResponse status OK
//   deny              -> DeniedHttpResponse with PAZ's status/headers/body
//   sideband failure  -> DeniedHttpResponse 502 (fail closed)
// Configuration mirrors the aws-agentcore-mcp-gateway Lambda (env vars below).

export function buildSidebandEnvelope(checkRequest) {
  const attrs = checkRequest?.attributes ?? {};
  const http = attrs.request?.http ?? {};
  const socket = attrs.source?.address?.socketAddress ?? {};

  const headers = [];
  for (const [name, value] of Object.entries(http.headers ?? {})) {
    headers.push({ [name]: String(value) });
  }

  const rawBody = http.rawBody != null ? Buffer.from(http.rawBody).toString("utf8") : undefined;
  const body = rawBody ?? (http.body != null && http.body !== "" ? http.body : null);
  const scheme = http.scheme ?? "http";
  const host = http.host ?? "localhost";
  const path = http.path ?? "/";

  return {
    source_ip: socket.address ?? null,
    source_port: socket.portValue != null ? String(socket.portValue) : null,
    method: http.method ?? "POST",
    url: `${scheme}://${host}${path}`,
    // Ping's sideband schema expects the bare protocol version, not "HTTP/1.1".
    http_version: (http.protocol ?? "HTTP/1.1").replace(/^HTTP\//, ""),
    headers,
    body,
  };
}

export function loadConfig(env = process.env) {
  const serviceUrl = env.SERVICE_URL?.replace(/\/+$/, "");
  const secretHeaderValue = env.SECRET_HEADER_VALUE;
  if (!serviceUrl) throw new Error("SERVICE_URL environment variable is required");
  if (!secretHeaderValue) throw new Error("SECRET_HEADER_VALUE environment variable is required");
  const parsed = Number.parseInt(env.SIDEBAND_TIMEOUT_MS ?? "", 10);
  return {
    serviceUrl,
    secretHeaderValue,
    timeoutMs: Number.isSafeInteger(parsed) && parsed > 0 ? parsed : 5000,
    debugLogging: /^(1|true|yes|on)$/i.test(env.DEBUG_LOGGING ?? ""),
    listenPort: Number.parseInt(env.LISTEN_PORT ?? "", 10) || 8082,
  };
}

async function fetchJsonWithTimeout(config, path, payload, fetchImpl) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.timeoutMs);
  try {
    const response = await fetchImpl(`${config.serviceUrl}${path}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json",
        "PDG-TOKEN": config.secretHeaderValue,
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    const rawBody = await response.text();
    let body;
    try {
      body = rawBody ? JSON.parse(rawBody) : null;
    } catch {
      body = null;
    }
    return { response, body };
  } finally {
    clearTimeout(timer);
  }
}

const retryDelaysMs = [0, 1000]; // one immediate retry, then one after 1s — the probe is idempotent

// TLS trust failure against the sideband endpoint means the extracted PAZ cert
// is stale (PAZ regenerates its self-signed cert on every bootstrap). The
// emptyDir only refreshes when the ADAPTER pod restarts, so the pod must exit
// and let K8s restart it — the init container then re-extracts the live cert.
function isTlsTrustFailure(error) {
  const code = error?.cause?.code ?? error?.code;
  return typeof code === "string" && (code.endsWith("_SELF_SIGNED_CERT") || code === "UNABLE_TO_VERIFY_LEAF_SIGNATURE" || code === "CERT_HAS_EXPIRED");
}

export async function callSideband(config, envelope, fetchImpl = globalThis.fetch) {
  const started = performance.now();
  let lastError = null;
  let tlsTrustFailure = false;

  for (let attempt = 0; attempt < retryDelaysMs.length + 1; attempt += 1) {
    if (attempt > 0) await new Promise((resolve) => setTimeout(resolve, retryDelaysMs[attempt - 1]));
    try {
      const { response, body } = await fetchJsonWithTimeout(config, "/sideband/request", envelope, fetchImpl);
      const elapsedMs = Math.round(performance.now() - started);
      if (response.status === 200) {
        // A 200 the PEP cannot parse is not an answer: empty or malformed
        // bodies fail closed (502 sideband-error) rather than reading as
        // permit — same posture as Ping's Kong adapter. A real permit is the
        // echoed request envelope; a deny embeds a `response` object.
        if (body === null) {
          return { kind: "error", status: 502, message: "Malformed sideband response", elapsedMs };
        }
        return body?.response
          ? { kind: "deny", body: body.response, elapsedMs }
          : { kind: "permit", body, elapsedMs };
      }
      return { kind: "error", status: 502, message: `Sideband error (HTTP ${response.status})`, elapsedMs };
    } catch (error) {
      lastError = error;
      if (isTlsTrustFailure(error)) tlsTrustFailure = true;
    }
  }

  const detail = lastError?.name === "AbortError" ? "request timed out" : lastError?.message;
  return {
    kind: "error",
    status: 502,
    message: `Sideband unavailable${detail ? `: ${detail}` : ""}`,
    elapsedMs: Math.round(performance.now() - started),
    podRestartRequired: tlsTrustFailure,
  };
}

function rpcId(originalBodyText) {
  if (!originalBodyText) return null;
  try {
    return JSON.parse(originalBodyText)?.id ?? null;
  } catch {
    return null;
  }
}

function jsonRpcErrorBody(originalBodyText, statusCode, message) {
  const code = statusCode === 401 ? -32001 : statusCode === 403 ? -32003 : -32603;
  return JSON.stringify({ jsonrpc: "2.0", id: rpcId(originalBodyText), error: { code, message } });
}

// Envoy wants camelCase through proto-loader; HttpStatus.code is the shared
// enum, numeric. gRPC status 7 = PERMISSION_DENIED (any nonzero denies).
function headerOptions(headerArray) {
  return (headerArray ?? []).map((entry) => {
    const [key, value] = Object.entries(entry ?? {})[0] ?? ["content-type", "application/json"];
    return { header: { key: String(key).toLowerCase(), value: String(value) } };
  });
}

export function toCheckResponse(result, originalBodyText) {
  if (result.kind === "permit") {
    return { status: { code: 0 } };
  }

  const isDeny = result.kind === "deny";
  const denyBody = isDeny ? result.body ?? {} : {};
  const statusCode = Number.parseInt(denyBody.response_code ?? result.status ?? 403, 10) || 403;
  const body =
    denyBody.body != null && denyBody.body !== ""
      ? denyBody.body
      : jsonRpcErrorBody(originalBodyText, statusCode, isDeny ? "Access denied" : (result.message ?? "Authorization failed"));

  return {
    status: { code: 7 },
    deniedResponse: {
      status: { code: statusCode },
      headers: headerOptions(denyBody.headers),
      body,
    },
  };
}

import grpc from "@grpc/grpc-js";
import protoLoader from "@grpc/proto-loader";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const protoDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "proto");

export function createCheckHandler(config, fetchImpl = globalThis.fetch, { onPodRestartRequired } = {}) {
  return async (call, callback) => {
    try {
      const envelope = buildSidebandEnvelope(call.request);
      const originalBodyText = envelope.body ?? "";
      if (config.debugLogging) {
        console.debug(`[DEBUG] ext_authz Check: ${JSON.stringify({ ...envelope, headers: envelope.headers.map(redactHeader) })}`);
      }
      const result = await callSideband(config, envelope, fetchImpl);
      if (config.debugLogging) {
        console.debug(`[DEBUG] sideband ${result.kind} in ${result.elapsedMs ?? "?"}ms`);
      }
      if (result.podRestartRequired && onPodRestartRequired) onPodRestartRequired(result);
      callback(null, toCheckResponse(result, originalBodyText));
    } catch (error) {
      // Any adapter failure must surface as a gRPC error so agentgateway's
      // failureMode: deny keeps the request closed.
      callback({ code: grpc.status.INTERNAL, message: error?.message ?? "adapter failure" });
    }
  };
}

function redactHeader(entry) {
  const [key, value] = Object.entries(entry)[0] ?? [];
  return { [key]: /authorization|cookie|pdg-token|token/i.test(key) ? "<redacted>" : value };
}

export async function main({ onExit } = {}) {
  const config = loadConfig();
  const def = await protoLoader.load(path.join(protoDir, "ext_authz.proto"), { includeDirs: [protoDir], keepCase: false });
  const pkg = grpc.loadPackageDefinition(def);
  const server = new grpc.Server();
  // A TLS trust failure means the extracted PAZ cert is stale (PAZ rebuilt its
  // cert on restart). Exit nonzero so K8s restarts the pod — the init container
  // then re-extracts the live cert. Fail closed meanwhile: the first bad call
  // returns the 502 denial, the next ones hit a down endpoint.
  server.addService(pkg.envoy.service.auth.v3.Authorization.service, {
    Check: createCheckHandler(config, globalThis.fetch, {
      onPodRestartRequired: (result) => {
        console.error(`paz-extauthz-adapter: stale PAZ cert detected (${result.message}) — exiting for restart + re-extract`);
        try { server.tryShutdown(() => (onExit ? onExit(1) : process.exit(1))); } catch { onExit ? onExit(1) : process.exit(1); }
      },
    }),
  });
  await new Promise((resolve, reject) => {
    server.bindAsync(`0.0.0.0:${config.listenPort}`, grpc.ServerCredentials.createInsecure(), (err, bound) =>
      err ? reject(err) : resolve(bound),
    );
  });
  console.log(`paz-extauthz-adapter listening on :${config.listenPort} -> ${config.serviceUrl}/sideband/request`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
