#!/bin/bash
# =============================================================================
# teardown-workforce-portal.sh
# Tears down Workforce Portal by deleting its namespace
# =============================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=../../../acp-platform/scripts/lib/config.sh
source "${SCRIPT_DIR}/../../../acp-platform/scripts/lib/config.sh"

NAMESPACE="acp-workforce-portal"

echo "=== Tearing Down Workforce Portal ==="

if ! kubectl --context "${ACP_CONTEXT}" get namespace "${NAMESPACE}" &>/dev/null; then
    echo "  Namespace '${NAMESPACE}' does not exist. Nothing to do."
    exit 0
fi

echo "  Deleting namespace '${NAMESPACE}'..."
kubectl --context "${ACP_CONTEXT}" delete namespace "${NAMESPACE}"
echo -e "  \033[0;32m✓ Workforce Portal removed\033[0m"
