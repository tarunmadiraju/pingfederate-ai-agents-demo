.PHONY: setup deploy status logs clean verify test-unit test-integration test-e2e

# Default target
.DEFAULT_GOAL := help

# Colors for output
BLUE := \033[0;34m
GREEN := \033[0;32m
RED := \033[0;31m
NC := \033[0m # No Color

help:
	@echo "$(BLUE)Ping AI Agents Demo — Makefile$(NC)"
	@echo ""
	@echo "Deployment Commands:"
	@echo "  $(GREEN)make setup$(NC)              Initialize k3d cluster and deploy all services"
	@echo "  $(GREEN)make deploy$(NC)             Deploy services to existing cluster"
	@echo "  $(GREEN)make status$(NC)             Check deployment status"
	@echo "  $(GREEN)make logs$(NC)               View logs from all services"
	@echo "  $(GREEN)make clean$(NC)              Remove k3d cluster and cleanup"
	@echo ""
	@echo "Development Commands:"
	@echo "  $(GREEN)make local-dev$(NC)          Start services with docker-compose (local dev)"
	@echo "  $(GREEN)make verify$(NC)             Verify deployment is healthy"
	@echo "  $(GREEN)make build-agents$(NC)       Build all agent Docker images"
	@echo "  $(GREEN)make push-agents$(NC)        Push agent images to registry"
	@echo ""
	@echo "Testing:"
	@echo "  $(GREEN)make test-unit$(NC)          Run unit tests"
	@echo "  $(GREEN)make test-integration$(NC)   Run integration tests"
	@echo "  $(GREEN)make test-e2e$(NC)           Run end-to-end tests"
	@echo ""

setup:
	@echo "$(BLUE)Setting up k3d cluster...$(NC)"
	bash scripts/setup.sh
	@echo "$(GREEN)✅ Setup complete!$(NC)"
	@echo "Portal: https://portal-external.localhost/workforce-portal"

deploy:
	@echo "$(BLUE)Deploying to Kubernetes...$(NC)"
	bash scripts/deploy.sh
	@echo "$(GREEN)✅ Deployment complete!$(NC)"

status:
	@echo "$(BLUE)Deployment Status$(NC)"
	@echo ""
	@echo "$(BLUE)Namespaces:$(NC)"
	kubectl get namespaces | grep -E "ai-agents|default|pingfederate" || echo "  No namespaces found"
	@echo ""
	@echo "$(BLUE)Deployments (ai-agents namespace):$(NC)"
	kubectl -n ai-agents get deployments || echo "  Namespace not found"
	@echo ""
	@echo "$(BLUE)Pods (ai-agents namespace):$(NC)"
	kubectl -n ai-agents get pods || echo "  No pods"
	@echo ""
	@echo "$(BLUE)Pods (default namespace - gateway):$(NC)"
	kubectl -n default get pods -l app=acp-gateway || echo "  No gateway pods"
	@echo ""
	@echo "$(BLUE)Services (ai-agents namespace):$(NC)"
	kubectl -n ai-agents get svc || echo "  No services"

logs:
	@echo "$(BLUE)Tailing logs from all services...$(NC)"
	@echo "  Ctrl+C to stop"
	kubectl -n ai-agents logs -f deployment/acp-trip-planner-agent --tail=50 &
	kubectl -n ai-agents logs -f deployment/acp-workforce-ai-agent --tail=50 &
	kubectl -n ai-agents logs -f deployment/acp-workforce-portal --tail=50 &
	wait

clean:
	@echo "$(RED)Cleaning up...$(NC)"
	bash scripts/clean.sh
	@echo "$(GREEN)✅ Cleanup complete!$(NC)"

local-dev:
	@echo "$(BLUE)Starting services with docker-compose...$(NC)"
	docker-compose up -d
	@echo "$(GREEN)✅ Services running!$(NC)"
	@echo "  Portal: http://localhost:3000"

verify:
	@echo "$(BLUE)Verifying deployment...$(NC)"
	bash scripts/verify.sh

build-agents:
	@echo "$(BLUE)Building agent Docker images...$(NC)"
	docker build -t k3d-registry.localhost:5001/acp-trip-planner-agent:latest acp-trip-planner-agent
	docker build -t k3d-registry.localhost:5001/acp-workforce-ai-agent:latest acp-workforce-ai-agent
	docker build -t k3d-registry.localhost:5001/acp-workforce-portal:latest acp-workforce-portal
	@echo "$(GREEN)✅ Images built!$(NC)"

push-agents: build-agents
	@echo "$(BLUE)Pushing images to registry...$(NC)"
	docker push k3d-registry.localhost:5001/acp-trip-planner-agent:latest
	docker push k3d-registry.localhost:5001/acp-workforce-ai-agent:latest
	docker push k3d-registry.localhost:5001/acp-workforce-portal:latest
	@echo "$(GREEN)✅ Images pushed!$(NC)"

test-unit:
	@echo "$(BLUE)Running unit tests...$(NC)"
	# Add your test commands here
	@echo "$(GREEN)✅ Tests complete!$(NC)"

test-integration:
	@echo "$(BLUE)Running integration tests...$(NC)"
	# Requires deployment
	bash scripts/test-integration.sh
	@echo "$(GREEN)✅ Integration tests complete!$(NC)"

test-e2e:
	@echo "$(BLUE)Running end-to-end tests...$(NC)"
	bash scripts/test-e2e.sh
	@echo "$(GREEN)✅ E2E tests complete!$(NC)"
