# PingAuthorize & PingIDM Integration Guide

This document explains how **PingAuthorize** (Policy Decision Point) and **PingIDM** (Identity Manager) extend the Ping AI Agents Demo with advanced authorization and identity management.

## Architecture Overview

```
┌──────────────────────────────────────────────────────────────────┐
│                         User Browser                              │
└─────────────────────────────┬──────────────────────────────────────┘
                              │
                              ↓
                    ┌──────────────────┐
                    │  PingAccess      │  ← Login + Session
                    │  (BFF)           │
                    └────────┬─────────┘
                             │
                             ↓
                    ┌──────────────────┐
                    │  PingFederate    │  ← Identity Provider
                    │  (OIDC)          │
                    └────────┬─────────┘
                             │
                             ↓
                    ┌──────────────────┐
                    │  PingIDM         │  ← Identity Data + Attributes
                    │  (User DB)       │
                    └──────────────────┘
                             │
            ┌────────────────┼────────────────┐
            │                │                │
            ↓                ↓                ↓
      ┌──────────┐   ┌──────────┐   ┌──────────────┐
      │PingGateway  │   │Agents    │   │PingAuthorize │
      │(Token       │   │(AI)      │   │(Policies)    │
      │Exchange)    │   │          │   │              │
      └──────────┘   └──────────┘   └──────────────┘
            │                │                │
            └────────────────┼────────────────┘
                             │
                             ↓
                    ┌──────────────────┐
                    │  MCP Tools       │
                    │  (Expense, Travel│
                    │   Finance)       │
                    └──────────────────┘
```

## 1. PingAuthorize - Policy Decision Point

### Purpose
PingAuthorize enforces **fine-grained authorization policies** using XACML (eXtensible Access Control Markup Language).

### What It Does

| Decision | Based On | Example |
|----------|----------|---------|
| **Agent Access** | User role + resource | Only employees can use Workforce Agent |
| **Tool Access** | User attributes | Only Finance role can access Finance MCP |
| **Data Scope** | User ID + resource ID | Employees see only their own expenses |

### Policies Included

#### 1. **Workforce AI Agent Policy**
```
IF user.role == "employee"
  AND resource == "workforce-agent"
THEN Permit
ELSE Deny
```

#### 2. **Trip Planner Agent Policy**
```
IF user is authenticated
  AND resource == "trip-planner-agent"
THEN Permit  ← All users can access
```

#### 3. **MCP Tool Data Access Policy**
```
IF resource == "mcp:expense"
  AND user.id == resource.owner_id
THEN Permit  ← See only own expenses

IF resource == "mcp:finance"
  AND user.role == "finance"
THEN Permit  ← Finance team sees budget data
```

### How It Integrates

1. **User requests agent** → PingAccess asks PingAuthorize: "Can this user access this agent?"
2. **PingAuthorize evaluates policies** → Checks user attributes from PingIDM
3. **Returns decision** → Permit/Deny with obligations
4. **PingGateway enforces** → Only forwards request if permitted

### Configuration

PingAuthorize policies are stored in:
- **Docker Compose**: `/kubernetes/base/configmaps/xacml-policies.yaml`
- **Format**: XACML 3.0 XML
- **Edit**: Update the ConfigMap to add/modify policies

### Admin Console
- **Docker Compose**: http://localhost:8444 (PingAuthorize Admin)
- **Kubernetes**: https://pingauthorize.localhost:8444
- **Default Creds**: admin / password (set in Dockerfile)

---

## 2. PingIDM - Identity Manager

### Purpose
PingIDM manages **user identity data**, attributes, and provides the **user registry** that PingFederate and PingAuthorize reference.

### What It Manages

| Entity | Purpose | Example |
|--------|---------|---------|
| **Users** | Employee directory | alice@company.com, bob@company.com |
| **Roles** | User groups | employee, manager, finance, executive |
| **Attributes** | User metadata | department, manager, cost-center, location |
| **Policies** | Governance rules | Password policy, approval workflows |
| **Relationships** | User connections | Reports-to, manages, collaborates-with |

### Data Flow

```
PingIDM (Master User Database)
    ↓ (syncs to)
PingFederate (Authentication)
    ↓ (queries for authz decisions)
PingAuthorize (Policy decisions)
    ↓ (enforces based on attributes)
MCP Tools (Data filtering)
```

### Key Features

#### 1. **Attribute-Based Access Control (ABAC)**
```
User: alice
Attributes:
  - role: employee
  - department: operations
  - manager: carol@company.com
  - cost-center: CC-123
  - location: US-EAST

Authorization Decision:
  - ✅ Can access: Workforce Agent (role: employee)
  - ✅ Can see: Own expenses (user.id match)
  - ❌ Cannot see: Finance reports (role != finance)
```

#### 2. **User Provisioning**
```
HR System
    ↓ (new employee added)
Creates user in PingIDM
    ↓ (auto-sync)
Available in PingFederate
    ↓ (can now login)
Can access agents & tools
```

#### 3. **Data Governance**
```
User password expires
    ↓
Notified via email
    ↓
Must reset in PingIDM
    ↓
Can login again
```

### Configuration

PingIDM configuration:
- **Docker Compose**: Config in `/kubernetes/base/configmaps/pingidm-config.yaml`
- **OpenTelemetry**: Enabled for tracing
- **Data Storage**: In-memory for demo (upgrade to PostgreSQL for production)

### Admin Console
- **Docker Compose**: http://localhost:8080/admin
- **Kubernetes**: http://pingidm.localhost/admin
- **API Endpoint**: http://localhost:8080/api

---

## 3. Integration with RFC 8693 Token Exchange

### Complete Flow

```
1. User logs in (PingFederate)
   ↓ PingIDM provides user attributes
   
2. User selects agent (Portal)
   ↓ PingAuthorize checks agent access
   
3. Portal exchanges token (PingGateway)
   ↓ Token scoped to: agent + user attributes
   
4. Agent receives scoped token
   ↓ Token contains user.role, user.department, etc.
   
5. Agent calls MCP tool with scoped token
   ↓ Tool validates token + checks MCP-level policies
   
6. Tool filters data based on user attributes
   ↓ e.g., Show only expenses for this user
   
7. Data returned to agent
   ↓ Agent synthesizes response
   
8. Response sent to user
```

### Token Contents (After Exchange)

```json
{
  "sub": "user-123",
  "aud": "trip-planner-agent",
  "scope": "trips:read flights:search hotels:search",
  "user_id": "alice@company.com",
  "roles": ["employee"],
  "department": "operations",
  "manager": "carol@company.com",
  "cost_center": "CC-123",
  "iat": 1688000000,
  "exp": 1688003600
}
```

### Authorization Chain

```
1. Scoped Token:
   - Audience: trip-planner-agent (can't use for other agents)
   - Scope: trips:read trips:plan (limited permissions)
   - User attributes: department, manager, etc.

2. MCP Tool receives scoped token
   - Validates audience match
   - Validates signature (PingGateway signed it)
   - Extracts user attributes

3. Tool enforces data-level access
   - Trip expense? Check: user.department == expense.department
   - Budget data? Check: user.role == "finance"
   - Personal record? Check: user.id == record.owner

4. Response sent back
   - Only filtered data included
   - Full audit trail created
```

---

## 4. Deployment

### Docker Compose

```bash
# Add to .env
PING_IDENTITY_DEVOPS_USER=your-email@pingidentity.com
PING_IDENTITY_DEVOPS_KEY=your-key

# Start everything
docker-compose up -d

# Services available:
# - PingFederate: http://localhost:9999
# - PingAccess: http://localhost:3000
# - PingAuthorize: http://localhost:8443 (HTTPS)
# - PingIDM: http://localhost:8080
# - Portal: http://localhost:3001
```

### Kubernetes

```bash
# Deploy with manifests
kubectl apply -k kubernetes/base

# Check status
kubectl get pods -l app=pingauthorize
kubectl get pods -l app=pingidm
kubectl get svc pingauthorize pingidm

# View logs
kubectl logs -f deployment/pingauthorize
kubectl logs -f deployment/pingidm
```

---

## 5. Customization

### Add New Authorization Policies

Edit `/kubernetes/base/configmaps/xacml-policies.yaml`:

```yaml
<Policy PolicyId="urn:ping:policy:my-custom-policy">
  <Target>
    <!-- Define which resources this policy applies to -->
  </Target>
  <Rule RuleId="urn:ping:rule:permit-marketing">
    <Condition>
      <!-- Custom condition logic -->
    </Condition>
  </Rule>
</Policy>
```

### Add User Attributes

Edit PingIDM data model:
```bash
# Via admin console: http://localhost:8080/admin
# Add custom attributes under: Managed Users → Attributes

# Via API:
curl -X POST http://localhost:8080/api/schema/managedObjects/user/properties \
  -d '{"name":"cost_center", "type":"string"}'
```

### Update Token Scope

In PingGateway config, modify RFC 8693 exchange:
```yaml
# kubernetes/base/deployments/pinggateway-deployment.yaml
scoped_token_config:
  audience: "{{ resource_id }}"
  scope: "{{ user_roles }}:{{ requested_scope }}"
  attributes:  # Include user attributes in token
    - department
    - manager
    - cost_center
```

---

## 6. Troubleshooting

### PingAuthorize Won't Start
```bash
# Check OpenTelemetry config
kubectl logs deployment/pingauthorize | grep -i otel

# Verify Java environment
kubectl exec deploy/pingauthorize -- java -version

# Check policy syntax
xmllint /opt/policies/xacml-policies.yaml
```

### PingIDM Health Issues
```bash
# Check if services are ready
kubectl get pods -l app=pingidm -o wide

# View detailed logs
kubectl logs deployment/pingidm --tail=50

# Verify connectivity to PingFederate
kubectl exec deploy/pingidm -- curl -v http://pingfederate:9999/pf/heartbeat.ping
```

### Authorization Decisions Not Being Enforced
```bash
# Enable policy evaluation logging
kubectl set env deployment/pingauthorize \
  XACML_LOG_LEVEL=DEBUG

# Check that PingGateway is calling PingAuthorize
kubectl logs deployment/pinggateway | grep -i "authorize"

# Verify user attributes are being passed
kubectl logs deployment/pingauthorize | grep -i "attribute"
```

---

## 7. Security Considerations

### Production Checklist

- [ ] Enable HTTPS for all PingAuthorize communication
- [ ] Rotate default credentials (PingIDM admin password)
- [ ] Configure LDAP backend for PingIDM (instead of in-memory)
- [ ] Enable audit logging for all authorization decisions
- [ ] Implement policy versioning and change control
- [ ] Setup HPA (Horizontal Pod Autoscaling) for both services
- [ ] Configure resource limits and requests
- [ ] Enable network policies to restrict traffic
- [ ] Setup backup/restore procedures for PingIDM data
- [ ] Configure SSL/TLS certificates for all endpoints

### Defense in Depth

```
Layer 1: Authentication (PingFederate)
  → Only authenticated users can proceed

Layer 2: Authorization (PingAuthorize)
  → User's overall access is checked

Layer 3: Token Scoping (PingGateway)
  → Token is narrowed to specific agent/tool

Layer 4: Data Filtering (MCP Tools)
  → Tool filters data based on user attributes

Result: Even if one layer is compromised, others provide protection
```

---

## 8. Next Steps

1. **Deploy**: Run `make setup` or `docker-compose up -d`
2. **Verify**: Check that PingAuthorize and PingIDM are healthy
3. **Test**: Login as different users and verify policies
4. **Customize**: Add policies for your use cases
5. **Monitor**: Setup alerts for authorization failures
6. **Integrate**: Connect to your actual LDAP/AD for user provisioning

---

## References

- [PingAuthorize Documentation](https://docs.pingidentity.com/bundle/pingauthorize/page/paa/pingtoolsgettingstarted/p_gettingStartedGuide.html)
- [PingIDM Documentation](https://docs.pingidentity.com/bundle/pingidm/page/pim/pingtoolsgettingstarted/p_gettingStartedGuide.html)
- [XACML 3.0 Specification](http://docs.oasis-open.org/xacml/3.0/xacml-3.0-core-spec-os-en.html)
- [RFC 8693 - OAuth 2.0 Token Exchange](https://datatracker.ietf.org/doc/html/rfc8693)
