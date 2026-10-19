#!/bin/bash
# policy-e2e-tests.sh — End-to-end policy tests for the portfolio MCP demo.
#
# Chain under test:
#   client -> agentgateway (extAuthz gRPC) -> paz-extauthz-adapter
#          -> PingAuthorize sideband -> PAP policy branch -> demo-mcp
#
# Tokens are minted on the fly by jwt-lab (https://jwt-lab-beta.vercel.app).
# No presets — claims are explicit so each scenario is self-documenting.
#
# Usage:
#   ./policy-e2e-tests.sh              # run the full matrix
#   ./policy-e2e-tests.sh --verbose    # print request/response payloads and
#                                      # pause for confirmation before each test
#
# Requirements: curl, jq
# Environment overrides: AG_URL, JWT_LAB, AUD.

set -u

VERBOSE=0
[ "${1:-}" = "--verbose" ] || [ "${1:-}" = "-v" ] && VERBOSE=1

AG_URL="${AG_URL:-http://localhost:3001/mcp}"
JWT_LAB="${JWT_LAB:-https://jwt-lab-beta.vercel.app/api/token}"
AUD="${AUD:-http://localhost:3001}"
# RFC 8707 resource identifier — the MCP audience. Policies gate on this per-MCP value
# (Constants.MCP Audience), not on the gateway root host.
MCP_AUD="${MCP_AUD:-https://agentgateway-stack-ag.ping-devops.com/mcp/portfolio}"

command -v jq >/dev/null 2>&1 || { echo "jq is required (brew install jq)"; exit 2; }

mint() {
  # mint <claims-json> <ttl-seconds> -> prints access token
  curl -sk --max-time 20 -X POST "$JWT_LAB" \
    -H "content-type: application/json" \
    -d "{\"claims\":$1,\"expiresIn\":$2}" | jq -r '.access_token'
}

# summarize <http-body>: one human-readable line out of an MCP response
# (plain JSON or SSE "event:/data:" frames).
summarize() {
  local payload
  payload=$(grep -E '^data: ' <<< "$1" | tail -n1 | sed 's/^data: //')
  [ -z "$payload" ] && payload="$1"
  local kind
  kind=$(jq -r 'if .error then "error" elif .result.tools then "tools" elif .result then "result" else "other" end' <<< "$payload" 2>/dev/null)
  case "$kind" in
    error)  printf 'JSON-RPC error %s: %s' "$(jq -r '.error.code' <<< "$payload")" "$(jq -r '.error.message' <<< "$payload")" ;;
    tools)  printf 'tools/list OK (%s tools)' "$(jq -r '.result.tools | length' <<< "$payload")" ;;
    result) printf 'tool result: %s' "$(jq -r '.result.content[0].text' <<< "$payload" | head -1 | head -c 120)" ;;
    *)      head -c 120 <<< "$1" ;;
  esac
}

# ---------------------------------------------------------------- tokens ---
echo "Minting scenario tokens (jwt-lab)..."
T_READ=$(mint '{"sub":"alice","client_id":"desktop-client","aud":"'$MCP_AUD'","scope":"portfolio:read"}' 1800)
T_WRITE=$(mint '{"sub":"alice","client_id":"desktop-client","aud":"'$MCP_AUD'","scope":"portfolio:read portfolio:write"}' 1800)
T_APPROVED=$(mint '{"sub":"alice","client_id":"desktop-client","aud":"'$MCP_AUD'","scope":"portfolio:read portfolio:write","approved_for":"submit_trade_order","txn":"txn-70001-sell","tctx":{"tool":"submit_trade_order","customerId":"CUST-70001","symbol":"ACME","side":"SELL","quantity":100,"amount":50000}}' 900)
T_EXPIRED=$(mint '{"sub":"alice","aud":"'$MCP_AUD'","scope":"portfolio:read"}' -300)
T_WRITE_ONLY=$(mint '{"sub":"alice","aud":"'$MCP_AUD'","scope":"portfolio:write"}' 900)
T_APPROVED_AMOUNT_DRIFT=$(mint '{"sub":"alice","client_id":"desktop-client","aud":"'$MCP_AUD'","scope":"portfolio:read portfolio:write","approved_for":"submit_trade_order","txn":"txn-70001-sell","tctx":{"tool":"submit_trade_order","customerId":"CUST-70001","symbol":"ACME","side":"SELL","quantity":100,"amount":10000}}' 900)

T_VIP_AGENT=$(mint '{"sub":"vip_user","sub_type":"vip_user","client_id":"customer_support_agent","aud":"'$MCP_AUD'","scope":"portfolio:read portfolio:write","act":{"sub":"customer_support_agent"}}' 1800)
T_STD_AGENT=$(mint '{"sub":"standard_user","sub_type":"standard","client_id":"customer_support_agent","aud":"'$MCP_AUD'","scope":"portfolio:read portfolio:write","act":{"sub":"customer_support_agent"}}' 1800)
T_VIP_DIRECT=$(mint '{"sub":"vip_user","sub_type":"vip_user","client_id":"advisory-portal","aud":"'$MCP_AUD'","scope":"portfolio:read portfolio:write"}' 1800)
T_VIP_APPROVED=$(mint '{"sub":"vip_user","sub_type":"vip_user","client_id":"customer_support_agent","aud":"'$MCP_AUD'","scope":"portfolio:read portfolio:write","act":{"sub":"customer_support_agent"},"approved_for":"submit_trade_order","txn":"txn-70001-sell","tctx":{"tool":"submit_trade_order","customerId":"CUST-70001","symbol":"ACME","side":"SELL","quantity":100,"amount":50000}}' 1800)
# R2 positive: the DECLARED agent (Constants.Portfolio Analysis Agent = customer_support_agent),
# whatever client minted the token — authorization of the agent is an admin decision, not a token one
T_AGENT_DECLARED=$(mint '{"sub":"vip_user","sub_type":"vip_user","client_id":"advisory-portal","aud":"'$MCP_AUD'","scope":"portfolio:read portfolio:write","act":{"sub":"customer_support_agent"}}' 900)
# R2 negative: a delegated actor that is NOT the declared agent
T_AGENT_UNDECLARED=$(mint '{"sub":"vip_user","sub_type":"vip_user","client_id":"customer_support_agent","aud":"'$MCP_AUD'","scope":"portfolio:read portfolio:write","act":{"sub":"marketing_agent"}}' 900)
# HITL-band approvals: 3k order mirrored exactly (tctx matches payload, txn bound)
T_APPROVED_3K=$(mint '{"sub":"alice","client_id":"desktop-client","aud":"'$MCP_AUD'","scope":"portfolio:read portfolio:write","approved_for":"submit_trade_order","txn":"txn-70001-small","tctx":{"tool":"submit_trade_order","customerId":"CUST-70001","symbol":"ACME","side":"SELL","quantity":3,"amount":3000}}' 900)
T_VIP_APPROVED_3K=$(mint '{"sub":"vip_user","sub_type":"vip_user","client_id":"customer_support_agent","aud":"'$MCP_AUD'","scope":"portfolio:read portfolio:write","act":{"sub":"customer_support_agent"},"approved_for":"submit_trade_order","txn":"txn-70001-small","tctx":{"tool":"submit_trade_order","customerId":"CUST-70001","symbol":"ACME","side":"SELL","quantity":3,"amount":3000}}' 900)
# R1 negative: token minted for the wrong audience (the gateway root, not the MCP resource)
T_READ_OLD_AUD=$(mint '{"sub":"alice","client_id":"desktop-client","aud":"'$AUD'","scope":"portfolio:read"}' 900)

# ---------------------------------------------------------------- bodies ---
# Special JSON-RPC bodies are built with jq -c to avoid quoting mistakes.
ORDER_3K='{"customerId":"CUST-70001","symbol":"ACME","side":"SELL","quantity":3,"orderType":"MARKET","confirmedByUser":true,"amount":3000,"txn":"txn-70001-small"}'
ORDER_50K='{"customerId":"CUST-70001","symbol":"ACME","side":"SELL","quantity":100,"orderType":"MARKET","confirmedByUser":true,"amount":50000,"txn":"txn-70001-sell"}'
ORDER_50K_WRONG_TXN='{"customerId":"CUST-70001","symbol":"ACME","side":"SELL","quantity":100,"orderType":"MARKET","confirmedByUser":true,"amount":50000,"txn":"txn-replayed"}'
ORDER_50K_NO_TXN='{"customerId":"CUST-70001","symbol":"ACME","side":"SELL","quantity":100,"orderType":"MARKET","confirmedByUser":true,"amount":50000}'
ORDER_NO_AMOUNT='{"customerId":"CUST-70001","symbol":"ACME","side":"BUY","quantity":1,"orderType":"LIMIT","confirmedByUser":true}'
ORDER_10K='{"customerId":"CUST-70001","symbol":"ACME","side":"SELL","quantity":100,"orderType":"MARKET","confirmedByUser":true,"amount":10000,"txn":"txn-70001-sell"}'
ORDER_ZERO='{"customerId":"CUST-70001","symbol":"ACME","side":"SELL","quantity":1,"orderType":"MARKET","confirmedByUser":true,"amount":0}'
ORDER_20K='{"customerId":"CUST-70001","symbol":"ACME","side":"SELL","quantity":100,"orderType":"MARKET","confirmedByUser":true,"amount":20000,"txn":"txn-70001-small"}'

BODY_T2='{"jsonrpc":"2.0","method":"tools/call","id":2,"params":{"name":"get_portfolio_summary","arguments":{"customerId":"CUST-70001"}}}'
BODY_T3=$(jq -nc --argjson args "$ORDER_3K" '{jsonrpc:"2.0",method:"tools/call",id:3,params:{name:"submit_trade_order",arguments:$args}}')
BODY_T4=$(jq -nc --argjson args "$ORDER_50K" '{jsonrpc:"2.0",method:"tools/call",id:4,params:{name:"submit_trade_order",arguments:$args}}')
BODY_T4_WRONG_TXN=$(jq -nc --argjson args "$ORDER_50K_WRONG_TXN" '{jsonrpc:"2.0",method:"tools/call",id:5,params:{name:"submit_trade_order",arguments:$args}}')
BODY_T4_NO_TXN=$(jq -nc --argjson args "$ORDER_50K_NO_TXN" '{jsonrpc:"2.0",method:"tools/call",id:6,params:{name:"submit_trade_order",arguments:$args}}')
BODY_T3B=$(jq -nc --argjson args "$ORDER_NO_AMOUNT" '{jsonrpc:"2.0",method:"tools/call",id:8,params:{name:"submit_trade_order",arguments:$args}}')
BODY_T_ZERO=$(jq -nc --argjson args "$ORDER_ZERO" '{jsonrpc:"2.0",method:"tools/call",id:13,params:{name:"submit_trade_order",arguments:$args}}')
BODY_T_20K=$(jq -nc --argjson args "$ORDER_20K" '{jsonrpc:"2.0",method:"tools/call",id:14,params:{name:"submit_trade_order",arguments:$args}}')
BODY_T_3K_APPROVED=$(jq -nc --argjson args "$ORDER_3K" '{jsonrpc:"2.0",method:"tools/call",id:15,params:{name:"submit_trade_order",arguments:$args}}')
BODY_T5C=$(jq -nc --argjson args "$ORDER_10K" '{jsonrpc:"2.0",method:"tools/call",id:10,params:{name:"submit_trade_order",arguments:$args}}')
BODY_T6='{"jsonrpc":"2.0","method":"tools/call","id":7,"params":{"name":"delete_portfolio","arguments":{"customerId":"CUST-70001"}}}'

# ---------------------------------------------------------------- session ---
# agentgateway's MCP route enforces session semantics: every non-initialize
# POST needs the mcp-session-id issued by a prior initialize. Open one session
# up front and ride it for the whole matrix — PAZ re-evaluates every request
# independently (token + body), so a shared session doesn't weaken the tests
# (an expired/garbage token on a live session still 401s, verified in T9).
SESSION_ID=""
SID_HDR=()
SESSION_ID=$(curl -sk --max-time 40 -X POST "$AG_URL" \
    -H "Content-Type: application/json" \
    -H "Accept: application/json, text/event-stream" \
    -H "Authorization: Bearer $(mint '{"sub":"alice","client_id":"desktop-client","aud":"'$MCP_AUD'","scope":"portfolio:read"}' 300)" \
    -d '{"jsonrpc":"2.0","method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"policy-e2e","version":"1.0"}},"id":0}' \
    -D - -o /dev/null 2>/dev/null | grep -i '^mcp-session-id:' | awk '{print $2}' | tr -d '\r')
[ -n "$SESSION_ID" ] && SID_HDR=(-H "mcp-session-id: $SESSION_ID")

# ---------------------------------------------------------------- tests ---
PASS=0; FAIL=0
report() { # report <label> <expected-code> <actual-code>
  local mark="FAIL"
  if [ "$3" = "$2" ]; then mark="PASS"; PASS=$((PASS+1)); else FAIL=$((FAIL+1)); fi
  printf '  %-4s %-52s (expected %s)\n' "$mark" "$1" "$2"
}

run() { # run <label> <expect-code> <token> <body>
  # Retries on 502: gateway->PAZ sideband occasionally trips on a cold
  # connection (adapter returns "sideband-unavailable"); a retry proves the
  # outcome is policy-driven, not transport noise.
  local out attempt body_file
  if [ "$VERBOSE" = "1" ]; then
    echo ""
    echo "=== $1  (expected $2) ==="
    echo "--- request ---"
    echo "POST $AG_URL"
    jq . <<< "$4"
    printf 'continue? [Y/n]: '
    read -r ans
    case "$ans" in n|N|no) echo "  SKIP (not run)"; return ;; esac
  fi
  body_file=$(mktemp)
  printf '%s' "$4" > "$body_file"
  for attempt in 1 2 3; do
    out=$(curl -sk --max-time 40 -X POST "$AG_URL" \
      -H "Content-Type: application/json" \
      -H "Accept: application/json, text/event-stream" \
      -H "Authorization: Bearer $3" \
      "${SID_HDR[@]+${SID_HDR[@]}}" \
      -d @"$body_file" -o /dev/null -w '%{http_code}' 2>&1)
    [ "$out" != "502" ] && break
  done
  if [ "$VERBOSE" = "1" ]; then
    local full hdr body resp_code
    full=$(curl -sk --max-time 40 -i -X POST "$AG_URL" \
      -H "Content-Type: application/json" -H "Accept: application/json, text/event-stream" \
      -H "Authorization: Bearer $3" \
      "${SID_HDR[@]+${SID_HDR[@]}}" -d @"$body_file" 2>&1)
    resp_code=$(printf '%s\n' "$full" | head -1 | awk '{print $2}')
    out="$resp_code"
    hdr=$(printf '%s\n' "$full" | sed -n '1,/^\r*$/p' | grep -i -E 'www-authenticate|content-type')
    body=$(printf '%s\n' "$full" | sed '1,/^\r*$/d')
    echo "--- response ($resp_code) ---"
    [ -n "$hdr" ] && printf '%s\n' "$hdr"
    if grep -q '^data: ' <<< "$body"; then
      grep '^data: ' <<< "$body" | sed 's/^data: //' | jq . 2>/dev/null || cat <<< "$body"
    else
      jq . <<< "$body" 2>/dev/null || cat <<< "$body"
    fi
  fi
  rm -f "$body_file"
  report "$1" "$2" "$out"
}

echo ""
echo "--- Core policy matrix ---"
run "T1 tools/list (session, portfolio:read)"       200 "$T_READ"       '{"jsonrpc":"2.0","method":"tools/list","id":1}'
run "T2 read tool with portfolio:read"              200 "$T_READ"       "$BODY_T2"
# Order bands (explicit partition): amount<=0 deny | 0<amount<=20K HITL | amount>20K deny
run "T3 HITL order (3k) without approval"           403 "$T_WRITE"      "$BODY_T3"
run "T3b order without amount (unpriceable deny)"   403 "$T_WRITE"      "$BODY_T3B"
run "T3c explicit zero-amount order (deny)"         403 "$T_WRITE"      "$BODY_T_ZERO"
run "T3d HITL order (3k) with approval mirror"      200 "$T_APPROVED_3K" "$BODY_T_3K_APPROVED"
run "T3e order at 20K boundary (HITL, no appr)"     403 "$T_WRITE"      "$BODY_T_20K"
run "T4 oversized order (50k) without approval"     403 "$T_WRITE"      "$BODY_T4"
# Approval cannot exceed the band: a fully mirrored 50k approval is still denied
run "T5 oversized order WITH approval mirror"       403 "$T_APPROVED"   "$BODY_T4"
run "T5a approved but wrong txn (replay denied)"    403 "$T_APPROVED"   "$BODY_T4_WRONG_TXN"
run "T5b approved token, payload without txn"       403 "$T_APPROVED"   "$BODY_T4_NO_TXN"
run "T5c approved for 10k, executing 50k (drift)"   403 "$T_APPROVED_AMOUNT_DRIFT" "$BODY_T4"
run "T5d vip+agent 3k order WITH approval"          200 "$T_VIP_APPROVED_3K" "$BODY_T_3K_APPROVED"
run "T6 unknown tool (default deny)"                403 "$T_READ"       "$BODY_T6"
run "T8 read tool with write-only scope"            403 "$T_WRITE_ONLY" "$BODY_T2"
run "T9 expired token"                              401 "$T_EXPIRED"    '{"jsonrpc":"2.0","method":"tools/list","id":9}'

echo ""
echo "--- Transport posture ---"
# T0: a bodyless GET (SSE stream open) carries no JSON-RPC body, so no tool
# policy can match. A valid token is sent so the token validator passes and
# the measured verdict is PAZ's default deny, not the missing-token 401.
# The chain must answer, not hang or permit.
out=$(curl -sk --max-time 40 -o /dev/null -w '%{http_code}' "$AG_URL" \
  -H "Accept: text/event-stream" \
  -H "Authorization: Bearer $T_READ" \
  "${SID_HDR[@]+${SID_HDR[@]}}")
report "T0 bodyless GET stream open (default deny)" 403 "$out"

echo ""
echo "--- Delegation (RFC 8693 act.sub / sub_type) ---"
run "D1 vip_user + advisory agent read"             200 "$T_VIP_AGENT"    "$BODY_T2"
run "D2 standard_user + same agent (gate deny)"     403 "$T_STD_AGENT"    "$BODY_T2"
run "D3 vip_user direct, no agent"                  200 "$T_VIP_DIRECT"   "$BODY_T2"
run "D4 vip+agent 3k order (no approval deny)"      403 "$T_VIP_AGENT"    "$BODY_T3"
run "D5 vip+agent risky, no approval"               403 "$T_VIP_AGENT"    "$BODY_T4"
# Delegation does not extend the band: vip+agent with a fully mirrored 50k approval is still
# denied — the oversized deny applies regardless of who is acting
run "D6 vip+agent 50k WITH approval (band deny)"    403 "$T_VIP_APPROVED" "$BODY_T4"
run "D7 std_user + agent tools/list (R3 in P1)"     403 "$T_STD_AGENT"    '{"jsonrpc":"2.0","method":"tools/list","id":11}'

echo ""
echo "--- Ladder gates (R1 audience / R2 agent identity) ---"
BODY_T_R2=$(jq -nc --argjson args "$ORDER_3K" '{jsonrpc:"2.0",method:"tools/call",id:12,params:{name:"submit_trade_order",arguments:$args}}')
run "R2 declared agent allowed (act.sub matches)"   200 "$T_AGENT_DECLARED"  "$BODY_T2"
run "R2 undeclared agent denied (act.sub differs)"  403 "$T_AGENT_UNDECLARED" "$BODY_T2"
# A token minted for the wrong resource is an invalid token for this MCP — RFC 6750 invalid_token,
# which PAZ maps to 401 (the R1 statement's payload carries status 401).
run "R1 wrong audience (gateway-root aud)"          401 "$T_READ_OLD_AUD"  "$BODY_T2"

echo ""
echo "Result: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ] || exit 1
