#!/bin/bash
#===============================================================================
# 00-deploy-workforce-portal.sh — Deploy Workforce Portal to k3d Cluster
#===============================================================================
#
# EXECUTION ORDER:
#   Run AFTER: acp-platform/scripts/setup/02-create-cluster.sh
#   Run BEFORE: none
#
# WHAT THIS SCRIPT DOES:
#   1. Renders the host-aliases patch template (.localhost -> Traefik ClusterIP,
#      plus a per-deploy timestamp annotation that forces a :latest re-pull) into
#      a generated, gitignored host-aliases-patch-resolved.yaml.
#   2. Applies kustomize manifests in a single apply -k. kustomization.yaml
#      references the generated patch under `patches:`, so hostAliases are baked
#      into the deployment on creation — one rollout, no post-apply patch and no
#      separate rollout restart.
#   3. Waits for the Workforce Portal pod to be ready
#   4. Verifies the portal is reachable via ingress
#
# PREREQUISITES:
#   - Image built: make build-images
#
# USAGE:
#   ./scripts/deploy/00-deploy-workforce-portal.sh [--help]
#
# ENVIRONMENT VARIABLES:
#   Tag legend: [platform]  defined in acp-platform/scripts/lib/config.sh
#
#   ACP_CONTEXT  [platform]  kubectl context (default: k3d-local-cluster)
#
#===============================================================================
set -euo pipefail

if [[ "${1:-}" == "--help" || "${1:-}" == "-h" ]]; then
    sed -n '2,/^$/p' "$0" | sed 's/^# \{0,1\}//'
    exit 0
fi

NAMESPACE="acp-workforce-portal"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "${SCRIPT_DIR}/../.." && pwd)"
LIB_DIR="$(cd "${SCRIPT_DIR}/../../../acp-platform/scripts/lib" && pwd)"

source "${LIB_DIR}/config.sh"
# shellcheck source=../../../acp-platform/scripts/lib/deploy.sh
source "${LIB_DIR}/deploy.sh"


print_banner "Workforce Portal — Deploy"
echo "  Context: ${ACP_CONTEXT}"
echo ""

echo "Step 1: Rendering host aliases patch (.localhost -> Traefik)..."
render_host_aliases \
    "${PROJECT_DIR}/deploy/host-aliases-patch.yaml" \
    "${PROJECT_DIR}/deploy/host-aliases-patch-resolved.yaml"

echo ""
echo "Step 2: Applying kustomize manifests (hostAliases baked in)..."
kubectl --context "${ACP_CONTEXT}" apply -k "${PROJECT_DIR}/deploy/"
echo "  ✓ Manifests applied"

echo ""
echo "Step 3: Waiting for Workforce Portal pod to be ready..."
kubectl --context "${ACP_CONTEXT}" -n "${NAMESPACE}" rollout status deployment/acp-workforce-portal --timeout=120s
echo "  ✓ Pod is ready"

echo ""
echo "Step 4: Verifying portal..."
wait_for_http "https://portal-internal.localhost/" 20 || \
  echo "  Check logs: kubectl logs -n ${NAMESPACE} deployment/acp-workforce-portal"

echo ""
echo "  ✓ Workforce Portal deployed"
echo "  URLs:"
echo "    Portal:            https://portal-external.localhost/workforce-portal"
echo "    Authenticator App: https://portal-external.localhost/authenticator-app/"
echo ""
echo "  Test login:"
echo "    1. Open https://portal-external.localhost/workforce-portal"
echo "    2. Click 'Sign In'"
echo "    3. Enter: alice@acme.com / Demo123!"
