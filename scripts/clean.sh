#!/bin/bash

echo "🧹 Cleaning up..."

# Delete k3d cluster
CLUSTER_NAME=${CLUSTER_NAME:-k3d-local-cluster}
if k3d cluster list | grep -q $CLUSTER_NAME; then
    echo "Deleting k3d cluster: $CLUSTER_NAME"
    k3d cluster delete $CLUSTER_NAME
    echo "✅ Cluster deleted"
fi

# Clean Docker
echo "Cleaning Docker images..."
docker image prune -f --filter "dangling=true"

echo "✅ Cleanup complete"
