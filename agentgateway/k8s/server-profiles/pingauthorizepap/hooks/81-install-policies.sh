#!/usr/bin/env sh
# Overrides the stock 81-install-policies.sh (same filename = same slot in
# ${STAGING_DIR}/hooks; the profile merge in hook 02 wins). Stock behavior
# imports each staged *.SNAPSHOT under its FILENAME INCLUDING the .SNAPSHOT
# extension and never commits — the PDP serves only COMMITTED snapshots, so a
# stock boot leaves the branch misnamed AND invisible to PAZ. This version:
#
#   1. names the branch after the file WITHOUT the .SNAPSHOT extension
#      (AgentGatewayPortfolioMCP.SNAPSHOT -> branch AgentGatewayPortfolioMCP,
#      the name PAZ's external server `branch:` property points at), and
#   2. COMMITS the imported working copy so the PDP can serve it.
#
# Restart-safe: imports ALWAYS create a branch (409 when the name is taken),
# so on a restart the import is skipped once the branch exists and is
# committed; a missing/uncommitted branch is a hard failure.
#
test "${VERBOSE}" = "true" && set -x

# shellcheck source=../../../../pingcommon/opt/staging/hooks/pingcommon.lib.sh
. "${HOOKS_DIR}/pingcommon.lib.sh"

PAP_ADMIN=${PAP_ADMIN:-admin}

echo "Checking PingAuthorize Policy Editor system status..."
while true; do
    status=$(curl -H "x-user-id: ${PAP_ADMIN}" -k "https://localhost:${HTTPS_PORT}/api/system/status" 2> /dev/null | jq -r '.status')
    if test "${status}" = "RUNNING"; then
        echo "PingAuthorize Policy Editor is ready"
        break
    else
        echo "PingAuthorize Policy Editor is not ready, waiting to try again..."
        sleep 3
    fi
done

branchesUrl="https://localhost:${HTTPS_PORT}/api/version-control/branches"

if test -d "${STAGING_DIR}/policies"; then
    for policyFileName in $(find "${STAGING_DIR}/policies/" -iname \*.SNAPSHOT 2> /dev/null | sort | uniq); do
        policyName=$(basename "${policyFileName}")
        branchName="${policyName%.SNAPSHOT}"
        # A freshly imported branch inherits SYSTEM's head; its tip is a
        # working copy that stays UNCOMMITTED forever. The first commit moves
        # the branch's `head` off SYSTEM's — that is the committed check.
        heads=$(curl -H "x-user-id: ${PAP_ADMIN}" -k "${branchesUrl}" 2>/dev/null | \
            jq -r '[.data[]? | select(.name == $b or .name == "SYSTEM") | .head] | @tsv' --arg b "${branchName}" 2>/dev/null)
        branchHead=${heads%%$'\t'*}
        systemHead=${heads##*$'\t'}

        if test -n "${branchHead}" && test "${branchHead}" != "null" && test "${branchHead}" != "${systemHead}"; then
            echo "Branch ${branchName} already committed - nothing to do"
            continue
        fi

        if test -n "${branchHead}" && test "${branchHead}" != "null"; then
            container_failure "81" "Branch '${branchName}' exists uncommitted (head=${branchHead})"
        fi

        echo "Importing policy snapshot: ${policyName} -> branch ${branchName}"
        snapshotId=$(curl -H "x-user-id: ${PAP_ADMIN}" -H 'Content-Type: application/json' -k --data-binary @"${policyFileName}" "https://localhost:${HTTPS_PORT}/api/snapshot/${branchName}/import" | jq -r '.id')

        if test "${snapshotId}" = null; then
            container_failure "81" "Policy '${policyName}' could not be imported as branch '${branchName}'"
        fi

        echo "Created Snapshot ID: ${snapshotId} - committing"
        commitHead=$(curl -H "x-user-id: ${PAP_ADMIN}" -H 'Content-Type: application/json' -k \
            --data-binary '{"message":"bootstrap: import '"${branchName}"'"}' \
            "https://localhost:${HTTPS_PORT}/api/version-control/branches/${snapshotId}/commit" | jq -r '.head // .id')

        if test -z "${commitHead}" || test "${commitHead}" = "null"; then
            container_failure "81" "Branch '${branchName}' could not be committed"
        fi
        echo "Branch ${branchName} committed (head ${commitHead})"
    done
fi
