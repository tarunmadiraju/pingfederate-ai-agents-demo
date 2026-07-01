# Production Deployment Guide

This guide covers deploying the Ping AI Agents Demo to production environments.

## Pre-Deployment Checklist

- [ ] Ping Identity credentials obtained
- [ ] Kubernetes cluster available (1.24+)
- [ ] kubectl configured and authenticated
- [ ] Container registry accessible (ECR, GCR, ACR, or local)
- [ ] DNS configured for ingress hostnames
- [ ] TLS certificates obtained (or use cert-manager)
- [ ] LDAP/AD endpoint available for PingFederate
- [ ] SMTP configured for email notifications

## Architecture for Production

```
Users
  ↓
Ingress Controller (Nginx/Traefik)
  ↓
PingAccess (BFF, session management)
  ↓
PingGateway (Token exchange, authorization)
  ↓
AI Agents (Kubernetes Pods, horizontal scaling)
  ↓
MCP Tools (Microservices, autoscaling)
  ↓
Databases (PostgreSQL, MongoDB, etc.)
```

## Step 1: Update Configuration

### 1.1 Create Production Overlay

```bash
# Copy dev overlay to prod
cp -r kubernetes/overlays/dev kubernetes/overlays/prod

# Edit production settings
vi kubernetes/overlays/prod/kustomization.yaml
```

### 1.2 Update Environment Variables

```yaml
# kubernetes/overlays/prod/env.yaml
OLLAMA_BASE_URL: "https://ollama.internal:11434"
OLLAMA_MODEL: "llama2:13b"  # Larger model for prod
OIDC_DISCOVERY_URL: "https://pingfederate.company.com/oauth/.well-known/openid-configuration"
LOG_LEVEL: "info"
```

### 1.3 Configure Ingress TLS

```yaml
# kubernetes/overlays/prod/ingress.yaml
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: portal-ingress
  namespace: ai-agents
  annotations:
    cert-manager.io/cluster-issuer: "letsencrypt-prod"
spec:
  tls:
  - hosts:
    - portal.company.com
    - gateway.company.com
    secretName: portal-tls
  rules:
  - host: portal.company.com
    http:
      paths:
      - path: /
        backend:
          service:
            name: acp-workforce-portal
            port:
              number: 3000
```

## Step 2: Setup Persistent Storage

### 2.1 Create PersistentVolumes

```yaml
# kubernetes/overlays/prod/pvc.yaml
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: gateway-data
  namespace: gateway
spec:
  accessModes:
    - ReadWriteOnce
  resources:
    requests:
      storage: 50Gi
  storageClassName: fast-ssd

---
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: postgres-data
  namespace: default
spec:
  accessModes:
    - ReadWriteOnce
  resources:
    requests:
      storage: 100Gi
  storageClassName: fast-ssd
```

### 2.2 Mount in Deployments

```yaml
spec:
  containers:
  - name: gateway
    volumeMounts:
    - name: data
      mountPath: /opt/gateway/data
  volumes:
  - name: data
    persistentVolumeClaim:
      claimName: gateway-data
```

## Step 3: Configure High Availability

### 3.1 Replicate Agents

```yaml
# kubernetes/overlays/prod/deployments/trip-planner-ha.yaml
spec:
  replicas: 3  # HA: 3 replicas
  strategy:
    type: RollingUpdate
    rollingUpdate:
      maxSurge: 1
      maxUnavailable: 0
  template:
    spec:
      affinity:
        podAntiAffinity:
          preferredDuringSchedulingIgnoredDuringExecution:
          - weight: 100
            podAffinityTerm:
              labelSelector:
                matchExpressions:
                - key: app
                  operator: In
                  values:
                  - acp-trip-planner-agent
              topologyKey: kubernetes.io/hostname
```

### 3.2 Add Resource Limits

```yaml
resources:
  requests:
    memory: "512Mi"
    cpu: "500m"
  limits:
    memory: "2Gi"
    cpu: "2000m"
```

### 3.3 Configure HPA (Horizontal Pod Autoscaling)

```yaml
apiVersion: autoscaling/v2
kind: HorizontalPodAutoscaler
metadata:
  name: trip-planner-hpa
  namespace: ai-agents
spec:
  scaleTargetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: acp-trip-planner-agent
  minReplicas: 2
  maxReplicas: 10
  metrics:
  - type: Resource
    resource:
      name: cpu
      target:
        type: Utilization
        averageUtilization: 70
  - type: Resource
    resource:
      name: memory
      target:
        type: Utilization
        averageUtilization: 80
```

## Step 4: Setup Monitoring & Logging

### 4.1 Prometheus Scrape Config

```yaml
# kubernetes/overlays/prod/prometheus.yaml
scrape_configs:
- job_name: 'ping-agents'
  kubernetes_sd_configs:
  - role: pod
    namespaces:
      names:
      - ai-agents
```

### 4.2 ELK Stack (Elasticsearch, Logstash, Kibana)

```bash
# Deploy ELK
helm repo add elastic https://helm.elastic.co
helm install elasticsearch elastic/elasticsearch -n logging
helm install kibana elastic/kibana -n logging

# Configure log forwarding
kubectl apply -f kubernetes/overlays/prod/fluent-bit.yaml
```

### 4.3 Alerting Rules

```yaml
# kubernetes/overlays/prod/alerts.yaml
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: ping-agents-alerts
spec:
  groups:
  - name: agents
    interval: 30s
    rules:
    - alert: AgentDown
      expr: up{job="ping-agents"} == 0
      for: 5m
      annotations:
        summary: "Agent {{ $labels.pod }} is down"
```

## Step 5: Security Hardening

### 5.1 Network Policies

```yaml
# kubernetes/overlays/prod/network-policy.yaml
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: deny-all-ingress
  namespace: ai-agents
spec:
  podSelector: {}
  policyTypes:
  - Ingress
---
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: allow-from-gateway
  namespace: ai-agents
spec:
  podSelector:
    matchLabels:
      app: acp-trip-planner-agent
  policyTypes:
  - Ingress
  ingress:
  - from:
    - namespaceSelector:
        matchLabels:
          name: gateway
```

### 5.2 Pod Security Policies

```yaml
# kubernetes/overlays/prod/pod-security-policy.yaml
apiVersion: policy/v1beta1
kind: PodSecurityPolicy
metadata:
  name: restricted
spec:
  privileged: false
  allowPrivilegeEscalation: false
  requiredDropCapabilities:
  - ALL
  volumes:
  - 'configMap'
  - 'emptyDir'
  - 'projected'
  - 'secret'
  - 'downwardAPI'
  - 'persistentVolumeClaim'
  hostNetwork: false
  hostIPC: false
  hostPID: false
  runAsUser:
    rule: 'MustRunAsNonRoot'
  seLinux:
    rule: 'MustRunAs'
  supplementalGroups:
    rule: 'RunAsAny'
  fsGroup:
    rule: 'RunAsAny'
```

### 5.3 RBAC (Role-Based Access Control)

```yaml
# kubernetes/overlays/prod/rbac.yaml
apiVersion: rbac.authorization.k8s.io/v1
kind: Role
metadata:
  name: agent-reader
  namespace: ai-agents
rules:
- apiGroups: [""]
  resources: ["configmaps", "secrets"]
  verbs: ["get", "list", "watch"]
---
apiVersion: rbac.authorization.k8s.io/v1
kind: RoleBinding
metadata:
  name: agent-reader-binding
  namespace: ai-agents
roleRef:
  apiGroup: rbac.authorization.k8s.io
  kind: Role
  name: agent-reader
subjects:
- kind: ServiceAccount
  name: default
```

## Step 6: Database Setup

### 6.1 PostgreSQL for Agent Sessions

```yaml
apiVersion: v1
kind: Secret
metadata:
  name: postgres-credentials
  namespace: default
type: Opaque
stringData:
  username: postgres
  password: "$(openssl rand -base64 32)"
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: postgres
  namespace: default
spec:
  replicas: 1
  template:
    spec:
      containers:
      - name: postgres
        image: postgres:14-alpine
        env:
        - name: POSTGRES_USER
          valueFrom:
            secretKeyRef:
              name: postgres-credentials
              key: username
        - name: POSTGRES_PASSWORD
          valueFrom:
            secretKeyRef:
              name: postgres-credentials
              key: password
        volumeMounts:
        - name: data
          mountPath: /var/lib/postgresql/data
      volumes:
      - name: data
        persistentVolumeClaim:
          claimName: postgres-data
```

## Step 7: Deploy to Production

### 7.1 Build & Push Images

```bash
# Update image registry
export REGISTRY=your-registry.com

docker build -t $REGISTRY/acp-trip-planner-agent:v1.0.0 acp-trip-planner-agent
docker build -t $REGISTRY/acp-workforce-portal:v1.0.0 acp-workforce-portal
docker push $REGISTRY/acp-trip-planner-agent:v1.0.0
docker push $REGISTRY/acp-workforce-portal:v1.0.0
```

### 7.2 Apply Production Manifests

```bash
# Validate manifests
kubectl apply -k kubernetes/overlays/prod --dry-run=client

# Apply to production cluster
kubectl apply -k kubernetes/overlays/prod

# Wait for rollout
kubectl rollout status deployment/acp-trip-planner-agent -n ai-agents
```

### 7.3 Verify Deployment

```bash
# Check pods
kubectl get pods -n ai-agents

# Check services
kubectl get svc -n ai-agents

# Check ingress
kubectl get ingress -n ai-agents

# Test portal access
curl -k https://portal.company.com/workforce-portal
```

## Step 8: Backup & Disaster Recovery

### 8.1 Backup Strategy

```bash
# Backup etcd
ETCDCTL_API=3 etcdctl --endpoints=127.0.0.1:2379 snapshot save backup.db

# Backup persistent volumes
kubectl get pvc -A --no-headers | awk '{print $1, $2}' | while read ns pvc; do
  kubectl exec -n $ns -it postgres -- \
    pg_dump -U postgres > backup_$ns_$pvc.sql
done
```

### 8.2 Restore Plan

Document recovery procedures for:
- Database restore from backup
- Pod recreation after node failure
- Manual failover procedures

## Step 9: Compliance & Audit

### 9.1 Audit Logging

```yaml
# Enable Kubernetes audit logging
--audit-log-path=/var/log/audit.log
--audit-policy-file=/etc/kubernetes/audit-policy.yaml
```

### 9.2 Compliance Checks

```bash
# CIS Kubernetes Benchmark
docker run --rm --net host -v /etc:/etc:ro -v /var:/var:ro \
  aquasec/trivy config /kubernetes

# Policy enforcement (OPA/Gatekeeper)
kubectl apply -f kubernetes/overlays/prod/gatekeeper/
```

## Production Checklist

- [ ] All nodes healthy (`kubectl get nodes`)
- [ ] All pods running (`kubectl get pods -A`)
- [ ] Ingress accessible
- [ ] SSL/TLS certificates valid
- [ ] Databases initialized and backed up
- [ ] Monitoring & alerting active
- [ ] Log aggregation working
- [ ] Network policies enforced
- [ ] RBAC configured
- [ ] Backup tested and documented
- [ ] Runbooks created (incident response)
- [ ] On-call rotation established
- [ ] Load testing completed
- [ ] Chaos engineering tests passed

## Ongoing Operations

### Monitoring
- Check Prometheus/Grafana dashboards daily
- Review alert notifications
- Track resource utilization trends

### Maintenance
- Apply security patches within 30 days
- Upgrade Kubernetes cluster regularly
- Rotate credentials every 90 days
- Conduct disaster recovery drills quarterly

### Troubleshooting
- Enable debug logging if issues occur
- Collect Pod logs and describe output
- Check events for failure reasons
- Use kubectl port-forward for debugging

## Support & Escalation

1. **Level 1**: Check logs, pod status, events
2. **Level 2**: Check networking, storage, RBAC
3. **Level 3**: Contact Ping Identity support

---

**Status**: Production-ready  
**Last Updated**: 2026-07-01
