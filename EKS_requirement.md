# EKS Requirement — Phase 3 (Terraform → AWS EKS + Ingress/LB)

> ⏱️ **Session note:** Claude sessions are ~1 hour. This file is the **requirement gathering** for Phase 3 — what must be built and the constraints. The step-by-step execution runbook is the companion file **`EKS_guide.md`** (open both; requirement file = the "what/why", guide = the "how").
>
> Predecessors (verified): `POC_GUIDE.md` (Phase 1 ✅), `CICD_guide_latest` + `Jenkinsfile` (Phase 2 ✅).
> Requirement source: `requirement` + README §6.2/§6.4 + user's explicit Phase 3 asks.

---

## 1. Goal

Deploy the voting application from Phase 1/2 onto a production-shaped **AWS EKS** cluster, with:
- **1 master + 2 worker nodes** (see §3 — on EKS the "master" is a fully AWS-managed control plane).
- Infrastructure defined 100% in **Terraform** using **modules** and a **remote S3 backend with DynamoDB state locking**.
- A documented **EKS upgrade** path (control plane + managed node group, one minor version at a time).
- **Ingress** + **Load Balancer** so the app is reachable over the internet at a stable DNS name.
- Redeployment of the **same Docker Hub images the Phase 2 Jenkins pipeline pushes** (`sachinmaskar/voting:<svc>`), deployed via **Helm**.

Phase 3 succeeds when: the pipeline's images run on EKS behind an ALB ingress, votes persist to a PVC-backed Postgres, and `terraform destroy` leaves no stray AWS resources.

---

## 2. What already exists (context — do not rebuild)

| Layer | End state | Reused in Phase 3 |
|---|---|---|
| App images | `backend`, `frontend`, `voter-simulator` built & pushed to **Docker Hub `sachinmaskar/voting`** (:rolling + :sha8) by the Jenkins pipeline (Phase 2) | ✅ pulled by the Helm chart |
| CI/CD | Jenkins (Oracle Ubuntu, Poll SCM) → SonarQube → Docker build → Trivy (Azure VM) → Docker Hub push | unchanged; Phase 3 only changes what happens **after push** |
| App behavior | 5 services: postgres, redis, backend, frontend, simulator (`docker-compose.yml`, `Makefile`) | must behave identically on EKS |

**Key facts carried forward (from Phase 1 learnings):**
- Vote flow writes **directly to Postgres**; Redis is a best-effort buffer (optional at runtime). Postgres is the source of truth → on EKS it needs a **persistent volume**, not a throwaway pod.
- `/healthz` returns 200 only when both DB and Redis are reachable → drives K8s probes and the ALB target-group health check.
- Frontend (Nginx) reverse-proxies `/api/*` to backend `:3000` (no CORS) → keep that split on EKS (frontend service behind ingress; `/api` routed inside the cluster).
- Backend env vars: `DATABASE_URL`, `REDIS_URL`, `PORT` (defaults `postgres://vote:vote@...`, `redis://...`, 3000).
- Images are on **Docker Hub** — free-tier Docker Hub repos are **private**, so the cluster likely needs a `docker-registry` pull secret (§9).

---

## 3. Architecture & the "1 master + 2 workers" requirement

```
Browser ──▶ ALB (Application LB, internet-facing, created by AWS Load Balancer Controller)
              │  (Ingress: voting.ingress → frontend svc :NodePort)
     ┌────────▼────────┐
     │  frontend (Nginx) :80   ──/api/* proxy──▶  backend (Node) :3000
     └────────┬────────┘                             │            │
              │                                      ▼            ▼
              │                            Postgres (StatefulSet  Redis (Deployment)
              │                            + EBS PV gv3, Secret)   no persistence
              │
     ┌────────▼────────┐
     │  voter-simulator (Deployment) → posts to backend :3000 every 2s
     └─────────────────┘

Infra (Terraform):
  👉 1 EKS control plane  =  the "master"  (AWS-MANAGED — see below)
  👉 2 worker nodes (Managed Node Group, t3.medium ×2, 2 AWS AZs)
  VPC (2 AZs, private worker subnets + public subnets), NAT ×1, IAM/IRSA, OIDC provider,
  addons: VPC CNI, kube-proxy, CoreDNS, EBS CSI driver.
```

**Important, read this once:** EKS gives you a **managed control plane**. There is **no "master EC2 node" you provision, SSH into, or pay for separately** — AWS runs the control plane (API server, etcd, scheduler) on its own infra, replicated across 3 AZs, for a flat ~$73/month. So:
- "1 master" = the **managed control plane** (you cannot set it to literally 1 node, and you don't need to — AWS redundancy is baked in).
- "2 worker nodes" = what you actually provision and pay for (Managed Node Group → EC2 instances).

If you ever truly need your own visible master node (SSH to it, run etcd yourself), that is **self-managed Kubernetes via kubeadm on EC2**, not EKS — out of scope here. This project uses EKS as chosen.

**Recommended defaults (override if you prefer):**
| Item | Default | Why |
|---|---|---|
| Region | `us-east-1` | cheap + full EKS coverage; change via `region` variable |
| Worker size | `t3.medium` (2 vCPU / 4 GiB) × 2 | the commonly-accepted EKS minimum that boots reliably; `t3.small` is tight, `t3.micro` is not practical for EKS workers |
| AZs | 2 (`us-east-1a`, `us-east-1b`) | enough for HA; keeps NAT cost down |
| Capacity | On-demand (Spot noted as cost option) | deterministic for learning |
| Postgres | **In-cluster StatefulSet + EBS PVC** | keeps everything in EKS (matches compose), no extra RDS spend; RDS noted as future option |
| Ingress | **AWS Load Balancer Controller → ALB** | the idiomatic AWS answer; directly satisfies the "load balancer" requirement (NGINX ingress noted as alternative) |
| Cluster name | `voting-eks` | |
| K8s version | **latest currently supported** at apply time (see `EKS_guide.md` §1.3) | never start a cluster on an already-old version |

---

## 4. Functional requirements (the app on EKS)

1. The same behavior as Phase 1: a user can cast a vote (`lion|tiger|dog|cat`), an admin can view live results, votes persist across pod restarts.
2. The **simulator** keeps injecting a random vote every 2 s so results/load are visible.
3. Public access: `http://<ALB-DNS>/` serves the vote page, `/admin.html` the results page, `/api/results` returns JSON, `/api/vote` accepts votes, `/healthz` reports db/redis status.
4. Data durability: Postgres data survives node/container restarts and cluster upgrades (persistent EBS volume).
5. Zero changes to app code required — same images, same env vars, different runtime.

---

## 5. Infrastructure requirements (EKS)

- **Cluster:** one managed control plane (`voting-eks`) on the chosen version; endpoint private internal + one public-endpoint toggle (start public for learning, cite private-only as the hardening step).
- **Networking:** VPC with 2 public + 2 private subnets across 2 AZs; worker nodes in **private** subnets; **1 NAT gateway** (cost) with egress for pull/scan traffic; ALB lives in public subnets.
- **Workers:** Managed Node Group `voting-workers`, 2 × `t3.medium`, Amazon Linux 2023 (EKS-optimized), on-demand; AMI managed by EKS (auto-replaces on upgrade).
- **Addons (EKS managed, versioned):** `vpc-cni`, `kube-proxy`, `coredns`, and — critical for our Postgres PVC — **`aws-ebs-csi-driver`**.
- **Observability hooks (Phase 4, NOT built now):** leave `/metrics` reachable and don't block-scope it; Prometheus/Grafana/Loki come in Phase 4.

---

## 6. Terraform requirements (the "concepts" the user asked for)

1. **Remote backend:** Terraform state in **S3** (versioned, encrypted) + **DynamoDB table for state locking**. No state on local disk. Multi-env state keys (`dev/eks/...`).
2. **Modules:** infra split into reusable modules. Use the **official community modules** (`terraform-aws-modules/vpc/aws`, `terraform-aws-modules/eks/aws`) for the heavy lifting **plus at least one hand-written module** (the AWS Load Balancer Controller + IRSA) so the module-reuse / module-authoring pattern is demonstrated end to end.
3. **Project shape (proposed):**
   ```
   deploy/terraform/
   ├── environments/
   │   └── dev/
   │       ├── backend.tf    # S3 + DynamoDB
   │       ├── providers.tf  # aws, kubernetes, helm
   │       ├── main.tf       # module wiring (root module)
   │       ├── variables.tf
   │       ├── terraform.tfvars
   │       └── outputs.tf
   └── modules/
       ├── vpc/       (consumes terraform-aws-modules/vpc)
       ├── eks/       (consumes terraform-aws-modules/eks — control plane + node group)
       └── ingress-alb/ (hand-written: OIDC/IRSA IAM + aws-load-balancer-controller via Helm)
   ```
4. **Other Terraform concepts required:** variables + `tfvars`, outputs, `data` sources, `locals`, provider config (kubectl/helm authenticated via `aws eks get-token`), dependency ordering (`depends_on` where Helm needs the cluster), and pinning (`required_version`, provider/`source` `version` constraints).
5. **State hygiene:** `.gitignore` for `*.tfstate*` / `.terraform/`; never commit state (it contains secrets); document `terraform destroy` as the fail-safe.
6. **Provisioning order (staging of `apply`):** VPC → EKS + node group → addons → OIDC + LB controller → (kubectl), then Helm chart for the app (guide keeps Helm outside Terraform for Phase 3, or as an optional `helm_release` in the root module — recommend **kubectl/helm via CLI** first so the student sees the objects; automate later).

---

## 7. EKS upgrade requirements

1. Capability to move the cluster **one minor Kubernetes version at a time** (EKS rule: you cannot skip minor versions).
2. Order of operations: **scale/review → control plane → addons → managed node group → verify → (roll forward; no downgrade supported)**.
3. Pre-upgrade checks: deprecated API usage in our workloads (charts are simple, but verify), addon compatibility, LB controller chart compatibility.
4. Node disruption during upgrade must be **zero/rolling** (managed node group upgrade rolls nodes one at a time; our Postgres PV uses `WaitForFirstConsumer`-style binding so the pod isn't stranded on a dead node — verify reclaim/az handling in guide).
5. Downtime acceptable: a few minutes during the control-plane step for this learning project (cite a maintenance window + drain as the prod-grade alternative).
6. Document **rollback reality**: AWS does **not** support Kubernetes downgrades — the only rollback is from a **snapshot/backup of the app data** + redeploy. So the guide includes backing up Postgres data before upgrading.

---

## 8. Ingress & Load Balancer requirements

1. **AWS Load Balancer Controller** (v2.x, current release) deployed to the cluster via Helm, using **IRSA** (IAM Roles for Service Accounts) — the controller is the thing that turns an `Ingress` resource into a real ALB.
2. **ALB** (internet-facing, HTTP:80) created from a `kubernetes.io/ingress.class: alb` Ingress; target **NodePort** services (backend `3000/nodeport`, frontend `80/nodeport`); ALB health check path `/` (or `/healthz`).
3. Document (requirements, not build now): HTTPS/TLS via **ACM** certificate + `HTTPS:443` listener annotation as the hardening upgrade.
4. Optional/alternative noted: **NGINX Ingress Controller** (which itself needs a load balancer of type NLB/CLB) — kept as a documented alternative for learning, not the primary path.

---

## 9. Security requirements

1. **No long-lived cloud keys inside pods or charts.** All AWS permissions for cluster components via **IRSA** (OIDC-bound IAM roles).
2. Least-privilege IAM: separate roles for node group, EBS CSI driver, LB controller.
3. **Docker Hub private-repo pull:** create a `docker-registry` (`.dockerconfigjson`) `Secret` in the app namespace with the Phase 2 Docker Hub access token; reference via `imagePullSecrets` on all workloads. (If the `sachinmaskar/voting` repo is made public, this step is optional.)
4. **DB credentials** in a K8s `Secret` (not plaintext manifests); `Secret` is fine for learning; cite External Secrets/AWS Secrets Manager as the production option.
5. Worker node group in **private subnets**; ALB in public. SSM Session Manager (not SSH) for node-level access, if ever needed.

---

## 10. Cost requirements & budget guardrails (read this — EKS is not free-tier)

| Item | Est. monthly (us-east-1, approx) |
|---|---|
| EKS control plane (flat) | ~$73 |
| 2 × t3.medium on-demand (or ~$20 spot) | ~$60 |
| ALB (~$0.0225/hr + LCU) | ~$17+ |
| NAT gateway ×1 | ~$32 |
| EBS gp3 volumes | few $ |
| **Running 24×7 total** | **~$180–200+/mo** |

Guardrails required:
- **AWS Budgets alarm** (e.g. $50/80) created on day one.
- `terraform destroy` (or at minimum scale node group to 0) when not experimenting — control plane still bills.
- Prefer **spot** or `t3.small` for behind-the-scenes experiments; keep on-demand only while actively demoing.

---

## 11. Non-goals / out of scope (Phase 3)

- ❌ Observability stack (Prometheus/Grafana/Loki, alerts, dashboards) → **Phase 4**.
- ❌ Managed RDS/Aurora for Postgres (documented future option; not built).
- ❌ Self-managed Kubernetes / kubeadm master (see §3).
- ❌ Multi-region / multi-cluster / GitOps (Flux/ArgoCD) — future learning.
- ❌ Exposing Jenkins/SonarQube/Trivy (they stay on the existing boxes).

---

## 12. Assumptions & confirmed decisions

1. AWS account + billing is the user's own; this is their first EKS build (guide assumes blank-canvas, `us-east-1`).
2. Worker count **= 2** (user-specified). Node size/type honored from §3 unless the user overrides — supply in `terraform.tfvars`.
3. Region, instance type, on-demand-vs-spot, and cluster name are **user decisions with recommended defaults** (§3). Confirm before running long, but nothing here blocks starting.
4. App deployed with **Helm** (per README Phase 3); infra with **Terraform**. State on S3+DynamoDB.
5. The user follows instructions **only from `EKS_guide.md`** (this session instructed "step-by-step instructions in that file only, do not edit other files").

---

## 13. Acceptance criteria — what "Phase 3 done" means (mirrors `EKS_guide.md` §20)

- [ ] `terraform apply` built VPC + EKS control plane + **2 worker nodes** from remote S3 state with DynamoDB locking (`terraform apply` ≥ 2nd run shows no state drift).
- [ ] `kubectl get nodes` → 2 × `Ready`, K8s version = chosen version.
- [ ] Addons correct: `vpc-cni`, `kube-proxy`, `coredns`, `aws-ebs-csi-driver` showing `ACTIVE`.
- [ ] AWS Load Balancer Controller deployed; an `Ingress` created an internet-facing **ALB** with a working DNS.
- [ ] Helm chart `voting-app` installed: pods `Running/Ready` (postgres, redis, backend, frontend, simulator); images from `sachinmaskar/voting`.
- [ ] End-to-end via ALB DNS: `/` loads vote page, `/admin.html` shows live chart, POST `/api/vote` → 201, `/healthz` → 200.
- [ ] Postgres data survives a pod delete + node restart (PVC proof).
- [ ] **EKS upgrade procedure written and (optionally) demonstrated** one minor version with no data loss.
- [ ] `terraform destroy` tears everything down (or a written cost/cleanup plan) with nothing left in the AWS account beyond state bucket/DynamoDB (kept by design).

---

## 14. Open questions for the user (answer anytime; defaults apply)

1. AWS region — ok with **us-east-1**?
2. Worker capacity — **on-demand** (deterministic) or **spot** (cheaper, can be interrupted)?
3. Is the `sachinmaskar/voting` Docker Hub repo **private** (then we need the pull secret) or can it be public?
4. Do you want the guide to demonstrate the **EKS version upgrade live** (costs a little time/bill), or is documenting it sufficient for now?
5. Postgres **in-cluster + PVC** (recommended default) or do you explicitly want **RDS**?

*Companion runbook: `EKS_guide.md` — start there to execute this plan.*
