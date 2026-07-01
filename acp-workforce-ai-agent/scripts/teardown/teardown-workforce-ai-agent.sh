#!/bin/bash
# =============================================================================
# teardown-workforce-ai-agent.sh
# Tears down Workforce AI Agent from the shared ai-agents namespace
#
# This project shares the ai-agents namespace with demo workloads created by
# acp-discovery-agent. Only the kustomize-managed resources are removed;
# the namespace itself is NOT deleted.
# =============================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=../../../acp-platform/scripts/lib/config.sh
source "${SCRIPT_DIR}/../../../acp-platform/scripts/lib/config.sh"

PROJECT_DIR="$(cd "${SCRIPT_DIR}/../.." && pwd)"

echo "=== Tearing Down Workforce AI Agent ==="

if ! kubectl --context "${ACP_CONTEXT}" get namespace ai-agents &>/dev/null; then
    echo "  Namespace 'ai-agents' does not exist. Nothing to do."
    exit 0
fi

echo "  Deleting kustomize resources..."
kubectl --context "${ACP_CONTEXT}" delete -k "${PROJECT_DIR}/deploy/" --ignore-not-found
echo -e "  \033[0;32m✓ Workforce AI Agent removed\033[0m"
