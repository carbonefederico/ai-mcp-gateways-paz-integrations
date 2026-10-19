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
    # A freshly imported branch inherits SYSTEM's head; its tip is a working
    # copy that stays UNCOMMITTED forever. The first commit moves the
    # branch's `head` off SYSTEM's — that is the committed discriminator.
    heads=$(curl -sk --max-time 5 \
        -H "X-XSRF-HEADER: ping" -H "x-user-id: administrator" \
        -u "administrator:${PAP_SHARED_SECRET}" \
        "${PAP_BASE_URL}/api/version-control/branches" 2>/dev/null | \
        jq -r '[.data[]? | select(.name == $b or .name == "SYSTEM") | .head] | @tsv' --arg b "${PDP_BRANCH}" 2>/dev/null)
    branchHead=${heads%%$'\t'*}
    systemHead=${heads##*$'\t'}
    if test -n "${branchHead}" && test "${branchHead}" != "null" && test "${branchHead}" != "${systemHead}"; then
        echo "PAP branch ${PDP_BRANCH} is committed (head ${branchHead}) - starting server"
        break
    fi
    echo "PAP branch ${PDP_BRANCH} not committed yet - waiting 5s"
    sleep 5
done
