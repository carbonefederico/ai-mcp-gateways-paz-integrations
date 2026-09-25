#!/bin/bash
# policy-e2e-tests.sh — End-to-end policy tests for the mortgage MCP demo.
#
# Runs the full production chain:
#   client -> APIM (sideband fragment) -> PingAuthorize -> PAP policy branch -> backend
#
# Tokens are minted on the fly by jwt-lab (https://jwt-lab-beta.vercel.app).
# No presets are used — claims are sent explicitly so each scenario is
# self-documenting.
#
# Usage:
#   ./policy-e2e-tests.sh              # run the full matrix
#
# Requirements: curl, jq
# Environment overrides: APIM_URL, JWT_LAB, AUD (see below).

set -u

APIM_URL="${APIM_URL:-https://apimid4ai.azure-api.net/mortgage-mcp/mcp/mortgage}"
JWT_LAB="${JWT_LAB:-https://jwt-lab-beta.vercel.app/api/token}"
AUD="${AUD:-https://apimid4ai.azure-api.net}"

command -v jq >/dev/null 2>&1 || { echo "jq is required (brew install jq)"; exit 2; }

mint() {
  # mint <claims-json> <ttl-seconds> -> prints access token
  curl -sk --max-time 20 -X POST "$JWT_LAB" \
    -H "content-type: application/json" \
    -d "{\"claims\":$1,\"expiresIn\":$2}" | jq -r '.access_token'
}

# summarize <http-body>: pull one human-readable line out of an MCP response
# (plain JSON or SSE "event:/data:" frames).
summarize() {
  # strip the trailing status line curl appends, keep the last data: payload
  local payload
  payload=$(grep -E '^data: ' <<< "$1" | tail -n1 | sed 's/^data: //')
  [ -z "$payload" ] && payload="$1"

  local kind
  kind=$(jq -r 'if .error then "error" elif .result.tools then "tools" elif .result then "result" else "other" end' <<< "$payload" 2>/dev/null)
  case "$kind" in
    error)
      printf 'JSON-RPC error %s: %s' \
        "$(jq -r '.error.code' <<< "$payload")" \
        "$(jq -r '.error.message' <<< "$payload")"
      ;;
    tools)
      printf 'tools/list OK (%s tools)' "$(jq -r '.result.tools | length' <<< "$payload")"
      ;;
    result)
      printf 'tool result: %s' \
        "$(jq -r '.result.content[0].text' <<< "$payload" | head -1 | head -c 120)"
      ;;
    *)
      head -c 120 <<< "$1"
      ;;
  esac
}

call_mcp() {
  # call_mcp <label> <token> <body> — one call with a readable summary line.
  local label="$1" token="$2" body="$3"
  local resp
  resp=$(curl -sk --max-time 40 -X POST "$APIM_URL" \
    -H "Content-Type: application/json" \
    -H "Accept: application/json, text/event-stream" \
    -H "Authorization: Bearer $token" \
    -d "$body" -w $'\n%{http_code}' 2>&1)
  local code summary
  code=$(tail -n1 <<< "$resp")
  summary=$(summarize "$(sed '$d' <<< "$resp")")
  printf '[%s] HTTP %s | %s\n' "$label" "$code" "$summary"
}

# ---------------------------------------------------------------- tokens ---
echo "Minting scenario tokens (jwt-lab)..."
T_READ=$(mint '{"sub":"alice","client_id":"desktop-client","aud":"'$AUD'","scope":"mortgage:read"}' 1800)
T_WRITE=$(mint '{"sub":"alice","client_id":"desktop-client","aud":"'$AUD'","scope":"mortgage:read mortgage:write"}' 1800)
T_APPROVED=$(mint '{"sub":"alice","client_id":"desktop-client","aud":"'$AUD'","scope":"mortgage:read mortgage:write","approved_for":"submit_mortgage_change_request","tctx":{"tool":"submit_mortgage_change_request","changeType":"TERM_CHANGE","mortgageId":"MORT-90001"}}' 900)
T_EXPIRED=$(mint '{"sub":"alice","aud":"'$AUD'","scope":"mortgage:read"}' -300)
T_WRITE_ONLY=$(mint '{"sub":"alice","aud":"'$AUD'","scope":"mortgage:write"}' 900)

T_VIP_AGENT=$(mint '{"sub":"vip_user","sub_type":"vip_user","client_id":"support-portal","aud":"'$AUD'","scope":"mortgage:read mortgage:write","act":{"sub":"customer_support_agent"}}' 1800)
T_STD_AGENT=$(mint '{"sub":"standard_user","sub_type":"standard","client_id":"support-portal","aud":"'$AUD'","scope":"mortgage:read mortgage:write","act":{"sub":"customer_support_agent"}}' 1800)
T_VIP_DIRECT=$(mint '{"sub":"vip_user","sub_type":"vip_user","client_id":"support-portal","aud":"'$AUD'","scope":"mortgage:read mortgage:write"}' 1800)
T_VIP_APPROVED=$(mint '{"sub":"vip_user","sub_type":"vip_user","client_id":"support-portal","aud":"'$AUD'","scope":"mortgage:read mortgage:write","act":{"sub":"customer_support_agent"},"approved_for":"submit_mortgage_change_request","tctx":{"tool":"submit_mortgage_change_request","changeType":"TERM_CHANGE","mortgageId":"MORT-90001"}}' 1800)

# ---------------------------------------------------------------- tests ---
PASS=0; FAIL=0
report() { # report <label> <expected-code> <actual-code>
  local mark="FAIL"
  if [ "$3" = "$2" ]; then mark="PASS"; PASS=$((PASS+1)); else FAIL=$((FAIL+1)); fi
  printf '  %-4s %-46s (expected %s)\n' "$mark" "$1" "$2"
}

run() { # run <label> <expect-code> <token> <body>
  # Retries on 502: APIM->PAZ sideband occasionally trips on a cold
  # connection (fragment returns "sideband-unavailable"); a retry proves the
  # outcome is policy-driven, not transport noise.
  local out attempt
  for attempt in 1 2 3; do
    out=$(curl -sk --max-time 40 -X POST "$APIM_URL" \
      -H "Content-Type: application/json" \
      -H "Accept: application/json, text/event-stream" \
      -H "Authorization: Bearer $3" \
      -d "$4" -o /dev/null -w '%{http_code}' 2>&1)
    [ "$out" != "502" ] && break
  done
  report "$1" "$2" "$out"
}

BODY_T2='{"jsonrpc":"2.0","method":"tools/call","id":2,"params":{"name":"get_mortgage_summary","arguments":{"customerId":"CUST-10001"}}}'
BODY_T3='{"jsonrpc":"2.0","method":"tools/call","id":3,"params":{"name":"submit_mortgage_change_request","arguments":{"mortgageId":"MORT-90001","changeType":"PAYMENT_DATE","requestedValue":"2026-10-01","confirmedByUser":true,"reason":"Move payment date"}}}'
BODY_T4='{"jsonrpc":"2.0","method":"tools/call","id":4,"params":{"name":"submit_mortgage_change_request","arguments":{"mortgageId":"MORT-90001","changeType":"TERM_CHANGE","requestedValue":"30 years","confirmedByUser":true,"reason":"Extend term"}}}'
BODY_T6='{"jsonrpc":"2.0","method":"tools/call","id":6,"params":{"name":"delete_mortgage","arguments":{"mortgageId":"MORT-90001"}}}'

echo ""
echo "--- Core policy matrix ---"
run "T1 tools/list (session, mortgage:read)"        200 "$T_READ"       '{"jsonrpc":"2.0","method":"tools/list","id":1}'
run "T2 read tool with mortgage:read"               200 "$T_READ"       "$BODY_T2"
run "T3 benign PAYMENT_DATE with mortgage:write"    200 "$T_WRITE"      "$BODY_T3"
run "T4 risky TERM_CHANGE without approval"         403 "$T_WRITE"      "$BODY_T4"
run "T5 risky TERM_CHANGE with approval"            200 "$T_APPROVED"   "$BODY_T4"
run "T6 unknown tool (default deny)"                403 "$T_READ"       "$BODY_T6"
run "T8 read tool with write-only scope"            403 "$T_WRITE_ONLY" "$BODY_T2"
run "T9 expired token"                              401 "$T_EXPIRED"    '{"jsonrpc":"2.0","method":"tools/list","id":9}'

echo ""
echo "--- Delegation (RFC 8693 act.sub / sub_type) ---"
run "D1 vip_user + customer_support_agent read"     200 "$T_VIP_AGENT"    "$BODY_T2"
run "D2 standard_user + same agent (gate deny)"     403 "$T_STD_AGENT"    "$BODY_T2"
run "D3 vip_user direct, no agent"                  200 "$T_VIP_DIRECT"   "$BODY_T2"
run "D4 vip+agent benign change"                    200 "$T_VIP_AGENT"    "$BODY_T3"
run "D5 vip+agent risky, no approval"               403 "$T_VIP_AGENT"    "$BODY_T4"
run "D6 vip+agent risky, with approval"             200 "$T_VIP_APPROVED" "$BODY_T4"

echo ""
echo "Result: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ] || exit 1
