# Voting Application — Architecture

An end-to-end DevOps project: **code → CI/CD → deployment → monitoring**.
The application itself is intentionally simple — the real deliverable is the delivery and observability pipeline around it.

## Requirements

- Users can vote for one of **Lion, Tiger, Dog, Cat**
- **Voters are random** (simulated traffic; no login/signup)
- An **admin** can view live results

---

## 1. High-Level Architecture

```
                 ┌──────────────────────────────────────┐
                 │            Frontend (Web)            │
                 │   React SPA served by Nginx          │
                 │   ┌────────────┐  ┌──────────────┐   │
                 │   │ /vote      │  │ /admin       │   │
                 │   │ voting UI  │  │ results view │   │
                 │   └────────────┘  └──────────────┘   │
                 └───────────────────┬──────────────────┘
                                     │  /api/* (reverse-proxied by Nginx,
                                     │   same-origin, no CORS)
                 ┌───────────────────▼──────────────────┐
                 │            Backend API               │
                 │   Node.js + Express (TypeScript)     │
                 │   POST /api/vote    → write vote      │
                 │   GET  /api/results → aggregate       │
                 │   GET  /metrics     → Prometheus      │
                 └────────────┬────────────────┬─────────┘
                             │                │
                     writes  │                │  reads
                 ┌───────────▼──────┐   ┌─────▼───────────────┐
                 │      Redis       │   │     PostgreSQL      │
                 │ vote buffer /    │   │ votes + results     │
                 │ rate limiting    │   │ (source of truth)   │
                 └──────────────────┘   └─────────────────────┘

      ┌─────────────────────┐        ┌──────────────────────────────┐
      │  Voter Simulator    │        │  Observability (per-cluster) │
      │  posts a random     │        │  Prometheus + Grafana        │
      │  vote every N sec   │        │  Node/Postgres exporters     │
      │  (k6 / custom Go)   │        │  Loki (logs) + Alertmanager  │
      └─────────────────────┘        └──────────────────────────────┘
```

**Request flow (user vote):**
1. Browser (Nginx) → `POST /api/vote` `{animal: "lion"}` → backend validates & writes to Redis buffer → worker/backend persists to PostgreSQL.
2. `GET /api/results` reads aggregated counts from PostgreSQL and returns JSON (e.g. `{lion: 12, tiger: 9, dog: 7, cat: 15}`).
3. Admin page polls `/api/results` every few seconds and renders a live chart.

---

## 2. Technology Choices

| Layer         | Choice                                  | Why                                                     |
|---------------|------------------------------------------|----------------------------------------------------------|
| **Frontend**  | React + Vite + TypeScript, served by **Nginx** | Mainstream, tiny image via multi-stage build; Nginx also reverse-proxies `/api` (no CORS complexity) |
| **Backend**   | **Node.js + Express** (TypeScript)        | Simple REST API, first-class Prometheus libs (`prom-client`), small containers |
| **Database**  | **PostgreSQL**                            | Reliable source of truth, aggregates votes, standard in K8s ops |
| **Cache**     | **Redis**                                 | Vote buffer + rate limiting; classic demo of an in-memory tier |
| **Voter sim** | **k6** (or tiny Go/Node script)           | Generates realistic random traffic for load + monitoring demo |
| **CI/CD**     | **GitHub Actions**                        | Lint → test → build/push images (GHCR) → deploy            |
| **IaC**       | **Terraform** (optional)                  | Provision cloud infra / managed K8s                        |
| **Orchestration** | **Docker Compose** (dev) → **Kubernetes + Helm** (prod) | Same image, dev→prod parity |
| **Monitoring**| **Prometheus + Grafana**                  | Metrics + dashboards; Node & Postgres exporters, Alertmanager |
| **Logging**   | **Loki + Promtail**                       | Logs in Grafana (keeps stack single-vendor)               |

> Backend alternatives (equally fine): Python **FastAPI** or **Go**. I recommend **Node.js/Express** here only because it shares TypeScript with the frontend and keeps the repo single-language. Swap the `backend/` scaffold and the `Dockerfile` — nothing else in the pipeline changes.

---

## 3. REST API

| Method | Path            | Auth | Body / Response                                   |
|--------|-----------------|------|---------------------------------------------------|
| POST   | `/api/vote`     | —    | `{"animal": "lion"}` → `201`                      |
| GET    | `/api/results`  | —    | `{"lion": 12, "tiger": 9, "dog": 7, "cat": 15}`   |
| GET    | `/healthz`      | —    | `200` liveness probe                              |
| GET    | `/metrics`      | —    | Prometheus text exposition (scraped by Prometheus)|

Validation: `animal` must be one of `lion | tiger | dog | cat`, else `400`.

## 4. Data Model (PostgreSQL)

```sql
CREATE TABLE votes (
  id         BIGSERIAL PRIMARY KEY,
  animal     TEXT NOT NULL CHECK (animal IN ('lion','tiger','dog','cat')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

- Results = `SELECT animal, count(*) FROM votes GROUP BY animal` (optionally cache the aggregate in Redis and invalidate on insert).

---

## 5. Repository Layout (planned)

```
voting-app/
├── frontend/            # React + Vite SPA (Dockerfile → Nginx)
├── backend/             # Node.js + Express API (Dockerfile)
├── voter-simulator/     # random-vote traffic generator (k6 or script)
├── deploy/
│   ├── docker-compose.yml      # local dev stack
│   ├── k8s/                     # raw manifests
│   ├── helm/voting-app/         # Helm chart (prod)
│   └── terraform/               # cloud provisioning (optional)
├── monitoring/
│   ├── prometheus.yml
│   ├── grafana/dashboards/
│   └── alerts/
└── .github/workflows/  # CI/CD pipeline
```

---

## 6. DevOps Pipeline (the actual focus)

### 6.1 CI/CD (GitHub Actions, on push/PR to `main`)
```
lint → unit/integration tests → docker build & push (GHCR, :latest + :sha)
   → helm template (validate) → deploy to staging (auto) → prod (manual/approval)
```
- Trivy/`docker scan` image vulnerability check before deploy.
- Staging deploy auto after merge; production deploy gated by approval or tag.

### 6.2 Deployment
- **Dev:** `docker compose up --build` — one command, full stack.
- **Prod:** Kubernetes + Helm chart (deployments, services, ingress, PVC for Postgres, `Secrets` for DB credentials). Terraform manages the cluster/cloud resources.
- Health checks wired to K8s probes (`/healthz` → liveness+readiness).

### 6.3 Monitoring & Alerts
- **Metrics:** backend `/metrics`, Node Exporter, Postgres Exporter → Prometheus → Grafana dashboards (vote throughput, error rate, latency, DB load).
- **Logs:** Promtail → Loki → explore in Grafana.
- **Alerts (Alertmanager):** e.g. `vote_error_rate > 5% for 5m`, `pod CrashLoopBackOff`, `Postgres down`, `high CPU/memory`.

### 6.4 Environments
| Env      | Target               | Trigger       | Monitoring |
|----------|----------------------|---------------|------------|
| Local    | Docker Compose       | `make up`     | Grafana (docker) |
| Staging  | K8s namespace / cluster | merge to main | full observability stack |
| Prod     | K8s (EKS/GKE/AKS)    | release tag   | full stack + paging alerts |

---

## 7. Make Targets / Tooling (will be added with the scaffold)

`make build`, `make up`, `make down`, `make test`, `make lint`, `make deploy-staging`,
`make deploy-prod`, `make observability-up` — each maps to the Docker/Helm/Terraform commands above.
*(README is the design blueprint; commands land in the repo as the scaffold is created.)*

---

## Roadmap

1. **Phase 1 — App:** scaffold frontend, backend, DB schema; `docker compose` works locally.
2. **Phase 2 — CI/CD:** GitHub Actions pipeline building + publishing images.
3. **Phase 3 — Deploy:** Helm chart → staging/prod K8s, Terraform for infra.
4. **Phase 4 — Observe:** Prometheus/Grafana/Loki + alerts; dashboards for every service.
