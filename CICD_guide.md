# CI/CD Guide — Phase 2 (Jenkins + SonarQube + Trivy)

> Predecessor: `POC_GUIDE.md` (Phase 1 — ✅ verified). This file is the **plan/suggestion** for Phase 2 — the current phase. Implementation starts now; see the deliverables checklist in §9.
>
> Requirement source: `requirement` + README §6.1. Stack constraints from the user: **Jenkins** (declarative pipeline), **SonarQube** (quality gate), **Trivy** (image security scan). Target registry is GitHub, so GHCR is recommended below.

---

## 1. Goals of Phase 2

1. Every commit to `main` triggers a Jenkins pipeline.
2. Code is statically analyzed by SonarQube; a failing **quality gate blocks** the build.
3. Images are built, scanned with Trivy (fail on CRITICAL/HIGH), and pushed to GHCR tagged `:latest` + `:sha` / `:build`.
4. Staging deploy is automatic; production deploy is **gated by manual approval** (self-hosted Jenkins `input`).
5. Nothing about Phase 1 behavior changes — same images, same endpoints, now delivered by a pipeline.

**Out of scope (belongs to Phase 3):** Terraform, EKS, Helm, K8s. The staging/prod deploy stages below are placeholders that Phase 3 replaces with Helm.

---

## 2. Pipeline overview

```
GitHub commit (webhook) ──▶ Jenkins (declarative Jenkinsfile, repo root)
  Stage 1  Checkout
  Stage 2  Validate      → backend: node --check (+ optional node:test smoke)
  Stage 3  SonarQube     → analysis + waitForQualityGate  (fail = build fails)
  Stage 4  Build         → docker build backend, frontend, simulator
  Stage 5  Scan          → trivy scan image   (fail on CRITICAL/HIGH)
  Stage 6  Push          → ghcr.io/<owner>/voting/{backend,frontend,simulator}:<sha> + :latest
  Stage 7  Deploy Staging→ automatic (SSH + docker compose on staging host)  [placeholder until Phase 3]
  Stage 8  Deploy Prod   → input(manual approval) — no-op until Phase 3
```

---

## 3. Fix repo prerequisites first (small, do these before Jenkins)

These are the honest gaps a pipeline would trip on. None require real app work.

| Gap | Suggestion |
|---|---|
| **No `package-lock.json`** | Run `npm install` once in `backend/` and commit the lockfile. Docker builds become reproducible and `npm ci` usable. (frontend/simulator have no deps — skip.) |
| **No lint config** | Keep it zero-dep: backend syntax gate `node --check src/*.js` for each file. Optionally add ESLint later; not required for Phase 2. |
| **No tests** | Prefer a **container smoke test** over new unit tests (devops-focus): the pipeline spins up the compose stack and runs the same curls as `make verify` (healthz, 201/400 vote, results). Zero new app code. |

---

## 4. Jenkins setup (suggestion)

Run Jenkins **as a container** on the machine that also has Docker (or any box with Docker Engine + Compose):

```bash
docker run -d --name jenkins \
  -p 8081:8080 -p 50000:50000 \
  -v jenkins_home:/var/jenkins_home \
  -v /var/run/docker.sock:/var/run/docker.sock \
  jenkins/jenkins:lts-jdk21
```

- **Docker socket mount** (not DinD): Jenkins can run `docker` from within the pipeline via the **Docker Pipeline** plugin — the classic approach, no nested daemon. Alternative if you prefer isolation: a Jenkins agent with Docker, or run builds in Kubernetes (skip for now).
- **Plugins to install** (Manage Jenkins → Plugins): `Pipeline`, `Git`, `GitHub`, `Docker Pipeline`, `Blue Ocean` (visibility), `SonarQube Scanner`, `Pipeline Utility Steps`, `Credentials Binding`, `Timestamper`.

**SonarQube** (one container, same host):

```bash
docker run -d --name sonarqube -p 9000:9000 \
  -e SONAR_ES_BOOTSTRAP_CHECKS_DISABLE=true \
  -v sonarqube_data:/opt/sonarqube/data \
  sonarqube:lts-community
```

Default login `admin/admin` → **change it**, create a **project token** (use "User tokens" or a "Global analysis token"). This token is what Jenkins stores and uses to push analysis.

---

## 5. GitHub ↔ Jenkins integration

- **Preferred: webhook** (needs Jenkins reachable from GitHub — use the **GitHub** plugin + a Jenkins user with read access, or set the Jenkins URL to a public/tunneled address).
- **Fallback: SCM polling** `H/3 * * * *` — simplest, needs no inbound connection. Fine for a solo project.

Branch strategy: keep the pipeline stationary on `main`; make branch pipeline job (*"Multibranch Pipeline"*) if you later want per-PR analysis. Until then a single **Pipeline** job pointing at the repo's `Jenkinsfile` is enough.

---

## 6. Credentials (Jenkins → Manage Jenkins → Credentials)

All secrets live in Jenkins **Credential Binding** (never in the repo):

| Credential | Type | Used by |
|---|---|---|
| `registry-credentials` | Username/password | GHCR: username = GitHub user, password = **PAT with `write:packages` scope** |
| `sonar-token` | Secret text | SonarQube analysis `-Dsonar.token` |
| `staging-ssh` | SSH key | Stage 7 deploy to staging host |
| `github-token` | Secret text | (optional) `scm` checkout auth for a private repo |

> **GHCR note:** `docker login ghcr.io` uses your GitHub username + a **Personal Access Token** (classic, scope `write:packages`; or fine-grained with `packages:write`). No separate DockerHub account needed since the repo is already on GitHub.

---

## 7. Stage-by-stage suggestions

### 7.1 Checkout & Validate
- Checkout `main` with the **Git** plugin (`git scm` block in the Jenkinsfile).
- Syntax gate for backend: `node --check src/server.js && node --check src/db.js && node --check src/redis.js` (works on node:20; no deps needed).
- If you add a smoke test later, hook it here (e.g. `node --test`).

### 7.2 SonarQube analysis + quality gate
Committed config file `sonar-project.properties` (repo root):

```properties
sonar.projectKey=voting
sonar.projectName=Voting App
sonar.sources=backend/src
sonar.language=js
sonar.javascript.lcov.reportPaths= (leave blank until coverage exists)
```

Pipeline pattern — **the gate failing fails the build**:

```groovy
stage('SonarQube') {
  steps {
    withSonarQubeEnv('sonarqube') {
      sh 'sonar-scanner -Dsonar.token=$SONAR_TOKEN'
    }
    timeout(time: 2, unit: 'MINUTES') { waitForQualityGate abortPipeline: true }
  }
}
```

- Gate triggers from `.js` count/duplication/smells mostly — meaningful only once real tests/coverage exist. Fine as a baseline now; add coverage in a later iteration.
- If sonar-scanner is a Jenkins agent tool, this works out of the box; alternatively use the `sonarsource/sonar-scanner-cli` container.

### 7.3 Build (cache-friendly)
- One image per service, matching the existing `Dockerfile`s (no changes needed — they're already lean).
- Keep the backend `npm install --omit=dev` layer cacheable: copy `package*.json` before `src` (already the case ✅) and use `npm ci` once the lockfile is committed.

### 7.4 Trivy scan (fail on CRITICAL/HIGH)
Run Trivy as a container to avoid installing anything:

```bash
docker run --rm -v /var/run/docker.sock:/var/run/docker.sock \
  aquasec/trivy:latest image \
  --severity CRITICAL,HIGH --ignore-unfixed --exit-code 1 \
  <image>:<sha>
```

- Because `--exit-code 1` fails on any CRITICAL/HIGH, a bad image **never gets pushed**. Optionally add `--ignore-unfixed` to avoid tripping on unpatched-but-unfixable upstream CVEs — keep it on.
- Scan **everything built** (backend, frontend, simulator) — put this in a loop over the three images.
- Later (Phase 3+): `trivy config .` for IaC/docker-compose scanning too.

### 7.5 Push to GHCR (tagging scheme)

| Tag | Meaning |
|---|---|
| `:<GIT_SHA>` | unique, immutable, deployable |
| `:latest` | last successful `main` build |

```bash
docker tag voting/backend ghcr.io/<owner>/voting/backend:$GIT_COMMIT
docker tag voting/backend ghcr.io/<owner>/voting/backend:latest
docker push ghcr.io/<owner>/voting/backend:$GIT_COMMIT
docker push ghcr.io/<owner>/voting/backend:latest
# repeat for frontend, simulator
```

Using the pipeline's built-in `GIT_COMMIT` env var keeps tags reproducible.

### 7.6 Deploy Staging (auto)
- **Placeholder strategy until Phase 3:** an `input`-free stage that SSHes to a staging host (`staging-ssh` credential) and runs `docker compose pull && docker compose up -d` against the `:latest` images. This proves the pipeline end-to-end today.
- Phase 3 replaces this with **Helm** onto EKS. Keep the stage small and visible so the swap is trivial.

### 7.7 Deploy Prod (gated) — no-op until Phase 3
```groovy
stage('Deploy Prod') {
  input message: 'Approve production deploy?', ok: 'Deploy'
  // Phase 3: helm upgrade --install voting-app ... --namespace prod
}
```
Red-flag: never put this on auto for Phase 2. It exists to prove the approval gate; it deploys nothing until K8s lands.

---

## 8. Suggested Jenkinsfile skeleton (starting point)

```groovy
pipeline {
  agent any
  environment {
    IMAGES = ['backend', 'frontend', 'simulator']
    REGISTRY = 'ghcr.io/YOUR_GITHUB_USER/voting'
    TAG = "${env.GIT_COMMIT.take(8)}"
  }
  stages {
    stage('Checkout')     { steps { git branch: 'main', url: 'https://github.com/YOUR_GITHUB_USER/voting.git' } }
    stage('Validate')     { steps {
      dir('backend') { sh 'node --check src/server.js && node --check src/db.js && node --check src/redis.js' }
    } }
    stage('SonarQube')    { steps {
      withSonarQubeEnv('sonarqube') { sh 'sonar-scanner -Dsonar.token=$SONAR_TOKEN' }
      timeout(time: 2, unit: 'MINUTES') { waitForQualityGate abortPipeline: true }
    } }
    stage('Build')        { steps {
      script {
        for (i in IMAGES) { sh "docker build -t ${REGISTRY}/$i:${TAG} -t ${REGISTRY}/$i:latest ./$i" }
      }
    } }
    stage('Scan')         { steps {
      script {
        for (i in IMAGES) {
          sh "docker run --rm -v /var/run/docker.sock:/var/run/docker.sock aquasec/trivy:latest image " +
             "--severity CRITICAL,HIGH --ignore-unfixed --exit-code 1 ${REGISTRY}/$i:${TAG}"
        }
      }
    } }
    stage('Push')         { steps {
      withCredentials([usernamePassword(credentialsId: 'registry-credentials', usernameVariable: 'REG_USER', passwordVariable: 'REG_PASS')]) {
        sh 'echo $REG_PASS | docker login ghcr.io -u $REG_USER --password-stdin'
        script { for (i in IMAGES) { sh "docker push ${REGISTRY}/$i:${TAG} && docker push ${REGISTRY}/$i:latest" } }
      }
    } }
    stage('Deploy Staging') { steps { echo '// TODO: SSH + docker compose pull && up -d on staging host (Phase 3: Helm)' } }
    stage('Deploy Prod')    { steps { input message: 'Approve production deploy?', ok: 'Deploy'; echo '// no-op until Phase 3' } }
  }
}
```

Treat this as a **starting skeleton, not the final file** — wire your real host names, your GitHub user, and decide blocking vs. non-blocking scan behavior when you implement it.

---

## 9. Deliverables for the implementation phase (checklist)

- [ ] Commit `backend/package-lock.json`
- [ ] `Jenkinsfile` (declarative, this guide’s skeleton evolved)
- [ ] `sonar-project.properties`
- [ ] Jenkins + SonarQube running (docker containers), plugins installed
- [ ] Credentials created: `registry-credentials`, `sonar-token`, `staging-ssh`
- [ ] GitHub repo → Jenkins webhook (or polling fallback)
- [ ] Job created, first run green on `main`

## 10. Verification checklist (what "Phase 2 done" means)

- [ ] Commit to `main` → pipeline runs automatically
- [ ] SonarQube analysis posts to server; gate OK; a deliberately bad change fails the pipeline
- [ ] Tagged images exist in GHCR (`:<sha>` + `:latest` for all 3 services)
- [ ] Trivy stage logs show no CRITICAL/HIGH (or a real finding blocked the push)
- [ ] Manual approval step blocks before prod; nothing is deployed to prod
- [ ] Staging (if the placeholder is enabled) runs the same images the pipeline just pushed

Once these pass → tell the user **Phase 2 is verified**; only then plan Phase 3 (Terraform → EKS → Helm), which also retrofits Stages 7–8.
