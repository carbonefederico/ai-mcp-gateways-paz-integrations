#!/usr/bin/env sh
# Overrides the stock 50-before-post-start.sh. PAZ's PDP (pdp-mode external)
# resolves the PAP branch ONCE at server start: on a from-scratch stack boot,
# PAZ starts while PAP is still importing/committing the snapshot, and the PDP
# locks in snapshotId="" (an empty package — every decision NOT_APPLICABLE,
# all permits fail, all denies pass vacuously). PAZ restarts do not re-resolve;
# only a PAZ rebuild after PAP has committed fixes it.
#
# This hook waits for the PAP's status endpoint AND for every branch the PDP
# is pinned to (external server `branch:` property) to be present and
# COMMITTED before the server starts. Read over the in-cluster PAP service
# with the PAP admin password as the shared secret (the same credential PAZ
# already uses for PDP calls, see 30-pap-pdp.dsconfig).
#
test "${VERBOSE}" = "true" && set -x

# shellcheck source=./pingcommon.lib.sh
. "${HOOKS_DIR}/pingcommon.lib.sh"

PAP_BASE_URL="https://agentgateway-stack-pingauthorizepap:8443"
PAP_SHARED_SECRET="2FederateM0re"
PDP_BRANCH="AgentGatewayPortfolioMCP"

echo "Waiting for PAP to expose committed branch ${PDP_BRANCH}..."
while true; do
    branchState=$(curl -sk --max-time 5 \
        -H "X-XSRF-HEADER: ping" -H "x-user-id: administrator" \
        -u "administrator:${PAP_SHARED_SECRET}" \
        "${PAP_BASE_URL}/api/version-control/branches" 2>/dev/null | \
        jq -r --arg b "${PDP_BRANCH}" '.data[]? | select(.name == $b) | .tip.state' 2>/dev/null)
    if test "${branchState}" = "COMMITTED"; then
        echo "PAP branch ${PDP_BRANCH} is committed - starting server"
        break
    fi
    echo "PAP branch ${PDP_BRANCH} not committed yet (state=${branchState:-unreachable}) - waiting 5s"
    sleep 5
done
