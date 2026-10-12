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

export async function callSideband(config, envelope, fetchImpl = globalThis.fetch) {
  const started = performance.now();
  let lastError = null;

  for (let attempt = 0; attempt < retryDelaysMs.length + 1; attempt += 1) {
    if (attempt > 0) await new Promise((resolve) => setTimeout(resolve, retryDelaysMs[attempt - 1]));
    try {
      const { response, body } = await fetchJsonWithTimeout(config, "/sideband/request", envelope, fetchImpl);
      const elapsedMs = Math.round(performance.now() - started);
      if (response.status === 200) {
        return body?.response
          ? { kind: "deny", body: body.response, elapsedMs }
          : { kind: "permit", body, elapsedMs };
      }
      return { kind: "error", status: 502, message: `Sideband error (HTTP ${response.status})`, elapsedMs };
    } catch (error) {
      lastError = error;
    }
  }

  const detail = lastError?.name === "AbortError" ? "request timed out" : lastError?.message;
  return {
    kind: "error",
    status: 502,
    message: `Sideband unavailable${detail ? `: ${detail}` : ""}`,
    elapsedMs: Math.round(performance.now() - started),
  };
}
