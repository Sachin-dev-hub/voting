# CI/CD Guide — Phase 2 (Jenkins + SonarQube + Trivy)

> Predecessor: `POC_GUIDE.md` (Phase 1 — ✅ verified). This file is the **walkthrough** for Phase 2. Jenkins is already running on Oracle Ubuntu at `http://localhost:8080` — this guide takes you from that box to a green pipeline. Progress checklist: §9.
>
> **This box has no public IP.** Jenkins, SonarQube, and the build host are all the same Oracle Ubuntu machine, reached through `localhost`. GitHub cannot reach in, so the trigger is **polling** (§5.3) — no webhook. Every cross-service URL between Jenkins and SonarQube below is `localhost`; the public-IP forms some older notes suggest are wrong for this setup.
>
> Requirement source: `requirement` + README §6.1. Stack constraints from the user: **Jenkins** (declarative pipeline), **SonarQube** (quality gate), **Trivy** (image security scan). Target registry is GitHub, so GHCR is recommended below.

----

## 1. Goals of Phase 2

1. Every commit to `main` triggers a Jenkins pipeline (within ~3 min via **Poll SCM** — §5.3; no webhook on this box).
2. Code is statically analyzed by SonarQube; a failing **quality gate blocks** the build.
3. Images are built, scanned with Trivy (fail on CRITICAL/HIGH), and pushed to GHCR tagged `:latest` + `:sha` / `:build`.
4. Staging deploy is automatic; production deploy is **gated by manual approval** (self-hosted Jenkins `input`).
5. Nothing about Phase 1 behavior changes — same images, same endpoints, now delivered by a pipeline.

**Out of scope (belongs to Phase 3):** Terraform, EKS, Helm, K8s. The staging/prod deploy stages below are placeholders that Phase 3 replaces with Helm.

---

## 2. Pipeline overview

```
GitHub commit ──(Poll SCM ~3 min; no webhook §5.2)──▶ Jenkins (declarative Jenkinsfile, repo root)
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

## 4. Your running Jenkins — Oracle Ubuntu on `:8080`

Jenkins is **already installed and running** — don't reinstall. This section is verify + wire-up.

**URL:** `http://localhost:8080` — browser, build links, and Jenkins↔SonarQube calls all stay on this box, so `localhost` is the correct address everywhere in this guide (see §5.1).

First-time unlock (only if you haven't logged in yet) — the initial admin password is:
- Native install (ubuntu `jenkins` apt package): `sudo cat /var/lib/jenkins/secrets/initialAdminPassword`
- Container install: `docker logs <jenkins-container>`

### 4.1 Ports on a no-public-IP box — nothing to open
Everything runs and talks on `localhost`, so **no OCI security-list/NSG ingress rules and no `ufw` allow** are needed for this guide. (They only matter if you later expose the box on a public IP — out of scope and impossible here.)

> Because GitHub lives on the public internet and this box has no public IP, the **webhook cannot reach Jenkins** (§5.2) — hence Poll SCM (§5.3) is the trigger. Ports 8080 and 9000 stay localhost-only.

### 4.2 Jenkins must be able to run Docker (Stages 4–6 need it)
The pipeline builds and pushes images **on this box**, so Docker must work as the Jenkins user/container.

- Quick check: run a **freestyle job** with a shell step `docker ps`, or on the box itself: `sudo -u jenkins docker ps` (native install).
- If permission denied:
  - **Native install** (`.deb`/apt): `sudo usermod -aG docker jenkins && sudo systemctl restart jenkins`
  - **Container install**: the container must mount the Docker socket (`-v /var/run/docker.sock:/var/run/docker.sock`) — inspect its run config with `docker inspect <jenkins-container>`.
- Which one applies depends on how you installed Jenkins — both work; only the fix differs.

### 4.3 Plugins (Manage Jenkins → Plugins → Available plugins)
`Pipeline`, `Git`, `GitHub`, `Docker Pipeline`, `Blue Ocean`, `SonarQube Scanner`, `Pipeline Utility Steps`, `Credentials Binding`, `Timestamper`.

### 4.4 SonarQube — one container on the same Oracle box (port 9000)
```bash
docker run -d --name sonarqube -p 9000:9000 \
  -e SONAR_ES_BOOTSTRAP_CHECKS_DISABLE=true \
  -v sonarqube_data:/opt/sonarqube/data \
  sonarqube:lts-community
```
Then: log in at `http://localhost:9000` (`admin/admin`) → **change the password** → **My Account → Security → Generate token**, name it `sonar-token`. That token becomes Jenkins credential `sonar-token` (§6), and the server is registered in Jenkins global config:

- **Manage Jenkins → System → SonarQube servers → Add SonarQube**: Name `sonarqube`, Server URL `http://localhost:9000`, Server authentication token `sonar-token`.
- **Manage Jenkins → Tools → SonarQube Scanner → Add SonarQube Scanner**: "Install automatically" is fine.

> Keep `localhost` here: Jenkins (host) and SonarQube (container published on host port 9000) talk to each other on this box, and `waitForQualityGate` **polls** the server from Jenkins — no inbound path is needed.

---

## 5. GitHub ↔ Jenkins — make GitHub talk to your Oracle Jenkins

### 5.1 Tell Jenkins its own URL — `localhost` is correct here
**Manage Jenkins → System → Jenkins URL** = `http://localhost:8080`.

`localhost` is right for this box: nothing outside needs to reach Jenkins, and the browser talks to it locally — there is no public IP to advertise. The older "don't use localhost" advice assumed a cloud VM with a public IP; that doesn't apply to your setup. Webhooks (§5.2) would need a public URL, which is exactly why this guide uses polling (§5.3) instead.

### 5.2 Webhook — skip unless the box gets a public IP
> **Not usable on this box:** the webhook needs GitHub (public internet) to reach Jenkins, which requires a public IP. Yours has none, so a webhook would go red forever — use §5.3 instead.

1. GitHub repo → **Settings → Webhooks → Add webhook**.
2. **Payload URL:** `http://<JENKINS_PUBLIC_URL>:8080/github-webhook/` — the `/github-webhook/` path is the GitHub plugin's ingestion endpoint; keep it exact.
3. Content type `application/json`, trigger: **Just the push event** → Add webhook.
4. GitHub sends a **ping** immediately — a green ✓ next to the webhook means Jenkins is reachable and the plugin is up.

### 5.3 Polling — the trigger to use (no inbound connection needed)
This works with no public IP: Jenkins reaches **out** to GitHub instead of GitHub reaching in. In the job, **Build Triggers → Poll SCM** with `H/3 * * * *` — Jenkins pulls GitHub repo state every ~3 min and builds when `main` has new commits.

### 5.4 Job strategy
A single **Pipeline** job on `main`, pointing at the repo's `Jenkinsfile` (this repo is public, so checkout needs no credentials; switch to a credentialed checkout if it ever goes private). Multibranch + per-PR analysis can come later.

---

## 6. Credentials (Manage Jenkins → Credentials → System → Global → Add Credentials)

All secrets live in **Jenkins** (never in the repo). Create these before the first run:

| Credential ID | Kind | Value |
|---|---|---|
| `registry-credentials` | Username with password | Your GitHub username + **PAT with `write:packages` scope** — used for `docker login ghcr.io` |
| `sonar-token` | Secret text | SonarQube token from §4.4 |
| `github-token` | Secret text | (optional) GitHub PAT — only needed if the repo goes private |
| `staging-ssh` | SSH key | Deferred — only when the staging placeholder (§7.6) is enabled |

**Create the GitHub PAT first** (required before the first run): GitHub → **Settings → Developer settings → Personal access tokens → Tokens (classic) → Generate new token**; scope **`write:packages`** (add `repo` if the repo is private). No separate DockerHub account is needed — the repo is already on GitHub, and GHCR packages ride on the same account.

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
docker tag voting/backend ghcr.io/sachin-dev-hub/voting/backend:$GIT_COMMIT
docker tag voting/backend ghcr.io/sachin-dev-hub/voting/backend:latest
docker push ghcr.io/sachin-dev-hub/voting/backend:$GIT_COMMIT
docker push ghcr.io/sachin-dev-hub/voting/backend:latest
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
    REGISTRY = 'ghcr.io/sachin-dev-hub/voting'
    TAG = "${env.GIT_COMMIT.take(8)}"
  }
  stages {
    stage('Checkout')     { steps { git branch: 'main', url: 'https://github.com/Sachin-dev-hub/voting.git' } }
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

## 9. Deliverables — Phase 2 checklist

Repo + box prep:
- [x] Phase 1 POC verified; Jenkins running on Oracle Ubuntu `:8080`
- [ ] Commit `backend/package-lock.json` (§3)
- [ ] Commit `Jenkinsfile` (from the §8 skeleton) + `sonar-project.properties` (from §7.2)

Jenkins box (Oracle Ubuntu):
- [ ] `http://localhost:8080` (Jenkins) and `http://localhost:9000` (SonarQube) load (§4)
- [ ] Jenkins URL = `http://localhost:8080`; SonarQube server URL = `http://localhost:9000` (§4.4, §5.1)
- [ ] Jenkins user can run `docker ps` (§4.2)
- [ ] Plugins installed (§4.3); SonarQube up on `:9000`, password changed, token created (§4.4)
- [ ] Credentials created: `registry-credentials`, `sonar-token` (§6); GitHub PAT with `write:packages`

First pipeline run:
- [ ] Pipeline job created pointing at the repo `Jenkinsfile` (Build Trigger: **Poll SCM** `H/3 * * * *` — webhook N/A without a public IP)
- [ ] First run green on `main` (push to `main` → build starts within ~3 min)

## 10. Verification checklist (what "Phase 2 done" means)

- [ ] Commit to `main` → pipeline runs automatically (Poll SCM, within ~3 min)
- [ ] SonarQube analysis posts to server; gate OK; a deliberately bad change fails the pipeline
- [ ] Tagged images exist in GHCR (`:<sha>` + `:latest` for all 3 services)
- [ ] Trivy stage logs show no CRITICAL/HIGH (or a real finding blocked the push)
- [ ] Manual approval step blocks before prod; nothing is deployed to prod
- [ ] Staging (if the placeholder is enabled) runs the same images the pipeline just pushed

Once these pass → tell the user **Phase 2 is verified**; only then plan Phase 3 (Terraform → EKS → Helm), which also retrofits Stages 7–8.
