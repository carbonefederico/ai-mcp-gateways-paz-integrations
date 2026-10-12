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

AG_URL="${AG_URL:-http://localhost:3001/portfolio}"
JWT_LAB="${JWT_LAB:-https://jwt-lab-beta.vercel.app/api/token}"
AUD="${AUD:-http://localhost:3001}"

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
T_READ=$(mint '{"sub":"alice","client_id":"desktop-client","aud":"'$AUD'","scope":"portfolio:read"}' 1800)
T_WRITE=$(mint '{"sub":"alice","client_id":"desktop-client","aud":"'$AUD'","scope":"portfolio:read portfolio:write"}' 1800)
T_APPROVED=$(mint '{"sub":"alice","client_id":"desktop-client","aud":"'$AUD'","scope":"portfolio:read portfolio:write","approved_for":"submit_trade_order","txn":"txn-70001-sell","tctx":{"tool":"submit_trade_order","customerId":"CUST-70001","symbol":"ACME","side":"SELL","quantity":100,"amount":50000}}' 900)
T_EXPIRED=$(mint '{"sub":"alice","aud":"'$AUD'","scope":"portfolio:read"}' -300)
T_WRITE_ONLY=$(mint '{"sub":"alice","aud":"'$AUD'","scope":"portfolio:write"}' 900)
T_APPROVED_AMOUNT_DRIFT=$(mint '{"sub":"alice","client_id":"desktop-client","aud":"'$AUD'","scope":"portfolio:read portfolio:write","approved_for":"submit_trade_order","txn":"txn-70001-sell","tctx":{"tool":"submit_trade_order","customerId":"CUST-70001","symbol":"ACME","side":"SELL","quantity":100,"amount":10000}}' 900)

T_VIP_AGENT=$(mint '{"sub":"vip_user","sub_type":"vip_user","client_id":"advisory-portal","aud":"'$AUD'","scope":"portfolio:read portfolio:write","act":{"sub":"customer_support_agent"}}' 1800)
T_STD_AGENT=$(mint '{"sub":"standard_user","sub_type":"standard","client_id":"advisory-portal","aud":"'$AUD'","scope":"portfolio:read portfolio:write","act":{"sub":"customer_support_agent"}}' 1800)
T_VIP_DIRECT=$(mint '{"sub":"vip_user","sub_type":"vip_user","client_id":"advisory-portal","aud":"'$AUD'","scope":"portfolio:read portfolio:write"}' 1800)
T_VIP_APPROVED=$(mint '{"sub":"vip_user","sub_type":"vip_user","client_id":"advisory-portal","aud":"'$AUD'","scope":"portfolio:read portfolio:write","act":{"sub":"customer_support_agent"},"approved_for":"submit_trade_order","txn":"txn-70001-sell","tctx":{"tool":"submit_trade_order","customerId":"CUST-70001","symbol":"ACME","side":"SELL","quantity":100,"amount":50000}}' 1800)

# ---------------------------------------------------------------- bodies ---
# Special JSON-RPC bodies are built with jq -c to avoid quoting mistakes.
ORDER_3K='{"customerId":"CUST-70001","symbol":"ACME","side":"SELL","quantity":3,"orderType":"MARKET","confirmedByUser":true,"amount":3000,"txn":"txn-70001-small"}'
ORDER_50K='{"customerId":"CUST-70001","symbol":"ACME","side":"SELL","quantity":100,"orderType":"MARKET","confirmedByUser":true,"amount":50000,"txn":"txn-70001-sell"}'
ORDER_50K_WRONG_TXN='{"customerId":"CUST-70001","symbol":"ACME","side":"SELL","quantity":100,"orderType":"MARKET","confirmedByUser":true,"amount":50000,"txn":"txn-replayed"}'
ORDER_50K_NO_TXN='{"customerId":"CUST-70001","symbol":"ACME","side":"SELL","quantity":100,"orderType":"MARKET","confirmedByUser":true,"amount":50000}'
ORDER_NO_AMOUNT='{"customerId":"CUST-70001","symbol":"ACME","side":"BUY","quantity":1,"orderType":"LIMIT","confirmedByUser":true}'
ORDER_10K='{"customerId":"CUST-70001","symbol":"ACME","side":"SELL","quantity":100,"orderType":"MARKET","confirmedByUser":true,"amount":10000,"txn":"txn-70001-sell"}'

BODY_T2='{"jsonrpc":"2.0","method":"tools/call","id":2,"params":{"name":"get_portfolio_summary","arguments":{"customerId":"CUST-70001"}}}'
BODY_T3=$(jq -nc --argjson args "$ORDER_3K" '{jsonrpc:"2.0",method:"tools/call",id:3,params:{name:"submit_trade_order",arguments:$args}}')
BODY_T4=$(jq -nc --argjson args "$ORDER_50K" '{jsonrpc:"2.0",method:"tools/call",id:4,params:{name:"submit_trade_order",arguments:$args}}')
BODY_T4_WRONG_TXN=$(jq -nc --argjson args "$ORDER_50K_WRONG_TXN" '{jsonrpc:"2.0",method:"tools/call",id:5,params:{name:"submit_trade_order",arguments:$args}}')
BODY_T4_NO_TXN=$(jq -nc --argjson args "$ORDER_50K_NO_TXN" '{jsonrpc:"2.0",method:"tools/call",id:6,params:{name:"submit_trade_order",arguments:$args}}')
BODY_T3B=$(jq -nc --argjson args "$ORDER_NO_AMOUNT" '{jsonrpc:"2.0",method:"tools/call",id:8,params:{name:"submit_trade_order",arguments:$args}}')
BODY_T5C=$(jq -nc --argjson args "$ORDER_10K" '{jsonrpc:"2.0",method:"tools/call",id:10,params:{name:"submit_trade_order",arguments:$args}}')
BODY_T6='{"jsonrpc":"2.0","method":"tools/call","id":7,"params":{"name":"delete_portfolio","arguments":{"customerId":"CUST-70001"}}}'

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
    printf 'continue? [y/N]: '
    read -r ans
    case "$ans" in y|Y|yes) ;; *) echo "  SKIP (not run)"; return ;; esac
  fi
  body_file=$(mktemp)
  printf '%s' "$4" > "$body_file"
  for attempt in 1 2 3; do
    out=$(curl -sk --max-time 40 -X POST "$AG_URL" \
      -H "Content-Type: application/json" \
      -H "Accept: application/json, text/event-stream" \
      -H "Authorization: Bearer $3" \
      -d @"$body_file" -o /dev/null -w '%{http_code}' 2>&1)
    [ "$out" != "502" ] && break
  done
  if [ "$VERBOSE" = "1" ]; then
    local full hdr body resp_code
    full=$(curl -sk --max-time 40 -i -X POST "$AG_URL" \
      -H "Content-Type: application/json" -H "Accept: application/json, text/event-stream" \
      -H "Authorization: Bearer $3" -d @"$body_file" 2>&1)
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
run "T3 low-risk order (3k) with portfolio:write"   200 "$T_WRITE"      "$BODY_T3"
run "T3b order without amount (treated low-risk)"   200 "$T_WRITE"      "$BODY_T3B"
run "T4 high-risk order (50k) without approval"     403 "$T_WRITE"      "$BODY_T4"
run "T5 high-risk order with approval mirror"       200 "$T_APPROVED"   "$BODY_T4"
run "T5a approved but wrong txn (replay denied)"    403 "$T_APPROVED"   "$BODY_T4_WRONG_TXN"
run "T5b approved token, payload without txn"       403 "$T_APPROVED"   "$BODY_T4_NO_TXN"
run "T5c approved for 10k, executing 50k (drift)"   403 "$T_APPROVED_AMOUNT_DRIFT" "$BODY_T4"
run "T6 unknown tool (default deny)"                403 "$T_READ"       "$BODY_T6"
run "T8 read tool with write-only scope"            403 "$T_WRITE_ONLY" "$BODY_T2"
run "T9 expired token"                              401 "$T_EXPIRED"    '{"jsonrpc":"2.0","method":"tools/list","id":9}'

echo ""
echo "--- Transport posture ---"
# T0: a bodyless GET (SSE stream open) carries no JSON-RPC body; PAZ must
# deny it (default deny) — the gateway chain must answer, not hang or permit.
out=$(curl -sk --max-time 40 -o /dev/null -w '%{http_code}' "$AG_URL" -H "Accept: text/event-stream")
report "T0 bodyless GET stream open (default deny)" 403 "$out"

echo ""
echo "--- Delegation (RFC 8693 act.sub / sub_type) ---"
run "D1 vip_user + advisory agent read"             200 "$T_VIP_AGENT"    "$BODY_T2"
run "D2 standard_user + same agent (gate deny)"     403 "$T_STD_AGENT"    "$BODY_T2"
run "D3 vip_user direct, no agent"                  200 "$T_VIP_DIRECT"   "$BODY_T2"
run "D4 vip+agent low-risk order"                   200 "$T_VIP_AGENT"    "$BODY_T3"
run "D5 vip+agent risky, no approval"               403 "$T_VIP_AGENT"    "$BODY_T4"
run "D6 vip+agent risky, with approval"             200 "$T_VIP_APPROVED" "$BODY_T4"

echo ""
echo "Result: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ] || exit 1
