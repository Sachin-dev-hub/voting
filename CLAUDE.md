# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project focus

An end-to-end DevOps project (code → CI/CD → deployment → monitoring). The application itself is intentionally simple; the real deliverable is the delivery/observability pipeline around it.

**Phase status (read first):**
- **Phase 1 — App: ✅ complete and verified** on the user's machine. `make build && make up && make verify` confirmed: all 5 services healthy, votes persist, results render. Runbook: `POC_GUIDE.md`.
- **Phase 2 — CI/CD (Jenkins + SonarQube + Trivy): current phase, not started.** Plan + suggested pipeline (Jenkinsfile skeleton, GHCR tagging, Trivy scan, credentials): `CICD_guide.md`.
- **Phase 3 — Deploy (Terraform → AWS EKS + Helm): deferred by user until Phase 2 is verified.**
- **Phase 4 — Observability (Prometheus/Grafana/Loki): not started.**

Current work: implement the Phase 2 pipeline from `CICD_guide.md`. Future-phase artifacts (`deploy/`, `monitoring/`, `Jenkinsfile`, `sonar-project.properties`) intentionally do not exist yet.

## Common commands

Everything runs through Docker Compose (no local toolchain needed):

```bash
make build        # docker compose build all images
make up           # docker compose up -d (db, redis, backend, frontend, simulator)
make ps           # show service status (all 5 should be Up/healthy)
make logs <svc>   # tail logs, e.g. `make logs backend` or `make logs simulator`
make verify       # curl healthz + results + post one vote
make down         # stop stack, keep pg volume
make clean        # stop AND delete pg volume (fresh start)
```

Manual verification (backend is on :3000, frontend on :8080):

```bash
curl -s http://localhost:3000/healthz                 # {"status":"ok","db":"up","redis":"up"}
curl -s -X POST http://localhost:3000/api/vote -H 'Content-Type: application/json' -d '{"animal":"lion"}'   # 201
curl -s -X POST http://localhost:3000/api/vote -H 'Content-Type: application/json' -d '{"animal":"moose"}'  # 400
curl -s http://localhost:3000/api/results              # {"lion":N,"tiger":N,"dog":N,"cat":N}
curl -s http://localhost:3000/metrics | grep votes_total
```

There are no unit tests, linter config, or test commands yet — these belong to Phase 2. `backend/package.json` has only a `start` script.

## Architecture

Five services, defined in `docker-compose.yml`:

```
frontend (Nginx :8080) ──/api/* reverse-proxy──▶ backend (Node/Express :3000) ──▶ db (Postgres 16)
                                                       │                           ▲
                                               vote + Redis buffer              source of truth
simulator (random vote every 2s) ──────────────────┘
```

- **db** — Postgres 16, credentials `vote:vote@db:5432/voting` (hardcoded in compose and as backend defaults). Single table `votes (id BIGSERIAL, animal CHECK (lion|tiger|dog|cat), created_at)`. The schema is auto-created by `ensureSchema()` in `backend/src/db.js` on backend startup.
- **backend** — Node 20 + Express, **ESM** (`"type": "module"`). Env vars: `DATABASE_URL`, `REDIS_URL`, `PORT`. Endpoints: `POST /api/vote`, `GET /api/results`, `GET /healthz`, `GET /metrics` (prom-client counter `votes_total` by animal).
- **frontend** — Nginx serving static `index.html` (vote page) and `admin.html` (results chart, polls `/api/results` every 3s). Nginx also **reverse-proxies `/api/` to `backend:3000`**, so the browser always uses same-origin requests and there is no CORS. Static HTML/JS by deliberate choice (zero build tooling for the POC) — README notes React+Vite can replace it later.
- **simulator** — posts one random vote (`lion|tiger|dog|cat`) every 2s. Env vars: `VOTE_URL`, `VOTE_INTERVAL_MS`. Restarts itself if the backend is down (`restart: unless-stopped` + `depends_on: service_healthy`).

## Gotchas and non-obvious details

- **Vote flow is NOT buffer-first.** Despite the README's architecture diagram describing a write-to-Redis-then-persist flow, `POST /api/vote` writes directly to Postgres and pushes to the Redis buffer (`votes:buffer`, TTL 1h) as a second, best-effort step. Redis holds a recent-votes buffer only; it does not back `/api/results` (results are a Postgres `GROUP BY`). The README's Redis "rate limiting" role is aspirational and **not implemented**.
- **Redis is optional at runtime.** `backend/src/redis.js` sets `maxRetriesPerRequest: 1` and swallows buffer-write errors, so a down Redis never fails a vote. A down Postgres does (vote → 500).
- **`/healthz` returns 503** (status `degraded`) if either DB or Redis is unreachable — this drives the compose healthcheck and the eventual K8s probes.
- The backend has no `npm install` step locally — packages are installed inside the Docker image (`npm install --omit=dev`). Don't expect a `node_modules/` on the host.
- `make logs` is implemented via `$(filter-out $@,$(MAKECMDGOALS))` and expects the service name as the next arg.
