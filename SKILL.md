---
name: "ping-ai-agents-demo"
description: "Deploy Ping Identity AI agents demo with enterprise security - authentication, authorization, token exchange"
version: "1.0.0"
author: "Ping Identity"
applies_to: "devops,ai-agents,kubernetes,identity"
---

# Ping AI Agents Demo — Deployment & Extension Skill

## Overview

This skill enables AI tools to deploy, debug, and extend the **Ping AI Agents Demo** — a reference implementation showing how Ping Identity secures AI agents with enterprise-grade identity, authorization, and token exchange (RFC 8693).

When users ask to deploy this demo, modify agents, add new tools, or troubleshoot issues, the AI tool should use this skill to:
1. Understand the repo structure
2. Deploy services to Kubernetes
3. Add new agents or MCP tools
4. Fix common issues
5. Run tests and validation

---

## Repo Structure

```
ping-ai-agents-demo/
├── README.md                          # Main documentation
├── SKILL.md                           # This file (AI tool guidance)
├── DEMO_NARRATIVE.md                  # CTO presentation narrative
├── DEMO_QUICK_REFERENCE.md            # 1-page demo cheat sheet
├── MCP_TOOLS_REFERENCE.md             # Tool ecosystem docs
├── ARCHITECTURE.md                    # Technical deep-dive
├── DEPLOYMENT.md                      # Production deployment guide
├── Makefile                           # Build & deploy automation
├── docker-compose.yml                 # Local dev setup
├── .env.example                       # Environment variables template
│
├── kubernetes/                        # Kubernetes manifests
│   ├── kustomization.yaml
│   ├── base/                          # Base manifests
│   │   ├── namespace.yaml
│   │   ├── services/
│   │   ├── deployments/
│   │   └── ingress/
│   ├── overlays/                      # Environment overlays (dev/prod)
│   │   ├── dev/
│   │   └── prod/
│   └── policies/                      # PingAuthorize policies
│
├── acp-workforce-portal/              # Portal frontend + backend
│   ├── package.json
│   ├── server.js                      # Express backend
│   ├── js/
│   │   ├── config.js                  # Agent endpoint configuration (FIXED)
│   │   └── agentClient.js             # Token exchange logic (FIXED)
│   └── public/
│       └── index.html                 # Vue.js frontend
│
├── acp-workforce-ai-agent/            # Workforce Agent (Node.js)
│   ├── package.json
│   ├── src/
│   │   └── router.js
│   └── Dockerfile
│
├── acp-trip-planner-agent/            # Trip Planner Agent (Python)
│   ├── pyproject.toml
│   ├── src/
│   │   ├── router.py                  # FIXED: LLM fallback for empty registry
│   │   ├── llm_router.py              # FIXED: Added generate_travel_response()
│   │   └── discovery.py               # A2A agent discovery
│   ├── Dockerfile
│   └── requirements.txt
│
├── mcp-servers/                       # MCP Tool implementations
│   ├── expense-mcp/                   # Expense tool
│   ├── travel-mcp/                    # Travel tool
│   └── finance-mcp/                   # Finance tool
│
└── scripts/                           # Deployment & utility scripts
    ├── setup.sh                       # Initial setup
    ├── deploy.sh                      # Deploy to k3d
    ├── verify.sh                      # Verify deployment
    └── troubleshoot.sh                # Debugging helpers
```

---

## Key Components to Know

### 1. Portal (acp-workforce-portal)
- **Tech**: Express.js backend + Vue.js frontend
- **Role**: User entry point, OIDC session management
- **Port**: 3000 (dev), exposed via PingAccess (prod)
- **Key File**: `js/config.js` - Defines agent endpoints
  - **FIXED**: Corrected endpoint paths from `/api/trip-planner/agent/run` → `/api/trip-planner/run`

### 2. Workforce Agent (acp-workforce-ai-agent)
- **Tech**: Node.js Express + AG-UI protocol
- **Role**: Handles expense & financial queries
- **Port**: 3001
- **Tools**: Expense MCP, Finance MCP
- **Auth**: Validates scoped tokens with aud=workforce-ai-agent

### 3. Trip Planner Agent (acp-trip-planner-agent)
- **Tech**: Python (AG-UI) + Ollama LLM
- **Role**: Handles travel planning queries
- **Port**: 8080
- **Tools**: Travel MCP (flights, hotels, weather)
- **Auth**: Validates scoped tokens with aud=trip-planner-agent
- **KEY FIXES APPLIED**:
  - `router.py` lines ~649-682: Added fallback handler for empty A2A registry
  - `llm_router.py` end-of-file: Added `generate_travel_response()` function
  - When A2A registry is empty, agent generates responses via LLM instead of failing

### 4. PingGateway
- **Role**: API gateway + RFC 8693 token exchange
- **Function**: Validates bearer tokens, exchanges user token for agent-scoped token
- **Key Feature**: Token exchange limits privileges per agent

### 5. MCP Tools
- **Expense MCP**: Returns user expenses (data-level authz enforced)
- **Travel MCP**: Searches flights, hotels, weather
- **Finance MCP**: Budget, revenue data

---

## Common AI Assistant Tasks

### Task: Deploy the demo to k3d

```bash
# 1. Clone repo
git clone <repo-url>
cd ping-ai-agents-demo

# 2. Set credentials
export PING_IDENTITY_DEVOPS_USER=your-email@pingidentity.com
export PING_IDENTITY_DEVOPS_KEY=your-devops-key

# 3. Deploy
make setup

# 4. Verify
make status
```

**What happens**:
- k3d cluster created
- All manifests deployed via kustomize
- PingFederate, PingAccess, PingGateway started
- Portal, agents, MCP tools deployed
- Ingress configured for portal access

---

### Task: Add a new agent (e.g., "Expense Manager")

1. **Create agent directory** under repo root:
   ```
   mkdir -p acp-expense-manager-agent
   cp -r acp-trip-planner-agent/* acp-expense-manager-agent/
   ```

2. **Update Dockerfile image name**:
   ```dockerfile
   # In acp-expense-manager-agent/Dockerfile
   RUN ... pip install -r requirements.txt
   # Change workdir name to expense-manager-agent
   ```

3. **Update src/router.py**:
   - Change agent identity: `aud="expense-manager-agent"`
   - Update tool set: Register only Expense MCP tools
   - Change LLM system prompt for expense domain

4. **Create Kubernetes manifest**:
   ```yaml
   # kubernetes/base/deployments/expense-manager-agent.yaml
   apiVersion: apps/v1
   kind: Deployment
   metadata:
     name: acp-expense-manager-agent
     namespace: ai-agents
   spec:
     replicas: 1
     template:
       spec:
         containers:
         - name: agent
           image: k3d-registry.localhost:5001/acp-expense-manager-agent:latest
           ports:
           - containerPort: 8080
           env:
           - name: OLLAMA_BASE_URL
             value: http://host.k3d.internal:11434
   ```

5. **Update kustomization.yaml**:
   ```yaml
   resources:
     - base/deployments/expense-manager-agent.yaml
   ```

6. **Add to portal config** (`acp-workforce-portal/js/config.js`):
   ```javascript
   'expense-manager': {
     label: 'Expense Manager',
     endpoints: {
       health: '/api/expense-manager/health',
       agentRun: '/api/expense-manager/run',
       agentResource: '/api/expense-manager/resource'
     }
   }
   ```

7. **Build & Deploy**:
   ```bash
   docker build -t k3d-registry.localhost:5001/acp-expense-manager-agent:latest ./acp-expense-manager-agent
   docker push k3d-registry.localhost:5001/acp-expense-manager-agent:latest
   make deploy
   ```

---

### Task: Fix "Trip Planner returns 404" error

**Root Cause**: Portal config has wrong endpoint paths

**Solution**:
1. Check `acp-workforce-portal/js/config.js`
2. Find Trip Planner endpoint config:
   ```javascript
   'trip-planner': {
     agentRun: '/api/trip-planner/agent/run'  // ❌ WRONG
   }
   ```
3. Correct to match actual agent route:
   ```javascript
   'trip-planner': {
     agentRun: '/api/trip-planner/run'  // ✅ CORRECT
   }
   ```
4. Rebuild portal:
   ```bash
   docker build -t k3d-registry.localhost:5001/acp-workforce-portal:latest acp-workforce-portal
   docker push k3d-registry.localhost:5001/acp-workforce-portal:latest
   kubectl rollout restart deployment/acp-workforce-portal
   ```

**Why this works**: Portal routes requests through PingAccess, which has prefix `/api/trip-planner/*` routed to the Trip Planner agent. Agent itself expects `/api/trip-planner/run` (not `/api/trip-planner/agent/run`).

---

### Task: Fix "Registry is empty" error for Trip Planner

**Root Cause**: PingIDM (A2A agent discovery service) not deployed, so agent registry is empty

**Solution**: Built-in LLM fallback (already implemented)

**File**: `acp-trip-planner-agent/src/router.py` lines ~649-682

**How it works**:
1. Agent checks if A2A registry has candidates
2. If empty, catches exception
3. Calls `generate_travel_response(user_text)` from `llm_router.py`
4. LLM generates response directly via Ollama
5. Returns travel suggestions instead of error

**Code snippet** (already applied):
```python
elif not candidates:
    # Empty registry — fallback: generate response directly via LLM
    reason = "empty_registry_fallback"
    logger.info("Registry empty, falling back to direct LLM response")
    
    try:
        from src.llm_router import generate_travel_response
        message = await generate_travel_response(user_text)
        yield _custom_event("planner.fallback", {"reason": "registry_empty"})
        for event in _text_events(str(uuid.uuid4()), message):
            yield event
        return
    except Exception as e:
        logger.warning("Fallback failed: %s", e)
```

---

### Task: Verify token exchange is working

**Check**: Open browser DevTools Network tab, send query, look for token exchange call

**What to look for**:
1. POST request to `/token` (token exchange endpoint)
2. Response includes new JWT with `aud=trip-planner-agent`
3. Scoped token passed to agent in Authorization header

**If not working**:
- Check PingGateway logs: `kubectl -n default logs deployment/acp-gateway`
- Verify token exchange filter enabled in gateway config
- Check OIDC discovery endpoint accessible

---

### Task: Run tests

```bash
# Unit tests
make test-unit

# Integration tests (requires deployment)
make test-integration

# Full E2E test
make test-e2e
```

---

## What AI Tools Should Know

### 1. Token Exchange (RFC 8693) is Key
- User logs in, gets broad token from PingFederate
- Portal exchanges it for scoped token via PingGateway
- Scoped token only valid for specific agent + limited actions
- This is **not** Ping invention — NIST standard for OAuth2 delegation
- **Why it matters**: One hacked agent can't compromise other agents

### 2. MCP Tool Invocation Flow
```
LLM sees tool schemas → Decides which tool to call → Invokes via MCP
↓
MCP validates scoped token (aud + signature) → Executes tool → Returns data
↓
LLM synthesizes response → Returns to user
```

### 3. Common Failures & Fixes

| Issue | Cause | Fix |
|-------|-------|-----|
| 404 errors from Trip Planner | Portal config wrong paths | Check `config.js` endpoints |
| "Registry is empty" | PingIDM not deployed | LLM fallback handles this (already in code) |
| Token exchange fails | PingGateway filter disabled | Check gateway config |
| MCP tool returns 403 | Scoped token aud mismatch | Verify token exchange creates correct aud |
| Agent won't start | Ollama not accessible | Check `OLLAMA_BASE_URL` env var |

### 4. Deployment Layers

**Layer 1**: Kubernetes manifests (kustomize)
- **Edit**: `kubernetes/base/` for core changes
- **Deploy**: `make deploy` applies manifests

**Layer 2**: Docker images
- **Rebuild**: `docker build -t ...` for modified agents
- **Push**: `docker push` to k3d registry

**Layer 3**: Configuration
- **Agent identity**: Set in `src/router.py` (aud claim)
- **MCP tools**: Registered in agent config
- **Authorization policies**: `kubernetes/policies/`

---

## Critical Files (AI Tools Should Know These)

### Configuration
- `acp-workforce-portal/js/config.js` — Agent endpoints
- `kubernetes/base/deployments/` — Service definitions
- `.env` — Environment variables

### Agent Code
- `acp-trip-planner-agent/src/router.py` — **FIXED** for fallback
- `acp-trip-planner-agent/src/llm_router.py` — **FIXED** with `generate_travel_response()`
- `acp-workforce-ai-agent/src/router.js` — Workforce agent routing

### Kubernetes
- `kubernetes/base/ingress.yaml` — How portal is exposed
- `kubernetes/base/services/` — Service definitions
- `kubernetes/policies/` — Authorization policies

### Deployment
- `Makefile` — All deployment commands
- `scripts/setup.sh` — Initial setup
- `docker-compose.yml` — Local dev alternative

---

## Environment Variables

Create `.env` file in root with:

```bash
# Ping Credentials (required for Docker images)
PING_IDENTITY_DEVOPS_USER=your-email@pingidentity.com
PING_IDENTITY_DEVOPS_KEY=your-devops-key

# OIDC Config
OIDC_DISCOVERY_URL=https://pingfederate.localhost/oauth/.well-known/openid-configuration
OIDC_CLIENT_ID=portal
OIDC_CLIENT_SECRET=your-secret

# LLM (Ollama)
OLLAMA_BASE_URL=http://host.k3d.internal:11434
OLLAMA_MODEL=llama3.2:1b

# Kubernetes
CLUSTER_NAME=k3d-local-cluster
REGISTRY=k3d-registry.localhost:5001

# PingFederate
PF_ADMIN_USER=Administrator
PF_ADMIN_PASSWORD=your-password

# PingGateway
PG_ADMIN_PASSWORD=your-password
```

---

## Deployment Checklist (For AI Tools)

- [ ] Ping credentials exported as env vars
- [ ] k3d cluster running (`k3d cluster list`)
- [ ] Docker images built
- [ ] Kubernetes manifests validated (`kubectl apply --dry-run`)
- [ ] Deployments healthy (`kubectl get pods`)
- [ ] Portal accessible at https://portal-external.localhost/workforce-portal
- [ ] Can login with test user
- [ ] Can send queries to both agents
- [ ] DevTools shows token exchanges
- [ ] Logs clean (no obvious errors)

---

## Troubleshooting Guide for AI Tools

### Symptom: Pod won't start
```bash
kubectl -n ai-agents describe pod <pod-name>
kubectl -n ai-agents logs <pod-name>
```
Look for: Image pull errors, volume mount issues, env var missing

**Fix**: Update image tag, check credentials, verify volumes

---

### Symptom: Agent returns 500 error
```bash
kubectl -n ai-agents logs deployment/acp-trip-planner-agent
```
Look for: Token validation failures, Ollama connection errors, MCP tool failures

**Fix**: Check scoped token validity, verify Ollama running, check MCP tool logs

---

### Symptom: Token exchange fails
```bash
kubectl -n default logs deployment/acp-gateway
```
Look for: Token validation errors, exchange filter disabled, JWKS fetch failures

**Fix**: Check PingFederate JWKS endpoint, verify exchange filter config

---

### Symptom: Portal can't reach agent
```bash
kubectl -n ai-agents get svc
curl http://acp-trip-planner-agent.ai-agents.svc.cluster.local:8080/health
```

**Fix**: Check service DNS, verify pod IP accessible, check network policy

---

## When to Use This Skill

Use this skill when:
- User asks to deploy the demo
- User wants to add a new agent
- User asks to fix deployment issues
- User wants to modify authorization policies
- User wants to understand the architecture
- User wants to test with different agents

---

## When NOT to Use This Skill

Don't use this skill for:
- General Kubernetes questions (use k8s docs)
- General OAuth2 questions (use RFC 6749/8693)
- Python/Node.js syntax help (use language docs)
- Unrelated Ping products (use product-specific skills)

---

## Key Constraints

1. **Ping credentials required** — Can't pull images without PING_IDENTITY_DEVOPS_USER/KEY
2. **k3d cluster needed** — Deployment requires local k3s cluster
3. **Scoped tokens are essential** — RFC 8693 token exchange is not optional
4. **Agent identity matters** — Each agent needs unique aud claim
5. **MCP tools must validate tokens** — Every tool call includes scoped token validation

---

## Success Criteria

Deployment is successful when:
- ✅ Portal accessible at https://portal-external.localhost/workforce-portal
- ✅ Can login as alice@company.com
- ✅ Both agents show in dropdown (Workforce Assistant, Trip Planner)
- ✅ Can send query to Workforce Agent → Gets expense data
- ✅ Can send query to Trip Planner → Gets travel suggestions
- ✅ DevTools Network tab shows token exchange calls
- ✅ All pods healthy (`kubectl get pods`)
- ✅ No errors in logs (`make logs`)

---

## Next Steps

1. Fork the repo
2. Update `.env` with your Ping credentials
3. Run `make setup`
4. Test portal at https://portal-external.localhost/workforce-portal
5. Read `DEMO_NARRATIVE.md` for presentation story
6. Schedule CTO demo

---

**Skill Version**: 1.0.0  
**Last Updated**: 2026-07-01  
**Status**: Production-ready for AI tool integration
