#!/bin/bash
set -e

echo "🚀 Setting up Ping AI Agents Demo"
echo "================================="
echo ""

# Check for required tools
echo "Checking for required tools..."
for cmd in docker kubectl k3d kustomize; do
    if ! command -v $cmd &> /dev/null; then
        echo "❌ $cmd not found. Please install it."
        exit 1
    fi
done
echo "✅ All tools found"
echo ""

# Check for Ping credentials
if [ -z "$PING_IDENTITY_DEVOPS_USER" ] || [ -z "$PING_IDENTITY_DEVOPS_KEY" ]; then
    echo "❌ Missing Ping credentials"
    echo "   Set: export PING_IDENTITY_DEVOPS_USER=your-email@pingidentity.com"
    echo "   Set: export PING_IDENTITY_DEVOPS_KEY=your-devops-key"
    exit 1
fi
echo "✅ Ping credentials found"
echo ""

# Create k3d cluster if it doesn't exist
CLUSTER_NAME=${CLUSTER_NAME:-k3d-local-cluster}
if ! k3d cluster list | grep -q $CLUSTER_NAME; then
    echo "📦 Creating k3d cluster: $CLUSTER_NAME"
    k3d cluster create $CLUSTER_NAME \
        --servers 1 \
        --agents 2 \
        --port 443:443@loadbalancer \
        --port 80:80@loadbalancer \
        --registry-create k3d-registry:5001
    echo "✅ Cluster created"
else
    echo "ℹ️  Cluster already exists"
fi
echo ""

# Get cluster kubeconfig
echo "📝 Configuring kubectl..."
k3d kubeconfig get $CLUSTER_NAME > /tmp/k3d-kubeconfig.yaml
export KUBECONFIG=/tmp/k3d-kubeconfig.yaml
echo "✅ kubectl configured"
echo ""

# Create namespaces
echo "📦 Creating Kubernetes namespaces..."
kubectl apply -f - <<EOF
apiVersion: v1
kind: Namespace
metadata:
  name: ai-agents
---
apiVersion: v1
kind: Namespace
metadata:
  name: pingfederate
---
apiVersion: v1
kind: Namespace
metadata:
  name: gateway
EOF
echo "✅ Namespaces created"
echo ""

# Deploy using kustomize
echo "🚀 Deploying services with kustomize..."
kubectl apply -k kubernetes/base
echo "✅ Services deployed"
echo ""

# Wait for rollout
echo "⏳ Waiting for deployments to be ready (this may take 2-3 minutes)..."
kubectl rollout status deployment/acp-workforce-portal -n ai-agents --timeout=300s || true
kubectl rollout status deployment/acp-trip-planner-agent -n ai-agents --timeout=300s || true
kubectl rollout status deployment/acp-workforce-ai-agent -n ai-agents --timeout=300s || true
echo "✅ Deployments ready"
echo ""

# Print connection info
echo "================================="
echo "🎉 Setup Complete!"
echo "================================="
echo ""
echo "📱 Portal Access:"
echo "   https://portal-external.localhost/workforce-portal"
echo ""
echo "👤 Test Credentials:"
echo "   Username: alice@company.com"
echo "   Password: (configured in PingFederate)"
echo ""
echo "📊 Check Status:"
echo "   make status"
echo ""
echo "📋 View Logs:"
echo "   make logs"
echo ""
echo "✨ Next Steps:"
echo "   1. Open https://portal-external.localhost/workforce-portal"
echo "   2. Login with test credentials"
echo "   3. Select agent from dropdown"
echo "   4. Send a query (e.g., 'Show my expenses' or 'Plan a trip to Paris')"
echo "   5. Open DevTools Network tab to see token exchanges"
echo ""
echo "📖 Learn More:"
echo "   - Read DEMO_NARRATIVE.md for CTO presentation"
echo "   - Read DEMO_QUICK_REFERENCE.md for demo talking points"
echo "   - Read MCP_TOOLS_REFERENCE.md for tool details"
echo ""
