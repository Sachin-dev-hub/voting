# POC Guide — Voting App on Ubuntu (Docker)

This file is the POC roadmap. The goal: **verify the voting app actually works on your
Ubuntu machine before we touch CI/CD, EKS, or Terraform.**

## Order of work

1. **Phase 1 (✅ done)** — build the voting app + run it locally with Docker Compose. **Verified on the Ubuntu machine.**
2. **Phase 2 (current — not built yet)** — Jenkins CI/CD (build + push images) + SonarQube code scan. Plan: `CICD_guide.md`.
3. **Phase 3** — only after Phase 2: deploy to AWS EKS with Terraform.

> Phase 1 is complete and verified. Next up is Phase 2 (CI/CD). Do not go ahead of what's verified.

---

## Phase 1 — Run and verify the app

### Prerequisites (Ubuntu)

- Docker Engine installed
- Docker Compose plugin installed

Check both:

```bash
docker version
docker compose version
```

If `docker compose` (with a space) fails, install the plugin:
`sudo apt-get install -y docker-compose-plugin`

### Build and start the stack

```bash
cd voting-app            # this project folder
apt install make -y
make build               # docker compose build
make up                  # docker compose up -d
make ps                  # docker compose ps  -> all 5 services should be Up (healthy)
```

### What should be running

| Service     | What it is                |
|-------------|---------------------------|
| `db`        | PostgreSQL (source of truth) |
| `redis`     | Redis (vote buffer)       |
| `backend`   | Node.js API on :3000      |
| `frontend`  | Nginx on :8080 (vote + admin pages) |
| `simulator` | Posts a random vote every 2s |

### Verify it works

**1. Backend health** (expect `{"status":"ok","db":"up","redis":"up"}`):

```bash
curl -s http://localhost:3000/healthz
```

**2. Voting API** (each returns `201`):

```bash
curl -s -X POST http://localhost:3000/api/vote -H 'Content-Type: application/json' -d '{"animal":"lion"}'
curl -s -X POST http://localhost:3000/api/vote -H 'Content-Type: application/json' -d '{"animal":"tiger"}'
```

**3. Results** (counts go up as you vote / as the simulator votes):

```bash
curl -s http://localhost:3000/api/results
```

**4. Browser** — open:

- Vote page:  http://localhost:8080
- Admin page: http://localhost:8080/admin.html  (live results, auto-refreshes)

Click the animal buttons, then watch the admin page counts increase.

**5. Simulator logs** (should show a vote every 2s):

```bash
make logs simulator
```

**6. Metrics** (Prometheus endpoint, used later for monitoring):

```bash
curl -s http://localhost:3000/metrics | grep votes_total
```

### Success criteria

- All 5 services show **Up/healthy** in `make ps`
- `/healthz` returns `db: up, redis: up`
- `POST /api/vote` returns `201`, invalid animal returns `400`
- `GET /api/results` counts increase over time
- Vote page + admin page load in the browser and show live voting

If all of that works → **tell me, and we move to Phase 2 (CI/CD).**

### Troubleshooting

| Symptom                                | Fix                                   |
|----------------------------------------|---------------------------------------|
| `backend` not healthy / CrashLoop      | `make logs backend` — usually DB not ready yet, it retries on restart |
| Port 8080 or 3000 already in use       | Change the port in `docker-compose.yml` |
| `docker compose` not found             | Install the compose plugin (see above) |
| Votes not appearing on admin page      | Open `http://localhost:8080/admin.html` (not just `/`) and wait ~3s for refresh |

### Cleanup

```bash
make down    # stop the stack (keeps data)
make clean   # stop AND delete the database volume (fresh start)
```

---

## What's next (Phase 1 is verified ✅)

Phase 2 — Jenkins pipeline (Jenkinsfile) + SonarQube: lint → tests → SonarQube quality gate → build & push images → Trivy scan. Full plan + suggestions: `CICD_guide.md`.
Phase 3 — Terraform → AWS EKS: cluster + node group, then deploy this same app via Helm.

(Phase 2 is a plan only so far — implementation starts when you're ready. Don't touch Phase 3 until Phase 2 is verified.)
