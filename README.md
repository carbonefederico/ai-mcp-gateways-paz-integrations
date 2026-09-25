# Ping Authorize — MCP Gateway Integrations

This repository contains the Ping Authorize integration artifacts for MCP
gateways, as described in the blog series on centralizing MCP authorization
across cloud platforms.

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
| [`azure-apim/`](azure-apim/) | **Azure API Management integration** — the sideband policy fragment (PEP), the exported PingAuthorize policy set (session methods, VIP delegation gate, payload-risk-tiered HITL changes, default deny), a 14-test end-to-end harness, and guides: main README (fragment + policies) and [test/test.md](azure-apim/test/test.md) (sample MCP, policies, local setup, tests). |
| `aws-agentcore-mcp-gateway/` | AWS AgentCore MCP gateway integration (in progress). |
| `test-scripts/` | Scratch scripts used during development (OIDC token-exchange experiments, sideband probes). |

Start here for the working, tested integration: [`azure-apim/README.md`](azure-apim/README.md).

## Resources

- [Ping Authorize Documentation](https://docs.pingidentity.com/pingauthorize/latest) — self-hosted PDP, sideband API, Policy Editor.
- [PingOne Authorize Documentation](https://docs.pingidentity.com/pingoneauthorize/latest) — cloud PDP, Trust Framework and policy configuration.
- [Azure API Management Policy Reference](https://learn.microsoft.com/en-us/azure/api-management/api-management-policies) — reference for APIM policy expressions and `send-request`.
- [OAuth 2.0 Token Exchange — RFC 8693](https://www.rfc-editor.org/rfc/rfc8693) — the `act` claim and delegation model used in the delegation policies.
- [OAuth Transaction Tokens](https://datatracker.ietf.org/doc/html/draft-ietf-oauth-transaction-tokens) — the `txn`/`tctx` transaction-context model behind the HITL approval flow.
