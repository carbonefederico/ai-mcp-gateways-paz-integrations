# Ping Authorize — MCP Gateway Integrations

This repository contains the Ping Authorize integration artifacts for MCP
gateways.

Each gateway integration uses Ping Authorize (PingOne Authorize in the cloud
or self-hosted PingAuthorize) as the centralized Policy Decision Point (PDP).
The gateway acts as the Policy Enforcement Point (PEP): it collects the MCP
call context, asks Ping Authorize for a decision, and enforces the result —
without embedding business authorization logic in the gateway itself. The
sideband protocol used between gateway and authorization server is shared by
both products, so the same gateway artifacts work with either.

## Repository layout

| Folder | Contents |
|---|---|
| [`azure-apim/`](azure-apim/) | **Azure API Management integration** — the sideband policy fragment (PEP), the exported PingAuthorize policy set (session methods, VIP delegation gate, payload-risk-tiered HITL changes bound to a `txn` transaction id, default deny), a 16-test end-to-end harness, and guides: main README (fragment + policies) and [test/test.md](azure-apim/test/test.md) (sample MCP, policies, local setup, tests). |
| [`agentgateway/`](agentgateway/) | **agentgateway integration** — the Envoy ext_authz ⇄ sideband gRPC adapter (PEP), the agentgateway standalone config, the portfolio policy branch snapshot (`k8s/server-profiles/pingauthorizepap/policies/AgentGatewayPortfolioMCP.SNAPSHOT`; explicit order bands with a threshold constant, the mandatory R1–R4 ladder gates, a six-field transaction approval mirror), a 27-test e2e harness, and guides: main README (adapter + config) and [test/test.md](agentgateway/test/test.md) (sample MCP, the policy model, local setup, tests). |
| [`agentgateway/k8s/`](agentgateway/k8s/) | **Self-contained K8s stack** — one Helm chart deploying the whole chain into a namespace: PingAuthorize + PAP (Ping chart, StatefulSets), the adapter, agentgateway, and demo-mcp. Policies, the token validator, and the sideband endpoint bootstrap automatically from the server profiles (profile hook overrides import and commit the policy branch; PAZ waits for the commit before its PDP starts) — no manual post-install step. Deployment, prerequisites, and security posture: [agentgateway/README.md](agentgateway/README.md) ("Kubernetes deployment"); bootstrap contracts: [agentgateway/k8s/server-profiles/README.md](agentgateway/k8s/server-profiles/README.md). |

Start here for the working, tested integration: [`agentgateway/`](agentgateway/) — the K8s stack deploys end-to-end from one chart and passes its 27-scenario e2e matrix; the APIM integration predates it and shares the policy model.

## Resources

- [Ping Authorize Documentation](https://docs.pingidentity.com/pingauthorize/latest) — self-hosted PDP, sideband API, Policy Editor.
- [PingOne Authorize Documentation](https://docs.pingidentity.com/pingoneauthorize/latest) — cloud PDP, Trust Framework and policy configuration.
- [Azure API Management Policy Reference](https://learn.microsoft.com/en-us/azure/api-management/api-management-policies) — reference for APIM policy expressions and `send-request`.
- [OAuth 2.0 Token Exchange — RFC 8693](https://www.rfc-editor.org/rfc/rfc8693) — the `act` claim and delegation model used in the delegation policies.
- [OAuth Transaction Tokens](https://datatracker.ietf.org/doc/html/draft-ietf-oauth-transaction-tokens) — the `txn`/`tctx` transaction-context model behind the HITL approval flow.
