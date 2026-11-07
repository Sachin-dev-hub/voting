# Voting Application — Architecture

An end-to-end DevOps project: **code → CI/CD → deployment → monitoring**.
The application itself is intentionally simple — the real deliverable is the delivery and observability pipeline around it.

## ⚡ Current Status — Session Handoff

> **Workflow:** Claude sessions are 1 hour long. This section is the handoff — read it first to resume work. Latest session date: **Session 1**.

- **Phase 1 — App: ✅ CODE BUILT, ⏳ NOT YET VERIFIED**
  - Built: `backend/` (Node.js + Express — `/api/vote`, `/api/results`, `/healthz`, `/metrics`), `frontend/` (Nginx — vote page `/` + admin results `/admin.html`), `voter-simulator/` (random vote every 2s), `docker-compose.yml`, `Makefile`, `POC_GUIDE.md`.
  - **NEXT ACTION (on my Ubuntu machine):** `make build && make up && make verify`, then open `http://localhost:8080` and `http://localhost:8080/admin.html`. Full runbook + troubleshooting: **`POC_GUIDE.md`**.
  - Note: frontend is **static HTML/JS** for now (no React build) — keeps the POC verifiable with zero build tooling. React+Vite can replace it later.
- **Phase 2 — CI/CD: ⏳ NOT STARTED** — Jenkins (declarative `Jenkinsfile`) + SonarQube quality gate + Trivy image scan. *(Wait until Phase 1 is verified.)*
- **Phase 3 — Deploy: ⏳ DEFERRED BY USER** — Terraform → AWS EKS + Helm chart. Explicitly paused; do NOT start until the app is verified.
- **Not yet in repo:** `deploy/` (terraform/helm/k8s), `monitoring/`, `Jenkinsfile`, `sonar-project.properties` — all belong to future phases.

---

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
| **CI/CD**     | **Jenkins**                               | Declarative `Jenkinsfile`: lint → test → build/push images (GHCR) → deploy |
| **Code Quality** | **SonarQube**                         | Static analysis (bugs, vulnerabilities, code smells, coverage) + quality gate in CI |
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

## 5. Repository Layout

```
voting-app/
├── backend/             # ✅ Node.js + Express API (Dockerfile) — DONE
├── frontend/            # ✅ Nginx + static HTML/JS pages (Dockerfile) — DONE
├── voter-simulator/     # ✅ random-vote traffic generator (Dockerfile) — DONE
├── docker-compose.yml   # ✅ local dev stack — DONE
├── Makefile             # ✅ build/up/down/ps/logs/verify/clean — DONE
├── POC_GUIDE.md         # ✅ runbook for verifying the app on Ubuntu — DONE
├── deploy/              # ⏳ future — k8s/, helm/voting-app/, terraform/ (Phase 3)
├── monitoring/          # ⏳ future — prometheus.yml, grafana/, alerts/ (Phase 4)
├── Jenkinsfile          # ⏳ future — Jenkins declarative pipeline (Phase 2)
└── sonar-project.properties  # ⏳ future — SonarQube config (Phase 2)

---

## 6. DevOps Pipeline (the actual focus)

### 6.1 CI/CD (Jenkins, triggers on commits to `main`)
```
Jenkinsfile (declarative):
lint → unit/integration tests → SonarQube analysis + quality gate → docker build & push (:latest + :sha)
   → Trivy image scan → deploy to staging (auto) → prod (manual approval)
```
- **Trigger:** Jenkins polls / webhooks on commits to `main`.
- **Registry:** GHCR/DockerHub/private, images tagged `:latest` + `:sha`.
- **Code scanning:** **SonarQube** static analysis — bugs, vulnerabilities, code smells, and test coverage; the **quality gate** must pass before the image is built/pushed (failing the gate fails the build).
- **Security gate:** Trivy/docker image vulnerability scan before any deploy.
- **Deploy:** staging auto after merge to `main`; production gated by approval/tag.

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

## 7. Make Targets / Tooling

Implemented in the repo `Makefile` (Phase 1): `make build`, `make up`, `make down`, `make ps`, `make logs <svc>`, `make verify`, `make clean`.
Future phases add: `make test`, `make lint`, `make deploy-staging`, `make deploy-prod`, `make observability-up` — mapping to the Docker/Helm/Terraform commands above.

---

## Roadmap

1. **Phase 1 — App:** ✅ **code built** (backend, frontend, simulator, compose, Makefile) — ⏳ **pending verification** on the user's Ubuntu machine (`make build && make up && make verify`). *(Frontend is static HTML/JS for now; can swap to React+Vite later.)*
2. **Phase 2 — CI/CD:** ⏳ **next** — Jenkins (declarative `Jenkinsfile`) pipeline building + publishing images, with **SonarQube** code quality gate.
3. **Phase 3 — Deploy:** ⏳ deferred — Helm chart → staging/prod K8s, Terraform for infra (AWS EKS). **Explicitly paused until Phase 1 verified.**
4. **Phase 4 — Observe:** ⏳ — Prometheus/Grafana/Loki + alerts; dashboards for every service.
