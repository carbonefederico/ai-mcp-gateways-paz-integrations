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
