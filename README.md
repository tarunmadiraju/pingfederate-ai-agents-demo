# Ping AI Agents Demo — Enterprise-Ready AI with Identity Security

This is a production-ready reference implementation showing how **Ping Identity** secures AI-powered agents with enterprise-grade authentication, authorization, and token exchange.

## 🎯 What This Demo Solves

Organizations want AI agents (Chat, Travel Planning, Expense Reports) but need:
- ✅ **Authentication**: Who is using the agent?
- ✅ **Authorization**: What data can they access?
- ✅ **Token Scope**: Limited privileges per agent
- ✅ **Audit Trail**: Full compliance logging
- ✅ **Defense in Depth**: Multi-layer security

This demo shows how Ping provides the identity fabric that secures AI agents without rewriting them.

---

## 🏗️ Architecture

```
User Browser (Portal UI)
    ↓
PingAccess (Session + OIDC)
    ↓
PingGateway (OAuth2 Resource Server + RFC 8693 Token Exchange)
    ↓
AI Agents (Workforce Assistant, Trip Planner)
    ↓
MCP Tools (Expense, Travel, Finance)
```

### Components

| Component | Role |
|-----------|------|
| **PingFederate** | Identity Provider — authenticates users |
| **PingAccess** | BFF — manages sessions + OIDC flow |
| **PingGateway** | API Gateway — validates tokens, performs RFC 8693 token exchange |
| **PingAuthorize** | Policy Decision Point — enforces authorization policies |
| **Portal** | Express.js backend + Vue.js frontend |
| **AI Agents** | Python AG-UI servers running on Kubernetes |
| **MCP Tools** | Expense, Travel, Finance microservices |

---

## 🚀 Quick Start

### Prerequisites

- Docker & Docker Compose
- kubectl (Kubernetes CLI)
- k3d (k3s in Docker) or existing k3s cluster
- Ping Identity DevOps credentials (for Docker images)

### 1. Clone & Setup

```bash
git clone https://github.com/YOUR-ORG/ping-ai-agents-demo.git
cd ping-ai-agents-demo
export PING_IDENTITY_DEVOPS_USER=your-email@pingidentity.com
export PING_IDENTITY_DEVOPS_KEY=your-devops-key
```

### 2. Deploy Using Makefile

```bash
make setup          # Initialize k3d cluster + deploy all services
make status         # Check deployment status
make logs           # View logs across all services
```

### 3. Access Portal

```
https://portal-external.localhost/workforce-portal
```

**Test credentials**: alice@company.com / password (configured in PingFederate)

---

## 📋 What's Included

### Core Services
- ✅ **PingFederate** — OIDC provider
- ✅ **PingAccess** — BFF + session manager
- ✅ **PingAuthorize** — Policy Decision Point (XACML authorization)
- ✅ **PingIDM** — Identity Manager (user registry + attributes)
- ✅ **PingGateway** — Token exchange + authz enforcement
- ✅ **Workforce Portal** — Express + Vue.js
- ✅ **Workforce AI Agent** — Node.js AG-UI server
- ✅ **Trip Planner Agent** — Python AG-UI server with LLM fallback
- ✅ **MCP Servers** — Expense, Finance, Travel tools

### Key Fixes Applied
- ✅ **Trip Planner endpoint paths** — Fixed portal config to use correct agent routes
- ✅ **RFC 8693 token exchange** — Scoped tokens per agent
- ✅ **LLM fallback handler** — Generates travel responses when A2A registry empty
- ✅ **Authorization gates** — User-agent access control
- ✅ **Token validation** — At agent and MCP boundaries

### Documentation
- `DEMO_NARRATIVE.md` — Full CTO narrative (how to present)
- `DEMO_QUICK_REFERENCE.md` — 1-page demo cheat sheet
- `MCP_TOOLS_REFERENCE.md` — Tool ecosystem documentation
- `DEPLOYMENT.md` — Step-by-step deployment guide
- `ARCHITECTURE.md` — Technical deep-dive
- `PINGAUTHORIZE_PINGIDM_GUIDE.md` — Advanced authorization & identity management

---

## 🎮 Demo Flow

### Scene 1: Login (Identity Capture)
User logs in → PingFederate authenticates → Portal stores OIDC token

### Scene 2: Agent Selection (Authorization)
User picks agent → PingAuthorize checks if user is authorized → Only permitted agents shown

### Scene 3: Query (Token Exchange)
User sends message → Portal exchanges token for agent-scoped token (RFC 8693) → Request forwarded to agent

### Scene 4: Tool Invocation (MCP)
Agent receives query → LLM decides which tool to call → Agent invokes MCP with scoped token → Tool returns data

### Scene 5: Response (Synthesis)
MCP tool returns filtered data → Agent feeds to LLM → LLM synthesizes natural language response → Streams to browser

---

## 🔐 Security Layers

### Layer 1: Authentication (PingFederate)
- OAuth2 OIDC with PKCE
- User identity captured with organizational context (department, role, groups)

### Layer 2: Authorization (PingAuthorize)
- Policy-driven access control
- Agent-level: Can user call this agent?
- Tool-level: Can user invoke this MCP tool?
- Data-level: Can user see this data?

### Layer 3: Token Exchange (PingGateway + RFC 8693)
- User's broad token exchanged for agent-specific scoped token
- Narrow privileges: only valid for that agent
- Defense in depth: one hacked agent doesn't compromise others

---

## 🛠️ Deployment Options

### Option 1: Full Kubernetes (k3d)
```bash
export PING_IDENTITY_DEVOPS_USER=...
export PING_IDENTITY_DEVOPS_KEY=...
make setup
```

Deploys to local k3d cluster with all services.

### Option 2: Docker Compose (Local Dev)
```bash
docker-compose up -d
```

Runs services without Kubernetes (simpler for development).

### Option 3: Existing k3s Cluster
```bash
make deploy CLUSTER_NAME=your-cluster
```

Deploys to your existing cluster.

---

## 📊 Monitoring & Logs

```bash
# View all pod logs
make logs

# View specific service
kubectl -n ai-agents logs deployment/acp-trip-planner-agent

# Check deployment status
kubectl -n ai-agents get deployments

# Watch token exchange in action
kubectl -n default logs deployment/acp-gateway
```

---

## 🔧 Configuration

### Environment Variables

Create `.env` file in root:

```bash
# PingFederate
PF_ADMIN_USER=Administrator
PF_ADMIN_PASSWORD=your-password

# PingGateway
PG_ADMIN_PASSWORD=your-password

# Portal
OIDC_CLIENT_ID=portal
OIDC_CLIENT_SECRET=your-secret
OIDC_DISCOVERY_URL=https://pingfederate.localhost/oauth/.well-known/openid-configuration

# LLM (Ollama)
OLLAMA_BASE_URL=http://host.k3d.internal:11434
OLLAMA_MODEL=llama3.2:1b

# PingAuthorize Policies
# (Defined in kubernetes/policies/ directory)
```

### Custom Policies

Edit `kubernetes/policies/authz-policies.yaml` to add/modify authorization rules:

```yaml
policies:
  - name: "workforce-agent-access"
    rule: "user.groups contains 'finance' OR user.role == 'manager'"
    effect: "allow"
  - name: "trip-planner-access"
    rule: "true"  # Everyone can use
    effect: "allow"
```

---

## 📚 Key Files

### Portal
- `acp-workforce-portal/js/config.js` — Agent endpoint configuration
- `acp-workforce-portal/src/agentClient.js` — Token exchange logic
- `acp-workforce-portal/server.js` — Express backend

### Agents
- `acp-workforce-ai-agent/src/router.py` — Request routing + delegation
- `acp-trip-planner-agent/src/router.py` — Trip planner with LLM fallback
- `acp-trip-planner-agent/src/llm_router.py` — LLM decision making + fallback generation

### MCP Tools
- `mcp-servers/expense-mcp/` — Expense tool
- `mcp-servers/travel-mcp/` — Travel tool
- `mcp-servers/finance-mcp/` — Finance tool

---

## 🐛 Troubleshooting

### Trip Planner returns 404
**Cause**: Portal config has wrong endpoint paths
**Fix**: Verify `config.js` has correct agent routes

### "Registry is empty" error
**Cause**: PingIDM not deployed (A2A discovery unavailable)
**Fix**: Built-in LLM fallback handles this — agent generates responses directly via Ollama

### Token exchange fails
**Cause**: PingGateway token exchange endpoint misconfigured
**Fix**: Check `kubernetes/gateway-config.yaml` has token exchange filter enabled

### MCP tool returns 403 Forbidden
**Cause**: Scoped token aud doesn't match tool expectation
**Fix**: Verify token exchange creates correct aud claim

---

## 🎓 Learning Path

1. **Read**: `DEMO_NARRATIVE.md` (understand the story)
2. **Deploy**: Follow Quick Start
3. **Explore**: Log into portal, send queries
4. **Watch**: Open DevTools Network tab to see token exchanges
5. **Deep-dive**: Read `ARCHITECTURE.md` for technical details

---

## 🚢 Production Deployment

For production:

1. **Enable HTTPS/TLS** — Update ingress certificates
2. **Use real identity provider** — Replace PingFederate with your LDAP/AD/Azure AD
3. **Enable persistent storage** — Configure PVC for databases
4. **Add monitoring** — Enable Prometheus + Grafana
5. **Setup logging** — Configure ELK stack or CloudWatch
6. **Enable audit logging** — All token + tool calls logged
7. **Configure rate limiting** — Prevent LLM token spam
8. **Add data encryption** — At-rest + in-transit

See `DEPLOYMENT.md` for production checklist.

---

## 📝 Demo Narrative

For CTO/executive audiences:

**30-Second Pitch**: "Ping makes AI agents enterprise-ready. We handle authentication (PingFederate), authorization (PingAuthorize), and token scoping (PingGateway). One hacked agent doesn't compromise the whole system. Full audit trail for compliance."

See `DEMO_QUICK_REFERENCE.md` for complete talking points.

---

## 🤝 Integration with AI Tools

### Using with GitHub Copilot / Claude (with Skills)

This repo includes a `.instructions.md` file that enables AI tools to:
- Understand the repo structure
- Deploy new agents autonomously
- Fix deployment issues
- Run tests

**Usage**: 
1. Fork this repo
2. Use VS Code Copilot with Skills enabled
3. Ask: "Deploy a new agent called Expense Manager"
4. Copilot uses this Skills file to understand how to add it

See `SKILL.md` for details.

---

## 🐳 Docker Images

All images are built from source:

```bash
# Build Trip Planner agent
cd acp-trip-planner-agent
docker build -t k3d-registry.localhost:5001/acp-trip-planner-agent:latest .
docker push k3d-registry.localhost:5001/acp-trip-planner-agent:latest
```

Images pushed to local k3d registry. For production, use your registry (ECR, GCR, etc).

---

## 📞 Support

### Issues
- File GitHub issues with logs + error messages
- Include DevTools Network tab screenshots for token issues

### Questions
- See FAQ.md
- Check ARCHITECTURE.md for design questions
- Review logs with `make logs`

---

## 📄 License

Proprietary — Ping Identity reference implementation. Contact for commercial use.

---

## 🎯 Key Takeaways

✅ **AI agents need identity** — Not optional for enterprise  
✅ **Token exchange is NIST standard** — RFC 8693, proven approach  
✅ **Scoped tokens = defense in depth** — Limited blast radius per agent  
✅ **MCP tools enforce policies** — Authorization at execution layer  
✅ **Full audit trail** — Compliance built-in  

**Next**: Book demo with your CTO. See `DEMO_QUICK_REFERENCE.md` for talking points.

---

**Created**: 2026-07-01  
**Repository**: ping-ai-agents-demo  
**Status**: Production-ready reference implementation
