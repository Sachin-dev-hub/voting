# EKS Guide — Phase 3 (Step-by-step: Terraform → EKS → ALB Ingress)

> ⏱️ **Session note:** sessions are ~1 hour. This file is the ONLY execution runbook for Phase 3. Work through the sections **in order** and tick the checklist in §20 at the end of each hour so the next session resumes cleanly.
>
> **Companion docs:** `EKS_requirement.md` (the what/why/requirements — read §3 about "1 master + 2 workers" and §10 about cost before spending money), `CICD_guide_latest` (Phase 2 — the images this guide deploys).
>
> **Big warning first:** EKS costs ~$180–200/mo if left running (§10 of the requirement file). Set up a **budget alarm (§2.3)** before the cluster exists. Nothing here is free-tier.

---

## Table of contents (do in order)

1. [Prerequisites & tools (on "your box")](#1-prerequisites--tools)
2. [AWS account prep + budget guardrail](#2-aws-account-prep)
3. [Create the Terraform state backend (S3, native locking — no DynamoDB)](#3-terraform-state-backend)
4. [Scaffold the Terraform project](#4-scaffold-the-terraform-project)
5. [Module: VPC](#5-module-vpc)
6. [Module: EKS (control plane + node group)](#6-module-eks)
7. [Module: AWS Load Balancer Controller (IRSA + Helm)](#7-module-aws-load-balancer-controller)
8. [Root module wiring (providers, main, variables, tfvars, outputs)](#8-root-module-wiring)
9. [terraform init / plan / apply — in stages](#9-terraform-init--plan--apply)
10. [Configure kubectl + verify the cluster](#10-configure-kubectl--verify)
11. [Namespace + registry pull secret](#11-namespace--registry-pull-secret)
12. [Helm chart: voting-app (files)](#12-helm-chart-voting-app)
13. [Install the chart + verify pods](#13-install-the-chart--verify-pods)
14. [Ingress → ALB: verify the load balancer](#14-ingress--alb-verify)
15. [Data persistence check (Postgres PVC)](#15-data-persistence-check)
16. [EKS upgrade, step by step](#16-eks-upgrade-step-by-step)
17. [Everyday ops snippets](#17-everyday-ops-snippets)
18. [Cost control & cleanup (terraform destroy)](#18-cost-control--cleanup)
19. [Troubleshooting](#19-troubleshooting)
20. [Phase 3 checklist + handoff to Phase 4](#20-phase-3-checklist--handoff)

---

## 1. Prerequisites & tools

Run everything below from your **Azure VM** (the same Ubuntu VM already hosting the Trivy server from Phase 2). This is the production-realistic choice: production Terraform/kubectl/helm work happens on **Linux** (CI runners, Jenkins agents, GitOps runners) — not from a Windows shell, which isn't a pattern you'd see in a real project.

**Connect to the Azure VM over SSH** (from your Windows/Linux workstation — you already have the keypair from Phase 2):
```bash
ssh -i ~/.ssh/<your-private-key>.pem azureuser@<AZURE_VM_PUBLIC_IP>
sudo apt-get update        # once in, refresh index before installing
```
Everything here is **outbound to AWS** on the public internet, so no Azure NSG changes are needed for the work in this guide (the 8082 Trivy inbound rule Phase 2 configured stays as-is and doesn't conflict). One heads-up: on a smaller Azure VM (e.g. B1s/B1ms, 1 vCPU), Terraform/EKS API calls work but `aws eks update-kubeconfig`, `helm`, and `kubectl` feel slow — that's fine, just expect longer waits; run near a NAT'd, always-on connection.

> If your Azure VM can't reach AWS/HashiCorp (DNS or route), first check: NSG outbound rules, local `curl -sI https://releases.hashicorp.com` and `curl -sI https://registry.terraform.io` from the VM. No clipboard/browser needed inside the VM — the ALB URLs are opened from **your own browser** on your workstation (§14).

### 1.1 Install / verify (Ubuntu on the Azure VM)
```bash
sudo apt-get update
terraform version        # need >= 1.10  (1.10+ required for S3 native locking, §3)
kubectl version --client # need >= 1.28 (CLI should be >= cluster minor -1)
helm version --short
aws --version            # AWS CLI v2
eksctl version           # (used for nodegroup/addon upgrades in §16, §18) — optional, but needed there
```

**Terraform** (HashiCorp apt repo — stays current via `apt upgrade`):
```bash
sudo apt-get update && sudo apt-get install -y gnupg software-properties-common wget
wget -O- https://apt.releases.hashicorp.com/gpg | gpg --dearmor | sudo tee /usr/share/keyrings/hashicorp-archive-keyring.gpg >/dev/null
echo "deb [signed-by=/usr/share/keyrings/hashicorp-archive-keyring.gpg] https://apt.releases.hashicorp.com $(lsb_release -cs) main" | sudo tee /etc/apt/sources.list.d/hashicorp.list
sudo apt-get update && sudo apt-get install -y terraform
```

**kubectl** (official Kubernetes apt repo — keep the minor matched to §1.3):
```bash
sudo apt-get update && sudo apt-get install -y apt-transport-https ca-certificates curl gnupg
curl -fsSL https://pkgs.k8s.io/core:/stable:/v1.31/deb/Release.key | sudo gpg --dearmor -o /etc/apt/keyrings/kubernetes-apt-keyring.gpg
echo 'deb [signed-by=/etc/apt/keyrings/kubernetes-apt-keyring.gpg] https://pkgs.k8s.io/core:/stable:/v1.31/deb/ /' | sudo tee /etc/apt/sources.list.d/kubernetes.list
sudo apt-get update && sudo apt-get install -y kubectl
# (set "v1.31" to the cluster's minor-version you pick in §1.3; the CLI should be >= cluster minor -1, prefer equal)
```
Kubernetes publishes a `stable:/v1.31/deb/` repo per supported minor — if you choose another version in §1.3, swap `v1.31` for that minor.

**Helm** (official installer — needs curl):
```bash
curl -fsSL -o get_helm.sh https://raw.githubusercontent.com/helm/helm/main/scripts/get-helm-3
chmod 700 get_helm.sh && ./get_helm.sh
# or, if you prefer a package:  sudo snap install helm --classic
```

**AWS CLI v2** (bundled installer — the distro `apt awscli` is v1, avoid it):
```bash
sudo apt-get install -y unzip    # needed to unpack the installer
curl "https://awscli.amazonaws.com/awscli-exe-linux-x86_64.zip" -o "awscliv2.zip"
unzip awscliv2.zip && sudo ./aws/install && rm -rf awscliv2.zip aws
```

**eksctl** (official binary — needed only for the nodegroup/addon upgrade & scale steps in §16/§18):
```bash
curl --silent --location "https://github.com/weaveworks/eksctl/releases/latest/download/eksctl_$(uname -s)_amd64.tar.gz" | tar xz -C /tmp
sudo mv /tmp/eksctl /usr/local/bin
```

Verify all from a **new terminal** (new PATH):
```bash
terraform version; kubectl version --client; helm version --short; aws --version; eksctl version
```

### 1.2 AWS credentials (never commit these)
```bash
aws configure            # access key / secret / region (us-east-1) / output json
aws sts get-caller-identity   # shows the account you're about to bill
```
Credentials are written to `~/.aws/credentials`. Terraform inherits this automatically (it reads the shared credentials file, env vars, or `AWS_PROFILE` — keep exactly one source consistent).

### 1.3 Choose the Kubernetes version — always pin the latest currently supported
Do **not** hard-code a stale version. Check what's currently offered:
```bash
# list EKS versions this account can create
aws eks describe-addon-versions --addon-name eks-dns 2>/dev/null | grep -o '"name": "[0-9]*\.[0-9]*"' | sort -u | tail
# simplest: EKS console → "Add cluster" shows supported versions — use the newest stable one.
```
In this guide `kubernetes_version = "1.32"` is used as a **placeholder example** — replace with the newest you saw in the console. (As of writing, 1.30–1.32 range is expected to be supported; always confirm at run time per the EKS version table.)

### 1.4 Registry note (Docker Hub)
Images come from `sachinmaskar/voting` (Phase 2). Free Docker Hub is **private by default** — plan for a pull secret (§11). Have your Docker Hub **access token** handy (same one as Phase 2's `registry-credentials`).

---

## 2. AWS account prep

### 2.1 IAM user
CloudTrail-visible IAM user with programmatic access; for learning a policy like `AdministratorAccess` attached to **this user only** is acceptable — understand it's overprivileged (least-privilege refinement is §9 of the requirement doc).

### 2.2 Region + limits
Use **us-east-1**. Confirm no glaring service limit blockers (`aws support` not needed; EKS/TGW/ALB defaults are fine at this scale).

### 2.3 Budget alarm FIRST (before any apply)
```bash
# Creates a cost budget: $50 monthly forecast, alerts at 80%.
aws budgets create-budget \
  --account-id $(aws sts get-caller-identity --query Account --output text) \
  --budget '{"BudgetLimit":{"Amount":"50","Unit":"USD"},"BudgetType":"COST","TimeUnit":"MONTHLY","BudgetName":"voting-eks-monthly"}' \
  --notifications-with-subscribers '[{"Notification":{"NotificationType":"ACTUAL","ComparisonOperator":"GREATER_THAN","Threshold":80,"ThresholdType":"PERCENTAGE"},"Subscribers":[{"SubscriptionType":"EMAIL","Address":"YOUR_EMAIL@EXAMPLE.COM"}]}]'
```
(Go to Cost Explorer → Budgets in the console if CLI is easier. The point: get a canary email.)

---

## 3. Terraform state backend

Terraform state goes to **S3** (versioned + encrypted). Locking uses **S3's native object locking** via the backend's `use_lockfile = true` option — **no DynamoDB table is needed**. (Terraform ≥ 1.10 implements lock-free-file locking by writing a `.tflock` object in S3 and using conditional writes.) The bucket is created out-of-band once (small script, fine to run by hand):

```bash
BUCKET=voting-tfstate-$(aws sts get-caller-identity --query Account --output text)   # account-unique suffix
REGION=us-east-1

aws s3api create-bucket --bucket $BUCKET --region $REGION
# (us-east-1 is the only region that does NOT need LocationConstraint)
aws s3api put-bucket-versioning --bucket $BUCKET --versioning-configuration Status=Enabled
aws s3api put-bucket-encryption --bucket $BUCKET \
  --server-side-encryption-configuration '{"Rules":[{"ApplyServerSideEncryptionByDefault":{"SSEAlgorithm":"AES256"}}]}'
aws s3api put-public-access-block --bucket $BUCKET \
  --public-access-block-configuration BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true

echo "S3 bucket: $BUCKET"
```

> State is remote **from step one** — nothing stays on disk. Note the bucket name; it goes in `backend.tf` (§8.1). The bucket intentionally **survives** `terraform destroy` — it's your state home. Because locking is done by S3 itself, there is **no DynamoDB table to create or bill**. Versioning gives you state history/rollback; the `use_lockfile` option (set in §8.1) gives you the lock — you need **Terraform ≥ 1.10** for it (bump the `required_version` in §8.2 accordingly; the guide uses `>= 1.10`).

---

## 4. Scaffold the Terraform project

Create this tree under `deploy/` **in your repo working copy** (this repo is the natural home; commit the `.tf` files — state is git-ignored):

```bash
mkdir -p deploy/terraform/{environments/dev,modules/{vpc,eks,ingress-alb}}
touch deploy/.gitignore
printf '.terraform/\n*.tfstate\n*.tfstate.*\ncrash.log\n' > deploy/.gitignore
```

```
deploy/terraform/
├── environments/dev/        ← the root module you run (cd here)
│   ├── backend.tf
│   ├── providers.tf
│   ├── main.tf
│   ├── variables.tf
│   ├── terraform.tfvars
│   └── outputs.tf
└── modules/
    ├── vpc/
    ├── eks/
    └── ingress-alb/
```

---

## 5. Module: VPC

`modules/vpc/` — a thin wrapper around the official VPC module (proves "write a module that wraps a module"; variables flow through).

**`modules/vpc/variables.tf`**
```hcl
variable "name" {}
variable "vpc_cidr" { default = "10.0.0.0/16" }
variable "azs" { type = list(string) }
variable "private_subnets" { type = list(string) }
variable "public_subnets"  { type = list(string) }
variable "enable_nat_gateway" { default = true }
variable "single_nat_gateway"  { default = true }   # cost: 1 NAT
```

**`modules/vpc/main.tf`**
```hcl
module "vpc" {
  source  = "terraform-aws-modules/vpc/aws"
  version = "~> 5.0"

  name = var.name
  cidr = var.vpc_cidr

  azs             = var.azs
  private_subnets = var.private_subnets
  public_subnets  = var.public_subnets

  enable_nat_gateway     = var.enable_nat_gateway
  single_nat_gateway     = var.single_nat_gateway
  enable_dns_hostnames   = true
  enable_dns_support     = true

  tags = { Name = var.name }
}
```

**`modules/vpc/outputs.tf`**
```hcl
output "vpc_id"             { value = module.vpc.vpc_id }
output "private_subnets"    { value = module.vpc.private_subnets }
output "public_subnets"     { value = module.vpc.public_subnets }
output "nat_sg"             { value = module.vpc.nat_security_group_id }
```

---

## 6. Module: EKS

`modules/eks/` — wraps `terraform-aws-modules/eks/aws` for control plane **and managed node group** (this is where the "2 worker nodes" live).

**`modules/eks/variables.tf`**
```hcl
variable "name" {}
variable "cluster_version" { description = "K8s version, e.g. 1.32 — set to newest supported" }
variable "vpc_id" {}
variable "private_subnets" { type = list(string) }
variable "node_desired_size" { default = 2 }   # <-- the "2 workers"
variable "node_min_size" { default = 2 }
variable "node_max_size" { default = 4 }
variable "node_instance_type" { default = "t3.medium" }
variable "create_oidc_provider" { default = true }
```

**`modules/eks/main.tf`**
```hcl
module "eks" {
  source  = "terraform-aws-modules/eks/aws"
  version = "~> 20.0"

  cluster_name    = var.name
  cluster_version = var.cluster_version

  vpc_id     = var.vpc_id
  subnet_ids = var.private_subnets

  create_oidc_provider = var.create_oidc_provider

  # EKS-managed addons our app needs — the EBS CSI driver is REQUIRED for the
  # Postgres PVC (the cluster will not provision volumes without it).
  cluster_addons = {
    coredns                = { most_recent = true }
    kube-proxy             = { most_recent = true }
    vpc-cni                = { most_recent = true }
    aws-ebs-csi-driver     = { most_recent = true }
  }

  eks_managed_node_groups = {
    voting-workers = {
      desired_size = var.node_desired_size
      min_size     = var.node_min_size
      max_size     = var.node_max_size

      instance_types = [var.node_instance_type]
      ami_type       = "AL2023_x86_64_STANDARD"   # EKS-managed AMI updates on upgrade

      # private subnets only → workers have no public IP
      subnet_ids = var.private_subnets

      # tags land on the underlying ASG/instances (helpful for cost allocation)
      tags = { Cluster = var.name, Role = "workers" }
    }
  }
}
```

> The module wires the nodegroup to a Launch Template + ASG under the hood, and the `cluster_addons` block keeps addons versioned with the cluster.
> Optionally enable `node_group_defaults = { capacity_type = "SPOT" }` to cut worker cost ~70% (tradeoff: instances can be reclaimed) — see requirement doc §10.

**`modules/eks/outputs.tf`**
```hcl
output "cluster_id"                          { value = module.eks.cluster_id }
output "cluster_name"                        { value = module.eks.cluster_name }
output "cluster_endpoint"                    { value = module.eks.cluster_endpoint }
output "cluster_certificate_authority_data"  { value = module.eks.cluster_certificate_authority_data }
output "cluster_version"                     { value = module.eks.cluster_version }
output "oidc_provider_arn"                   { value = module.eks.oidc_provider_arn }
output "oidc_provider_url"                   { value = module.eks.oidc_provider_url }
output "eks_managed_node_group_id"           { value = module.eks.eks_managed_node_groups["voting-workers"].id }
```

---

## 7. Module: AWS Load Balancer Controller

`modules/ingress-alb/` — the **hand-written module**. It builds the IAM role bound to the controller via **IRSA (OIDC)**, then installs the controller Helm chart. This is the piece that turns our `Ingress` into a real ALB ("load balancer" requirement). Create the controller's IAM policy file:

**`modules/ingress-alb/main.tf`** — IRSA + helm release:
```hcl
variable "cluster_name" {}
variable "cluster_version" {}
variable "oidc_provider_arn" {}
variable "oidc_provider_url" {}
variable "region" {}
variable "vpc_id" {}

# The controller's AWS permissions — AWS publishes this policy:
# https://raw.githubusercontent.com/kubernetes-sigs/aws-load-balancer-controller/main/docs/install/iam_policy.json
data "http" "controller_iam_policy" {
  url = "https://raw.githubusercontent.com/kubernetes-sigs/aws-load-balancer-controller/v2.7.2/docs/install/iam_policy.json"
}

resource "aws_iam_policy" "lb_controller" {
  name   = "${var.cluster_name}-lb-controller"
  policy = data.http.controller_iam_policy.body
}

data "aws_iam_policy_document" "lb_controller_trust" {
  statement {
    actions = ["sts:AssumeRoleWithWebIdentity"]
    condition {
      test     = "StringEquals"
      variable = "${replace(var.oidc_provider_url, "https://", "")}:sub"
      values   = ["system:serviceaccount:kube-system:aws-load-balancer-controller"]
    }
    condition {
      test     = "StringEquals"
      variable = "${replace(var.oidc_provider_url, "https://", "")}:aud"
      values   = ["sts.amazonaws.com"]
    }
    principals {
      type        = "Federated"
      identifiers = [var.oidc_provider_arn]
    }
  }
}

resource "aws_iam_role" "lb_controller" {
  name               = "${var.cluster_name}-lb-controller"
  assume_role_policy = data.aws_iam_policy_document.lb_controller_trust.json
}
resource "aws_iam_role_policy_attachment" "lb_controller" {
  role       = aws_iam_role.lb_controller.name
  policy_arn = aws_iam_policy.lb_controller.arn
}

# The Helm release assumes kubectl/helm providers are wired (see §8.2) and that
# the cluster is up — hence no explicit provider here; order is handled by the
# root module's depends_on and the providers block.
resource "helm_release" "aws_load_balancer_controller" {
  name       = "aws-load-balancer-controller"
  namespace  = "kube-system"
  repository = "https://aws.github.io/eks-charts"
  chart      = "aws-load-balancer-controller"

  set {
    name  = "clusterName"
    value = var.cluster_name
  }
  set {
    name  = "region"
    value = var.region
  }
  set {
    name  = "vpcId"
    value = var.vpc_id
  }
  set {
    name  = "serviceAccount.name"
    value = "aws-load-balancer-controller"
  }
  set {
    name  = "serviceAccount.annotations.eks\\.amazonaws\\.com/role-arn"
    value = aws_iam_role.lb_controller.arn
  }
}

output "role_arn" { value = aws_iam_role.lb_controller.arn }
```

**`modules/ingress-alb/providers.tf`**
```hcl
terraform {
  required_providers {
    aws    = { source = "hashicorp/aws" }
    http   = { source = "hashicorp/http" }
    helm   = { source = "hashicorp/helm" }
  }
}
```

> Requires the `hashicorp/http` provider too — add it to root `providers.tf` (§8.2). The `data "http"` fetch keeps the IAM policy exactly aligned with AWS's published policy (no custom partial policy that silently under-permits the LB).

---

## 8. Root module wiring (`environments/dev`)

### 8.1 `backend.tf`
```hcl
terraform {
  backend "s3" {
    bucket       = "voting-tfstate-<ACCOUNT_ID>"   # from §3
    key          = "dev/eks/terraform.tfstate"
    region       = "us-east-1"
    encrypt      = true
    use_lockfile = true    # S3-native locking — no DynamoDB table (Terraform >= 1.10)
  }
}
```

### 8.2 `providers.tf`
```hcl
terraform {
  required_version = ">= 1.10"   # 1.10+ needed for S3 native locking (use_lockfile)
  required_providers {
    aws        = { source = "hashicorp/aws",       version = "~> 5.60" }
    http       = { source = "hashicorp/http",      version = "~> 3.4" }
    helm       = { source = "hashicorp/helm",      version = "~> 2.13" }
    kubernetes = { source = "hashicorp/kubernetes", version = "~> 2.30" }
  }
}

provider "aws" {
  region = var.region
}

# kubectl/helm talk to the cluster we just built, authenticating via AWS
# (this uses the aws eks get-token plugin — no static kubeconfig needed).
data "aws_eks_cluster_auth" "eks" {
  name = module.eks.cluster_name
}

provider "kubernetes" {
  host                   = module.eks.cluster_endpoint
  cluster_ca_certificate = base64decode(module.eks.cluster_certificate_authority_data)
  exec {
    api_version = "client.authentication.k8s.io/v1beta1"
    command     = "aws"
    args        = ["eks", "get-token", "--cluster-name", module.eks.cluster_name]
  }
}

provider "helm" {
  kubernetes {
    host                   = module.eks.cluster_endpoint
    cluster_ca_certificate = base64decode(module.eks.cluster_certificate_authority_data)
    exec {
      api_version = "client.authentication.k8s.io/v1beta1"
      command     = "aws"
      args        = ["eks", "get-token", "--cluster-name", module.eks.cluster_name]
    }
  }
}
```

### 8.3 `main.tf` (root module — wires modules in dependency order)
```hcl
module "vpc" {
  source = "../../modules/vpc"
  name   = var.cluster_name
  azs    = ["${var.region}a", "${var.region}b"]
  private_subnets = ["10.0.1.0/24", "10.0.2.0/24"]
  public_subnets  = ["10.0.101.0/24", "10.0.102.0/24"]
}

module "eks" {
  source          = "../../modules/eks"
  name            = var.cluster_name
  cluster_version = var.k8s_version
  vpc_id          = module.vpc.vpc_id
  private_subnets = module.vpc.private_subnets

  # user decisions with sensible defaults
  node_desired_size  = var.node_desired_size   # 2
  node_instance_type = var.node_instance_type  # t3.medium
}

module "ingress_alb" {
  source            = "../../modules/ingress-alb"
  cluster_name      = module.eks.cluster_name
  cluster_version   = module.eks.cluster_version
  oidc_provider_arn = module.eks.oidc_provider_arn
  oidc_provider_url = module.eks.oidc_provider_url
  region            = var.region
  vpc_id            = module.vpc.vpc_id

  depends_on = [module.eks]
}
```

### 8.4 `variables.tf`
```hcl
variable "region"              { default = "us-east-1" }
variable "cluster_name"        { default = "voting-eks" }
variable "k8s_version"         { default = "1.32" }        # ← set to newest supported (§1.3)
variable "node_desired_size"   { default = 2 }
variable "node_instance_type"  { default = "t3.medium" }
```

### 8.5 `terraform.tfvars`
```hcl
region             = "us-east-1"
cluster_name       = "voting-eks"
k8s_version        = "1.32"     # update to newest supported at apply time
node_desired_size  = 2          # "2 worker nodes"
node_instance_type = "t3.medium"
```

### 8.6 `outputs.tf`
```hcl
output "cluster_endpoint"    { value = module.eks.cluster_endpoint }
output "cluster_name"        { value = module.eks.cluster_name }
output "kubeconfig_cmd"      { value = "aws eks update-kubeconfig --name ${module.eks.cluster_name} --region ${var.region}" }
output "lb_controller_role"  { value = module.ingress_alb.role_arn }
```

---

## 9. terraform init / plan / apply

```bash
cd deploy/terraform/environments/dev
terraform init                          # downloads providers + modules, connects to S3 backend (prompts for backend bucket if not in backend.tf constants)
terraform plan -out plan.tfplan
```
Review the plan: expect ~40–60 resources (some count 80+ with the module internals) and the node group. Then apply **in stages** so failures are easy to locate:

```bash
# Stage A — network only
terraform apply -target=module.vpc -auto-approve

# Stage B — EKS control plane + node group + addons (nodes take 10–15 min)
terraform apply -target=module.eks -auto-approve

# Stage C — LB controller + IRSA (needs the cluster + OIDC first)
terraform apply -auto-approve
```

> First apply legitimately takes **~15–20 min** (EKS creates the control plane; the node group rosies up). Second apply onward is incremental. If anything errors, fix and re-apply — state is remote/locked, so it's safe.

---

## 10. Configure kubectl + verify

```bash
aws eks update-kubeconfig --region us-east-1 --name voting-eks
kubectl cluster-info
kubectl get nodes -o wide                     # expect 2 Ready, VERSION = your version
kubectl get pods -A                           # controller + coreDNS active
kubectl get svc -A                            # kube-dns present
kubectl get storageclass                      # gp2/gp3 default present (EBS driver addon)
```

> If `get nodes` shows only `NotReady` — see Troubleshooting §19. If the storageclass is missing, the `aws-ebs-csi-driver` addon didn't land; check `kubectl get pods -n kube-system | grep ebs`.

---

## 11. Namespace + registry pull secret

```bash
kubectl create namespace voting

# Docker Hub token = the Phase 2 access token (or your password). If the repo is
# public, skip this block; if private (free-tier default), do it before installing.
kubectl create secret docker-registry regcred \
  -n voting \
  --docker-server=https://index.docker.io/v1/ \
  --docker-username=sachinmaskar \
  --docker-password='<DOCKER_HUB_ACCESS_TOKEN>'
```

---

## 12. Helm chart: voting-app

Build a small chart for the app (this is the K8s side of "K8s + Helm" from the requirement doc). Create `deploy/helm/voting-app/`:

```
deploy/helm/voting-app/
├── Chart.yaml
├── values.yaml
└── templates/
    ├── _helpers.tpl
    ├── secret.yaml
    ├── postgres-statefulset.yaml  (+ svc)
    ├── redis-deployment.yaml      (+ svc)
    ├── backend-deployment.yaml    (+ needed svc)
    ├── frontend-deployment.yaml   (+ needed svc + configmap)
    ├── simulator-deployment.yaml
    └── ingress.yaml
```

### Chart.yaml
```yaml
apiVersion: v2
name: voting-app
description: Voting app (phase1 images) deployed to EKS behind an ALB ingress
version: 0.1.0
appVersion: "1.0"
```

### values.yaml
```yaml
namespace: voting
registrySecret: regcred          # from §11
imagePullPolicy: IfNotPresent

images:
  backend:      sachinmaskar/voting:backend
  frontend:     sachinmaskar/voting:frontend
  simulator:    sachinmaskar/voting:voter-simulator

backend:
  port: 3000
  dbUrl: postgres://vote:vote@postgres:5432/voting
  redisUrl: redis://redis:6379

frontend:
  port: 80

simulator:
  voteUrl: http://backend:3000/api/vote
  intervalMs: "2000"

ingress:
  enabled: true
  # ALB class → AWS Load Balancer Controller creates an internet-facing ALB
  class: alb
  scheme: internet-facing
  targetType: instance     # ALB targets the NodePorts
  healthcheckPath: /
  annotations:
    alb.ingress.kubernetes.io/load-balancer-name: voting-eks-alb
    alb.ingress.kubernetes.io/target-type: instance
```

### templates/_helpers.tpl
```yaml
{{- define "voting.labels" -}}
app.kubernetes.io/part-of: voting
{{- end -}}
```

### templates/secret.yaml
```yaml
apiVersion: v1
kind: Secret
metadata:
  name: voting-creds
  namespace: {{ .Values.namespace }}
type: Opaque
stringData:
  db-password: vote
  db-url:  {{ .Values.backend.dbUrl | quote }}
  redis-url: {{ .Values.backend.redisUrl | quote }}
```

### templates/postgres-statefulset.yaml
```yaml
apiVersion: v1
kind: Service
metadata:
  name: postgres
  namespace: {{ .Values.namespace }}
spec:
  clusterIP: None               # headless — stable DNS per pod
  selector: { app: postgres }
  ports: [{ port: 5432, targetPort: 5432 }]
---
apiVersion: apps/v1
kind: StatefulSet
metadata:
  name: postgres
  namespace: {{ .Values.namespace }}
spec:
  serviceName: postgres
  replicas: 1
  selector: { matchLabels: { app: postgres } }
  template:
    metadata:
      labels: { app: postgres, {{- include "voting.labels" . | nindent 8 }} }
    spec:
      imagePullSecrets: [{ name: {{ .Values.registrySecret }} }]
      containers:
      - name: postgres
        image: postgres:16-alpine
        ports: [{ containerPort: 5432, name: pg }]
        env:
        - { name: POSTGRES_USER,     value: vote }
        - { name: POSTGRES_PASSWORD, valueFrom: { secretKeyRef: { name: voting-creds, key: db-password } } }
        - { name: POSTGRES_DB,       value: voting }
        volumeMounts:
        - { name: data, mountPath: /var/lib/postgresql/data }
        readinessProbe:
          exec: { command: ["pg_isready","-U","vote","-d","voting"] }
      volumes:
      - name: data
        persistentVolumeClaim:
          claimName: postgres-data

---
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: postgres-data
  namespace: {{ .Values.namespace }}
spec:
  accessModes: [ReadWriteOnce]
  resources: { requests: { storage: 10Gi } }
  # default storageClass (gp3 via EBS CSI driver, set by EKS) — no claim needed
```

> The PVC uses EKS's default storage class (EBS `gp3`, WaitForFirstConsumer) → volume is created in the AZ of whatever node schedules the pod, and survives pod/node restarts. That is the durability requirement.

### templates/redis-deployment.yaml
```yaml
apiVersion: v1
kind: Service
metadata:
  name: redis
  namespace: {{ .Values.namespace }}
spec:
  selector: { app: redis }
  ports: [{ port: 6379, targetPort: 6379 }]
---
apiVersion: apps/v1
kind: Deployment
metadata: { name: redis, namespace: {{ .Values.namespace }} }
spec:
  replicas: 1
  selector: { matchLabels: { app: redis } }
  template:
    metadata: { labels: { app: redis, {{- include "voting.labels" . | nindent 8 }} } }
    spec:
      imagePullSecrets: [{ name: {{ .Values.registrySecret }} }]
      containers:
      - name: redis
        image: redis:7-alpine
        ports: [{ containerPort: 6379 }]
```

### templates/backend-deployment.yaml
```yaml
apiVersion: v1
kind: Service
metadata:
  name: backend
  namespace: {{ .Values.namespace }}
  annotations:
    alb.ingress.kubernetes.io/healthcheck-path: /healthz
spec:
  type: NodePort                 # NodePort → ALB can target it (target-type instance)
  selector: { app: backend }
  ports: [{ port: 3000, targetPort: 3000, nodePort: 30000 }]
---
apiVersion: apps/v1
kind: Deployment
metadata: { name: backend, namespace: {{ .Values.namespace }} }
spec:
  replicas: 2
  selector: { matchLabels: { app: backend } }
  template:
    metadata: { labels: { app: backend, {{- include "voting.labels" . | nindent 8 }} } }
    spec:
      imagePullSecrets: [{ name: {{ .Values.registrySecret }} }]
      containers:
      - name: backend
        image: {{ .Values.images.backend }}
        imagePullPolicy: {{ .Values.imagePullPolicy }}
        ports: [{ containerPort: {{ .Values.backend.port }} }]
        env:
        - { name: DATABASE_URL, valueFrom: { secretKeyRef: { name: voting-creds, key: db-url } } }
        - { name: REDIS_URL,    valueFrom: { secretKeyRef: { name: voting-creds, key: redis-url } } }
        - { name: PORT,         value: "{{ .Values.backend.port }}" }
        livenessProbe:
          httpGet: { path: /healthz, port: {{ .Values.backend.port }} }
          initialDelaySeconds: 10
        readinessProbe:
          httpGet: { path: /healthz, port: {{ .Values.backend.port }} }
```

### templates/frontend-deployment.yaml (+ nginx configmap)
```yaml
apiVersion: v1
kind: ConfigMap
metadata: { name: frontend-nginx, namespace: {{ .Values.namespace }} }
data:
  nginx.conf: |
    server {
      listen 80;
      server_name _;
      root /usr/share/nginx/html;
      index index.html;
      location /api/ {
        proxy_pass http://backend:3000;
        proxy_set_header Host $host;
      }
      location /healthz { return 200 "ok"; }
    }
---
apiVersion: v1
kind: Service
metadata:
  name: frontend
  namespace: {{ .Values.namespace }}
spec:
  type: NodePort
  selector: { app: frontend }
  ports: [{ port: 80, targetPort: 80, nodePort: 30080 }]
---
apiVersion: apps/v1
kind: Deployment
metadata: { name: frontend, namespace: {{ .Values.namespace }} }
spec:
  replicas: 2
  selector: { matchLabels: { app: frontend } }
  template:
    metadata: { labels: { app: frontend, {{- include "voting.labels" . | nindent 8 }} } }
    spec:
      imagePullSecrets: [{ name: {{ .Values.registrySecret }} }]
      containers:
      - name: frontend
        image: {{ .Values.images.frontend }}
        imagePullPolicy: {{ .Values.imagePullPolicy }}
        ports: [{ containerPort: 80 }]
        volumeMounts:
        - { name: conf, mountPath: /etc/nginx/conf.d/default.conf, subPath: nginx.conf }
      volumes:
      - name: conf
        configMap: { name: frontend-nginx }
```

### templates/simulator-deployment.yaml
```yaml
apiVersion: v1
kind: Deployment
metadata: { name: simulator, namespace: {{ .Values.namespace }} }
spec:
  replicas: 1
  selector: { matchLabels: { app: simulator } }
  template:
    metadata: { labels: { app: simulator, {{- include "voting.labels" . | nindent 8 }} } }
    spec:
      imagePullSecrets: [{ name: {{ .Values.registrySecret }} }]
      containers:
      - name: simulator
        image: {{ .Values.images.simulator }}
        env:
        - { name: VOTE_URL,        value: {{ .Values.simulator.voteUrl | quote }} }
        - { name: VOTE_INTERVAL_MS, value: {{ .Values.simulator.intervalMs | quote }} }
```

### templates/ingress.yaml
```yaml
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: voting
  namespace: {{ .Values.namespace }}
  annotations:
    kubernetes.io/ingress.class: alb                     # AWS LB Controller owns this
    alb.ingress.kubernetes.io/scheme: {{ .Values.ingress.scheme }}
    alb.ingress.kubernetes.io/target-type: {{ .Values.ingress.targetType }}  # instance → NodePorts
    alb.ingress.kubernetes.io/healthcheck-path: {{ .Values.ingress.healthcheckPath }}
    alb.ingress.kubernetes.io/load-balancer-name: {{ .Values.ingress.annotations.alb.ingress.kubernetes.io/load-balancer-name | nindent 4 }}
spec:
  ingressClassName: alb
  rules:
  - http:
      paths:
      - path: /
        pathType: Prefix
        backend:
          service:
            name: frontend
            port: { number: 80 }
      - path: /api
        pathType: Prefix
        backend:
          service:
            name: frontend       # nginx proxies /api → backend:3000 (same as compose)
            port: { number: 80 }
```

> The Ingress is the single object that makes the **load balancer** appear. AWS LB Controller reads it, provisions an internet-facing **ALB**, wires listeners → target groups → NodePorts (30000/30080) → pods. There is no `LoadBalancer` Service here by design — that's the ALB-vs-Service distinction the requirement doc calls out.

---

## 13. Install the chart + verify pods

```bash
cd deploy/helm
helm lint voting-app
helm install voting-app ./voting-app --namespace voting --create-namespace

kubectl get all -n voting
kubectl get pods -n voting -w          # watch to Running/Ready
kubectl logs -n voting deploy/simulator   # votes flowing: "vote lions..."
```

Expected workload list: `postgres-0` (StatefulSet), `redis-*`, `backend-*` ×2, `frontend-*` ×2, `simulator-*`.

If pods stay `ImagePullBackOff` → the pull secret (§11) is missing/wrong — check `kubectl describe pod <pod> -n voting` and §19.

---

## 14. Ingress → ALB: verify

```bash
kubectl get ingress -n voting
# NAME     CLASS   HOSTS   ADDRESS
# voting   alb     *       voting-eks-alb-<random>.elb.amazonaws.com
```
The `ADDRESS` is your ALB DNS. Smoke test end to end:
```bash
ALB=$(kubectl get ingress -n voting -o jsonpath='{.items[0].status.loadBalancer.hostname}')
curl -s  http://$ALB/healthz             # ok (proxied path)
curl -s  http://$ALB/api/results         # {"lion":N,"tiger":N,...}
curl -is -X POST http://$ALB/api/vote -H 'Content-Type: application/json' -d '{"animal":"lion"}' | head -1   # 201
curl -is -X POST http://$ALB/api/vote -H 'Content-Type: application/json' -d '{"animal":"moose"}' | head -1  # 400
```
The Azure VM is headless (no browser) — the ALB is **public-internet-facing**, so open these from **your own workstation browser** (Windows/macOS/Linux) — just copy the `$ALB` URL printed by the `kubectl get ingress` output above and paste it into any browser on your laptop:
```
http://<ALB-HOSTNAME>/               # vote page
http://<ALB-HOSTNAME>/admin.html     # admin results chart
```
`$ALB` is an environment variable set inside the SSH session — it won't exist in your local shell, so use the literal hostname (e.g. `voting-eks-alb-1234567890.us-east-1.elb.amazonaws.com`) in the browser. Alternatives if you only have the SSH terminal: `curl -s http://$ALB/ | head`, then the vote page HTML is the same Phase-1 static page.

> **Where the load balancer lives:** AWS Console → EC2 → Load Balancers → `voting-eks-alb`. Its target group shows the two worker node IPs hitting NodePort 30080. That's your ingress/LB proof.

---

## 15. Data persistence check

```bash
# inject a vote, then bounce Postgres — data must survive
curl -s -X POST http://$ALB/api/vote -H 'Content-Type: application/json' -d '{"animal":"dog"}'

kubectl delete pod -n voting postgres-0     # StatefulSet recreates it on a node
kubectl wait --for=condition=Ready pod/postgres-0 -n voting --timeout=180s
kubectl exec -it -n voting postgres-0 -- psql -U vote -d voting -c 'select animal,count(*) from votes group by animal;'
```
The counts (including the pre-delete vote) survive → PVC+EBS durability proven. Also confirm `kubectl get pvc -n voting` shows `Bound`.

---

## 16. EKS upgrade, step by step

> Rule: **one minor version at a time**; AWS does **not** roll back/downgrade. Before starting: back up Postgres data and pick a maintenance window.

**0. Pre-checks & backup**
```bash
kubectl get nodes -o wide                     # record current version + node names
kubectl version                               # client vs server (always client >= server)
# backup Postgres data (PG 13+):
kubectl exec -it -n voting postgres-0 -- pg_dump -U vote -d voting > /tmp/voting-$(date +%F).sql
```
Review deprecated APIs that could break: `kubectl api-resources --api-group=...` (our simple workloads + controller chart are the risk surface; EKS trigger alerts on deprecated APIs during the upgrade).

**1. Control plane** (Scales you prepared — control-plane step briefly interrupts API)
```bash
terraform apply -var="k8s_version=1.33"        # bump by ONE minor from current
# or, via CLI (must match what terraform expects or keep tidy by using terraform only):
aws eks update-cluster-version --name voting-eks --kubernetes-version 1.33
```
Watch cluster status: `aws eks describe-cluster --name voting-eks --query 'cluster.status'` → `UPDATING` → `ACTIVE`.

**2. Addons** — bring them to the new version (they don't auto-bump):
```bash
eksctl upgrade addons --cluster voting-eks        # or per-addon in terraform: bump most_recent
kubectl get pods -n kube-system                   # coredns/kube-proxy/vpc-cni/ebs-csi healthy again
```

**3. Worker node group** — roll the nodes to the new K8s node version (one node at a time, no downtime for our 2-replica set; Postgres single-replica will restart):
```bash
eksctl upgrade nodegroup --cluster voting-eks --name voting-workers --kubernetes-version 1.33
# or simply update the desired AMI/version in the module & terraform apply (module uses same AMI-family tag)
kubectl get nodes -o wide    # show NotReady → Ready as each node cycles
```

**4. Verify the app after upgrade**
```bash
kubectl get nodes -o wide                        # all Ready, new version
kubectl get pods -n voting                       # all Ready
curl -s http://$ALB/healthz && curl -s http://$ALB/api/results     # app fine
kubectl exec -it -n voting postgres-0 -- psql -U vote -d voting -c 'select count(*) from votes;'
```
If anything regressed: restore from the `/tmp/voting-*.sql` dump onto a fresh Postgres pod (downgrade isn't possible — the dump is your only rollback), or revert to the previous chart/state and redeploy on the new cluster version.

**5. Refresh docs** — update `EKS_requirement.md`/`EKS_guide.md` version placeholders to the new version, and re-run a full smoke test. This completes the **EKS upgrade requirement**.

---

## 17. Everyday ops snippets

```bash
kubectl get svc -n voting                       # ports & clusterIPs
kubectl rollout restart deployment/backend -n voting
kubectl scale deployment/simulator -n voting --replicas=0     # stop injected traffic
kubectl logs -f -n voting deployment/backend
kubectl drain <node> --ignore-daemonsets --delete-emptydir-data   # put a worker in maintenance
kubectl get events -n voting --sort-by=.lastTimestamp
helm list -n voting                            # see release + revision
helm upgrade voting-app ./voting-app -n voting --reuse-values   # iterate
```

---

## 18. Cost control & cleanup

**Pause (keep the cluster, stop bleeding):**
```bash
eksctl scale nodegroup --cluster voting-eks --name voting-workers --nodes 0 --nodes-min 0 --nodes-max 0
# or terraform apply -var="node_desired_size=0" (control plane still bills)
```

**Full destroy (the reliable stop):**
```bash
cd deploy/terraform/environments/dev
terraform destroy -auto-approve
```
Expect the ALB to go away before/with nodes; give the LB another minute if destroy reports lingering dependencies — re-run destroy. Postgres PVC and data are removed with the cluster by design; pull the pod dump first if you want to keep data.

**Left by design (keep):** the S3 state bucket + versioning (§3) — it costs ~nothing and is your state home (no DynamoDB table exists to clean up — locking is native to S3). Everything else should be gone: check EC2 → Load Balancers/Target groups, EBS volumes, NAT gateway, EKS clusters are all deleted. Re-run `aws budgets describe-budgets` to see spend history.

---

## 19. Troubleshooting

| Symptom | Likely cause / fix |
|---|---|
| `kubectl get nodes` → `NotReady` | Node group still booting (wait 10 min); or EBS CSI driver absent → add `aws-ebs-csi-driver` addon (module §6) and wait for it `Active` |
| Pod `ImagePullBackOff` / `ErrImagePull` | Registry secret missing/wrong (§11) — `kubectl describe pod -n voting <pod>`; re-create `regcred` with correct token; if repo now public, remove `imagePullSecrets` |
| Backend `CrashLoopBackOff` | Postgres not ready/secret env wrong — `kubectl logs -n voting deploy/backend`; verify `postgres` service DNS & `voting-creds` |
| `/healthz` 503 | app up but Redis down (healthz = degraded if db OR redis down) — check `redis` pod; Redis is optional for votes, but healthz reflects it |
| Ingress created but no ADDRESS | LB controller not deployed / IRSA role wrong → `kubectl get pods -n kube-system | grep controller`, `kubectl logs -n kube-system deploy/aws-load-balancer-controller`; verify OIDC provider & `aws_iam_policy` name |
| ALB says `target unhealthy` | healthcheck path wrong / NodePort not matching ingress target → verify `alb.ingress.kubernetes.io/healthcheck-path: /` + frontend svc NodePort 30080; curl node IP:30080 from a worker |
| `terraform destroy` hangs on ALB | LB takes ~1 min to deregister; re-run destroy once |
| `terraform` says S3 lock held | another `apply` in-flight, or a stale `.tflock` object → `terraform force-unlock <id>` (from the error) only after confirming nothing else runs; with `use_lockfile`, delete the lock object in S3 only if it is provably stale |
| Access denied to S3 backend | IAM user missing `s3:GetObject`/`s3:PutObject`/`s3:DeleteObject` on `voting-tfstate-*/dev/eks/*` and the bucket-level perm — add the minimal S3 policy (only S3; no DynamoDB is used) |

---

## 20. Phase 3 checklist + handoff to Phase 4

**Session map (1-hour sessions):**
- **Session 3a (this phase start):** §1 tools, §2 account+budget, §3 backend, §4–§8 scaffolding + code, §9 `terraform init/apply` → cluster + 2 nodes. Stop here = cluster is up, kubectl works.
- **Session 3b:** §11–§14 chart install + ALB verification (the "wow" moment: `curl http://$ALB/admin.html`).
- **Session 3c:** §15 persistence, §16 upgrade demo (optional), §17 ops, §18 destroy hygiene, update README/`EKS_requirement` version notes.

**Checklist — Phase 3 complete when:**
- [ ] `terraform apply` builds VPC + EKS + **2 worker nodes** from remote S3 state (locking on) — §9
- [ ] `kubectl get nodes` → 2× Ready on chosen version — §10
- [ ] EBS CSI + core addons `ACTIVE`; default storage class present — §10
- [ ] AWS LB Controller deployed via IRSA; Ingress provokes an internet-facing ALB — §7/§14
- [ ] Helm chart installed; all 5 workloads `Running/Ready` from `sachinmaskar/voting` images — §13
- [ ] End-to-end at `http://$ALB`: vote → 201, results JSON, admin page chart, healthz 200 — §14
- [ ] Postgres survives pod/node restart (PVC) — §15
- [ ] Upgrade procedure documented (+ optionally demoed one minor version) — §16
- [ ] Cost guardrail: budget alarm set, destroy run, no stray AWS resources — §2.3/§18

**Handoff to Phase 4 (observability):** `/metrics` is already exposed on the backend (Prometheus scrape target), so Phase 4 is: Prometheus+Grafana (dashboards), node/postgres exporters, Loki+Promtail logs, Alertmanager rules — now scoped to the EKS cluster. Update `README.md`'s status header once Phase 3 is verified (that edit is intentionally *not* made by this guide's steps).
