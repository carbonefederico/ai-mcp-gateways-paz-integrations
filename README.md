# PingOne Authorize — MCP Gateway Integrations

This repository contains the PingOne Authorize integration artifacts for MCP gateways, as described in the blog series on centralizing MCP authorization across cloud platforms.

Each gateway integration uses PingOne Authorize as the centralized Policy Decision Point (PDP). The gateway acts as the Policy Enforcement Point (PEP): it collects the MCP call context, asks PingOne Authorize for a decision, and enforces the result — without embedding business authorization logic in the gateway itself.

## Blog Post Series

| Post | Gateway | Description |
|---|---|---|
| [Part 1 — Azure API Management](https://your-blog-url/centralizing-mcp-authorization-with-p1authorize-part-1-azure-apim) | Azure APIM | APIM policy fragment that delegates MCP tool authorization to PingOne Authorize |
| [Part 2 — Amazon Bedrock AgentCore Gateway](https://your-blog-url/centralizing-mcp-authorization-with-p1authorize-part-2-aws-agentcore) | AWS AgentCore | Lambda request interceptor that calls PingOne Authorize before AgentCore routes to the MCP target |

## Repository Structure

```
azure-apim/
└── src/
    └── paz-policy-fragment.xml   # APIM inbound policy fragment
```

---

## PingOne Authorize Configuration

The integrations in this repository share a common PingOne Authorize configuration pattern. Four elements are required:

1. A Trust Framework **Service** that calls the PingOne token introspection endpoint to validate the bearer token forwarded by the gateway.
2. Trust Framework **Attributes** that expose token claims (issuer, audience, scope, role, actor) to policies.
3. Trust Framework **Attributes** that expose the gateway request parameters (MCP method, tool name, arguments) to policies.
4. **Policies** in PingOne Authorize that evaluate those attributes and return a `PERMIT` or `DENY` decision.

All configuration is performed in the PingOne Authorize admin console under **Authorization**.

---

### 1. Trust Framework Service — Token Endpoint Introspection

The gateway forwards the raw bearer token as a request parameter (`gateway.bearerToken`). PingOne Authorize calls the PingOne token introspection endpoint to validate the token and receive its claims.

**Navigation:** Authorization → Trust Framework → **Services** → click **+**

| Field | Value |
|---|---|
| **Name** | `PingOne Token Introspection` (or your preferred label) |
| **Parent** | Select an organizing parent node, or leave at root |
| **Type** | `HTTP` |
| **Method** | `POST` |
| **Target URL** | `https://auth.pingone.com/<environmentId>/as/introspect` |
| **Content Type** | `application/x-www-form-urlencoded` |
| **Body** | `token=${Gateway.Request.bearerToken}` (reference the attribute defined in step 3) |
| **Authentication** | `OAuth 2.0 (Client Credentials)` |
| **Client ID** | Client ID of a PingOne application with introspection access |
| **Client Secret** | Corresponding client secret |
| **Token URL** | `https://auth.pingone.com/<environmentId>/as/token` |
| **Scope** | `openid` |

> **Caching:** Enable **Service Caching** on the service and set the cache key to `${Gateway.Request.bearerToken}`. This avoids an introspection call on every request for the same token.

> **Alternative — Local JWT validation:** If you prefer not to call the introspection endpoint, configure an **External OAuth Server** under Authorization → External OAuth Servers, set the validation type to `JWKS_URL`, and provide the PingOne JWKS URI (`https://auth.pingone.com/<environmentId>/as/jwks`). In that case the trust framework attributes in step 2 read from the built-in `PingOne.API Access Management.Identity.Access Token` attribute tree instead of the introspection service response.

---

### 2. Trust Framework Attributes — Token Claims

Create attributes that extract individual claims from the introspection service response. These attributes are used as conditions in authorization policies.

**Navigation:** Authorization → Trust Framework → **Attributes** → select or create a parent node (e.g., `Gateway > Token`) → click **+**

For each claim, create a child attribute with a **JSONPath** processor pointing to the introspection response:

| Attribute Name | Data Type | JSONPath Expression | Claim |
|---|---|---|---|
| `active` | `Boolean` | `$.active` | Token is active (not expired or revoked) |
| `iss` | `String` | `$.iss` | Issuer |
| `aud` | `String` | `$.aud` | Audience (single string or first element) |
| `sub` | `String` | `$.sub` | Subject — the human principal |
| `scope` | `String` | `$.scope` | Space-separated scopes |
| `role` | `String` | `$.role` (or your custom claim name) | Application role claim |
| `act_sub` | `String` | `$.act.sub` | Actor subject — the agent acting on behalf of the user (RFC 8693 delegation) |

> **Built-in token attributes:** If you use local JWT validation via an External OAuth Server, PingOne Authorize exposes the following built-in attributes under `PingOne.API Access Management.Identity.Access Token`:
> - `Subject` (`sub`)
> - `Scopes` (collection)
> - `Client ID`
> - `Authentication Policy` (`acr`)
> - `Authentication Time` (`auth_time`)
> - `Authentication Age`
>
> For claims not covered by built-in attributes (`iss`, `aud`, `act.sub`, custom roles), add child attributes under `PingOne.API Access Management.Identity.Access Token` with a JSONPath processor.

---

### 3. Trust Framework Attributes — Gateway Request Parameters

The gateway sends MCP call context as named parameters in the decision request body (`parameters` field). Create Trust Framework attributes that resolve from these incoming parameters so they can be used in policy conditions.

**Navigation:** Authorization → Trust Framework → **Attributes** → select or create a parent node (e.g., `Gateway > Request`) → click **+**

For each parameter, create an attribute with a **Request Parameter** resolver referencing the parameter name sent by the gateway:

| Attribute Name | Parameter Name | Description |
|---|---|---|
| `type` | `gateway.type` | Gateway type identifier (e.g., `MS-APIM`) |
| `service` | `gateway.service` | Logical name of the protected MCP service |
| `method` | `gateway.method` | MCP JSON-RPC method (e.g., `tools/call`, `tools/list`) |
| `bearerToken` | `gateway.bearerToken` | Raw bearer token from the inbound request (used as input to the introspection service) |
| `requestId` | `gateway.requestId` | MCP request ID |
| `tool` | `gateway.tool` | MCP tool name (e.g., `get_customer`, `search_customers`) |
| `arguments` | `gateway.arguments` | Serialized tool arguments (present when the gateway sends them as a single blob) |

> Individual tool arguments can also be sent as separate parameters (e.g., `gateway.customerId`) and mapped to their own attributes if fine-grained argument-level policy conditions are required.

---

### 4. Authorization Policies

Create one or more policy sets in PingOne Authorize that evaluate the token and request attributes and return a `PERMIT` or `DENY` decision.

**Navigation:** Authorization → **Policies** → click **+** to create a policy set or a policy

The following rule order is recommended. Each rule is a separate condition inside a policy that combines them with **Deny Overrides** (a single deny is sufficient to block the request):

#### Rule 1 — Token must be active

| Field | Value |
|---|---|
| **Attribute** | `Gateway.Token.active` |
| **Comparator** | **Equals** |
| **Value** | `true` |
| **Decision if false** | `DENY` |

#### Rule 2 — Issuer check

Verifies the token was issued by the expected PingOne authorization server.

| Field | Value |
|---|---|
| **Attribute** | `Gateway.Token.iss` |
| **Comparator** | **Equals** |
| **Value** | `https://auth.pingone.com/<environmentId>/as` |
| **Decision if false** | `DENY` |

#### Rule 3 — Audience check

Verifies the token audience matches the protected service.

| Field | Value |
|---|---|
| **Attribute** | `Gateway.Token.aud` |
| **Comparator** | **Equals** (or **Contains** if `aud` is a collection) |
| **Value** | `customer-mcp` (replace with your audience value) |
| **Decision if false** | `DENY` |

#### Rule 4 — Scope check

Verifies the token carries the scope required to invoke MCP tools on this service.

| Field | Value |
|---|---|
| **Attribute** | `Gateway.Token.scope` |
| **Comparator** | **Contains** |
| **Value** | `customers:mcp:read_users` (replace with your required scope) |
| **Decision if false** | `DENY` |

#### Rule 5 — Role check

Verifies the caller holds a role that permits the requested tool. This condition can be conditioned on `Gateway.Request.tool` to enforce different roles per tool.

| Field | Value |
|---|---|
| **Attribute** | `Gateway.Token.role` |
| **Comparator** | **Equals** (or **Is In** for a list of permitted roles) |
| **Value** | `advisor` (replace with your required role value) |
| **Decision if false** | `DENY` |

> **Per-tool role rules:** To enforce different roles for different tools, add a **condition** to the rule: `Gateway.Request.tool Equals "get_customer"`. Repeat for each tool with its own role requirement.

#### Rule 6 — Actor subject check (delegation / RFC 8693)

When clients use OAuth 2.0 Token Exchange so that an agent acts on behalf of a user, the token carries an `act.sub` claim identifying the agent. This rule verifies the agent is permitted to invoke the tool.

| Field | Value |
|---|---|
| **Attribute** | `Gateway.Token.act_sub` |
| **Comparator** | **Equals** (or **Is In** for a list of permitted agent identifiers) |
| **Value** | `agent-001` (replace with your permitted agent subject) |
| **Decision if false** | `DENY` |

> If token exchange is not in use and `act.sub` is absent, make this rule conditional on the attribute being present, or create a separate policy set for delegated vs. direct calls.

#### Decision endpoint

The URL for the decision endpoint is shown in the PingOne Authorize console under **Authorization → Settings**. It follows the pattern:

```
POST https://auth.pingone.com/<environmentId>/as/authorize
```

The payload format sent by each gateway integration is described in the respective deployment section below.

---

## Azure APIM — Policy Fragment Deployment

The file [azure-apim/src/paz-policy-fragment.xml](azure-apim/src/paz-policy-fragment.xml) is an Azure API Management inbound policy fragment. It performs four operations on every inbound MCP request:

1. Parses the MCP JSON-RPC body and extracts the method, tool name, arguments, request ID, and bearer token.
2. Acquires a PingOne OAuth access token via client credentials (used to call the decision endpoint).
3. Calls the PingOne Authorize decision endpoint with the request context.
4. Returns `403 Forbidden` if the decision is not `PERMIT`; otherwise continues processing.

### Prerequisites

- An Azure API Management instance.
- A PingOne environment with PingOne Authorize enabled.
- A PingOne application (Worker or Native) with the client credentials grant enabled and permission to call the PingOne Authorize decision endpoint. Note the **Client ID** and **Client Secret**.
- The PingOne Authorize policies from section 4 above deployed and active.

### Named Values

Create the following Named Values in Azure API Management before deploying the fragment.

**Navigation:** Azure Portal → API Management instance → **Named values** → **+ Add**

| Named Value Key | Type | Value |
|---|---|---|
| `PingOneTokenUrl` | Plain | `https://auth.pingone.com/<environmentId>/as/token` |
| `PingOneClientId` | Plain | Client ID of the PingOne worker application |
| `PingOneClientSecret` | **Secret** | Client secret of the PingOne worker application |
| `PingOneDecisionEndpoint` | Plain | PingOne Authorize decision endpoint URL (from Authorization → Settings in PingOne Authorize) |

> Mark `PingOneClientSecret` as **Secret** so the value is stored encrypted and masked in logs and portal views.

### Deploying the Fragment

1. In the Azure Portal, open your API Management instance.
2. Navigate to **APIs → Policy fragments → + Create**.
3. Set the **Name** (e.g., `paz-mcp-authz`) and an optional description.
4. Paste the contents of [azure-apim/src/paz-policy-fragment.xml](azure-apim/src/paz-policy-fragment.xml) into the policy editor.
5. Save the fragment.

### Setting the Service Variable

Before the fragment runs, APIM must set the `pazService` variable to identify which logical MCP service is being called. Add this line in the **inbound** policy of the API or operation, before the `<include-fragment>` tag:

```xml
<set-variable name="pazService" value="customer-mcp" />
```

Replace `customer-mcp` with the logical service name that your PingOne Authorize policy uses to identify this MCP server (matched against the `gateway.service` parameter in the policy).

### Associating the Fragment with an API Operation

In the inbound policy of the API or specific operation that exposes the MCP endpoint, include the fragment:

```xml
<inbound>
    <base />
    <set-variable name="pazService" value="customer-mcp" />
    <include-fragment fragment-id="paz-mcp-authz" />
</inbound>
```

The fragment runs after `<base />` and before the request is forwarded to the backend MCP server.

### Decision Request Payload

The fragment sends the following payload to PingOne Authorize:

```json
{
  "parameters": {
    "gateway.type": "MS-APIM",
    "gateway.service": "<value of pazService variable>",
    "gateway.method": "tools/call",
    "gateway.bearerToken": "<raw bearer token from Authorization header>",
    "gateway.requestId": "<MCP request id>",
    "gateway.tool": "get_customer",
    "gateway.arguments": "{\"customerId\": \"CUST-10001\"}"
  }
}
```

`gateway.tool` and `gateway.arguments` are omitted when the MCP method is not `tools/call` (e.g., during `tools/list` or `initialize`).

### Response Handling

- **PERMIT**: APIM continues and forwards the request to the backend MCP server.
- **DENY**: APIM returns `403 Forbidden` immediately. The response body includes the error code and message from the PingOne Authorize decision statements:

```json
{
  "error": {
    "code": "access-denied",
    "message": "Access denied",
    "obligatory": true,
    "fulfilled": false
  }
}
```

### Production Hardening

- **Token caching:** The fragment acquires a new OAuth token on every request. In production, cache the access token using `cache-store-value` and `cache-lookup-value` APIM policies and refresh it shortly before `expires_in`.
- **Timeouts:** The `timeout` on both `send-request` elements is set to `20` seconds. Tune this to your PingOne Authorize SLA.
- **TLS:** Both calls use HTTPS. Ensure the APIM instance can reach the PingOne endpoints (no outbound firewall blocking `auth.pingone.com`).

---

## Resources

- [PingOne Authorize Documentation](https://docs.pingidentity.com/pingoneauthorize/latest) — product documentation including Trust Framework and Policy configuration.
- [Azure API Management Policy Reference](https://learn.microsoft.com/en-us/azure/api-management/api-management-policies) — reference for APIM policy expressions and `send-request`.
- [OAuth 2.0 Token Exchange — RFC 8693](https://www.rfc-editor.org/rfc/rfc8693) — the `act` claim and delegation model used in the actor subject policies.
