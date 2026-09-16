# kube-tools — design notes & session recap

Context for future sessions: what exists, what was verified against the live
cluster, which design decisions were made and why, and what is still open.

Last updated: 2026-09-15.

---

## 1. Goal

A local web UI that replaces a team cheat-sheet of `kubectl` / `svctl` /
`dbctl` / `pkictl` commands. Click a button, it runs the command on the user's
own machine with their own credentials, and renders the result.

**Distribution model: not Docker.** Rejected deliberately — the app's whole job
is to run host CLIs with host credentials, and a container fights that:

- Internal cluster hostnames resolve only through the host's corp VPN; bridged
  containers can't see those routes, and `--network host` is unreliable on macOS
- SSO login needs a browser the container doesn't have
- `svctl` lives in each person's repo checkout at a different path
- mounted `~/.kube` hits uid/gid mismatches

"Portable" here means *teammates can run it*, which is solved by shipping a
normal Node package plus a background-service installer, not by containerising.
Auto-start is handled with systemd (Linux) / launchd (macOS) / pm2 — see README.

---

## 2. Current state (working)

Node 24, CommonJS, Express, no frontend build step. Serves on `127.0.0.1:14777`.

```
bin/cli.js        entrypoint, --port flag
lib/server.js     express app; createApp() split from start() for tests
lib/routes/       one file per endpoint, each exporting a Router; index.js
                  collects them and server.js mounts the set under /api
lib/registry.js   app config: loads/validates services.yaml, resolves
                  (service,env)→target, plus resolveTarget(req,res) for the
                  route handlers. Sits at the root, not in core/ — it is this
                  app's configuration, not reusable plumbing.
lib/core/         shared plumbing; requires nothing else in lib/:
  executor.js     ONLY place a process spawns; execFile + array args, no shell
  http.js         sameOrigin guard + K8S_NAME validation
lib/k8s/          the kubernetes work itself:
  kubectl.js      builds kubectl args, classifies stderr
  pods.js         pure transform: ready counts, restarts, kubectl-style age, status
  portforward.js  spawns/tracks port-forward child processes
public/           index.html + style.css + app.js (vanilla, no framework)
test/             mocha + chai + proxyquire — 28 specs passing
services.yaml     hand-written registry (to be replaced, see §5)
```

Endpoints (one file each under `lib/routes/`): `GET /api/health`,
`GET /api/services`, `GET /api/pods?service=&env=`, `POST /api/restart`,
`POST /api/scale`, `GET|POST /api/portforward`, `POST /api/portforward/stop`.

Implemented: service/env dropdowns, pod table, client-side filter, loading
indicator, error banner with classified messages. Auto-refresh was built and
then **removed on request** — all loads are user-initiated.

Timeouts are configurable in `services.yaml` (`timeoutSeconds`, default 60,
overridable per service and per env). kubectl gets `--request-timeout=Ns`; the
executor kills at N+5s so kubectl reports the real error rather than being
killed first.

---

## 3. Verified facts about the environment

Everything here was checked against the live cluster, not assumed.

**Paths**
- App: `~/Desktop/kube-tools`
- Repo (svctl/dbctl/pkictl live here): `~/Desktop/cermati/athena`
- `svctl` etc. are at `<repo>/cli/` — **must be run with cwd = repo root**.
  `execFile`'s `cwd` option solves this; repo path becomes per-machine config.

**Credentials**
- Cert-based, **~4h TTL**. Expired mid-session during this work.
- Expiry surfaces as `Error from server (BadRequest): the server rejected our
  request for an unknown reason`, plus `memcache.go` discovery errors —
  **not** `Unauthorized`.
- ⚠️ **Known bug:** `lib/k8s/kubectl.js` `classifyError()` maps this to `unknown`,
  so the UI shows a raw dump instead of "log in again". Not yet fixed.

**RBAC in `cermati-indodana-athena-stg`** — all `yes`:
`get pods`, `get deployments`, `get cronjobs`, `get scaledobjects`,
`get pods/log`, `create pods/portforward`, `patch deployments`,
`patch scaledobjects`.

**Namespace shape (stg, at time of writing)**
- 128 pods = **84 ReplicaSet-owned** + **44 Job-owned**, nothing else
- 98 Jobs, **all 98 owned by a CronJob** (no orphans)
- 81 distinct deployments (`athenaapp-deployment`, `athenaapp-lb`,
  `athenaapp-sut-*`, …)

---

## 4. Classifying pods (verified)

Use `metadata.ownerReferences[0].kind`. No name-prefix guessing.

**Deployment pods** — `kind: ReplicaSet`. Deployment name = ReplicaSet name
minus the `pod-template-hash` label:

```
pod   athenaapp-deployment-596db77f5c-7wgrm
RS    athenaapp-deployment-596db77f5c
hash  596db77f5c
→     athenaapp-deployment
```
Verified true for all 84 pods.

**CronJob pods** — `kind: Job`. Two routes:

| Route | Coverage | Cost |
| --- | --- | --- |
| pod label `cfgroot.k8s.service/cronjob_parent_service` | 38 of 44 | free |
| `get jobs` → `ownerReferences[0].kind === 'CronJob'` | 44 of 44 | 1 extra call |

**Decision: fire `get pods` + `get jobs` in parallel** and join on owner name.
Same wall-clock latency, 100% attribution, plus job status for free.

**Manual vs scheduled runs** are distinguishable by job name:
```
atwcronairudder-snapshot-call-data-29702880-pnrnj   scheduled (numeric slot)
atwcronairdduer-hisyam-manual-1-mcm77               run by hand
```

**Useful pod labels** (all present, verified):
```
cfgroot.k8s.service/service              athenaapp
cfgroot.k8s.service/environment          stg
cfgroot.k8s.service/product              athena
cfgroot.k8s.service/cronjob_parent_service   (job pods only)
cfgroot.k8s.cicd/version                 stg-20260915T141826-cf2118ba
cfgroot.k8s.cicd/release_channel         stable        (vs canary)
cfgroot.k8s.cicd/deployer                <email>
pod-template-hash                        596db77f5c
```

`cfgroot.k8s.cicd/version` means the UI can show **which version is live** and,
after a deploy, confirm what actually landed.

**Resources are already on the pod object** — `spec.containers[].resources`.
No extra call, no extra RBAC needed:
```json
{"limits":{"cpu":"1","memory":"2Gi"},"requests":{"cpu":"200m","memory":"1Gi"}}
```

---

## 5. Config sources in the repo (replace hand-written YAML)

`~/Desktop/cermati/athena/.services.d/` — **82 services**:

| File | Contents |
| --- | --- |
| `kubernetes_contexts.yml` | every context → `url` + `namespace`. This is the mapping currently hand-copied into `services.yaml`. |
| `<svc>/meta.yml` | `environments:` list, `kubernetes.deployment` → `default_cluster` per runtime, team/product, slack channel, monitoring thresholds |
| `<svc>/kubernetes/<env>/deployment.yml` | declared `requests`/`limits`, autoscaling min/max, cron autoscale triggers |
| `<svc>/kubernetes/<env>/cronjob.yml` | `cron_jobs[]` with `schedule`, `args`, own `requests` |

File counts: 1507 `deployment.yml`, 119 `cronjob.yml`, 55 `cronjobs.yml`.

`~/Desktop/cermati/athena/blueprint/dbctl/` — 17 DBs; envs are subdirectories;
roles under `<db>/__db__/roles/` (`readonly`, `readwrite`). Drives the dbctl
dropdowns.

**Decision: parse these, delete the hand-written `services.yaml`.** They are
directory scans — cache at startup with a manual refresh button.

**Drift is the differentiator.** Example already found: athenaapp/stg *declares*
`limits: cpu 1000m` with no memory limit, but the live pod has
`limits: {cpu: 1, memory: 2Gi}` — a memory limit is coming from somewhere else.
Declared-vs-actual is something k9s/Lens does not give you; generic pod browsing
is not worth rebuilding.

---

## 6. svctl facts (verified by `--help`)

Subcommands under `svctl jenkins run-pipeline`:
`containerize`, `kube-deploy`, `canary-deploy`, `containerize-deploy`,
`kube-uninstall`, `canary-uninstall`, `slate-deploy`.

```
containerize         <service_name> <environment>            [--commit] [--dry-run]
kube-deploy          <cluster_context> <service_name> <environment> <version>
canary-deploy        <cluster_context> <service_name> <environment> <version>
containerize-deploy  <service_name> <environment>            [--cluster-context]
```

- `cluster_context` accepts `default` → the service's default cluster
- `version` accepts `latest` → latest build from Jenkins
- every pipeline supports `--dry-run` and `--commit`

**`containerize-deploy` is unusable here**: it takes a *single* `service_name`
for both phases. Athena needs containerize `athena` but deploy `athenaapp` plus
N workers (e.g. `atwautodialcollectionassignmenttmf`). Confirmed from the
signature.

**Behaviour:** returns a Jenkins URL (per user). Slow to start — a `--dry-run`
had not returned after 60s. It is a PyInstaller Python binary.

⚠️ **Streaming gotcha:** Python block-buffers stdout when it is a pipe rather
than a TTY. Without `PYTHONUNBUFFERED=1` in the child env, SSE will show nothing
for a minute then dump everything at once. Fall back to `node-pty` only if the
env var is insufficient.

---

## 7. Architecture decisions

### 7.1 Model execution *kinds*, not individual commands

The cheat-sheet looks like ~12 features; it is really **5 kinds**. Build one
executor plus 5 handlers, and declare `kind` per command in the registry.

| Kind | Commands | Mechanism |
| --- | --- | --- |
| `oneshot` | get pods, rollout restart, scale, `svctl config load` | execFile → parse → render |
| `stream` | pipelines, logs | spawn + job + SSE |
| `session` | port-forward, psql | long-lived process registry, start/stop |
| `link` | kube proxy DNS URLs | no exec, pure URL templating |
| `secret` | vault token | run, display once, never log or persist |

### 7.2 Two cheat-sheet commands must NOT be ported literally

- **`kubectl edit scaledobject`** opens `$EDITOR` — impossible from a web UI.
  Use `kubectl patch scaledobject --type=merge -p '{...}'` (patch permission
  verified). Strictly better: atomic, no editor.
- **`dbctl util psql`** is an interactive TTY. A real REPL in the browser needs
  xterm.js + node-pty — large scope. **v1: build the command, show a copy
  button.** The value is the dropdowns, not hosting the shell.

Vault is the same shape: run login, show the token masked with a copy button
plus a link to the right Vault URL per env. Never log or persist it.

### 7.3 Streaming: `spawn`, not `execFile`

`execFile` buffers until exit. For long commands use `spawn` + a **server-side**
job store, so closing the tab doesn't kill the run:

```
POST /api/jobs            → { jobId }, returns immediately
GET  /api/jobs/:id/stream → SSE: replay buffered lines, then live-tail
GET  /api/jobs            → recent jobs (survives page reload)
POST /api/jobs/:id/cancel → SIGTERM
```

Replay-then-tail is what makes it fire-and-forget. Assemble lines with a
remainder buffer (chunks split mid-line). Cap the buffer (~5000 lines, drop the
head). Client is `EventSource`, which auto-reconnects. Parse `[INFO]`/`[OK]`/
`[WARN]` prefixes into CSS classes. Extract the Jenkins URL with a regex and
render it as a link.

**`kubectl get pods` stays request/response** — it returns in ~1.7s. Streaming a
1.7s call adds complexity for nothing.

### 7.4 containerize → deploy: capture the version

| Option | Verdict |
| --- | --- |
| `containerize-deploy` | ❌ single service name, can't do athena→athenaapp |
| chain with `latest` | ⚠️ works, but a teammate containerizing mid-flow means your workers deploy *their* build |
| **chain with captured version** | ✅ deterministic; all N workers get the same image |

Fan-out is exactly where `latest` breaks — deploying 5 workers, all 5 must be
the same image. Then verify via the `cfgroot.k8s.cicd/version` pod label.

**Open problem:** if svctl exits as soon as it triggers Jenkins, its exit means
"job accepted", not "image exists" — so there is no version to feed
`kube-deploy`. Options: poll Jenkins (`/lastBuild/api/json`, needs auth), or a
two-step UI (run containerize, show URL, user confirms version, then fan out).
Start with the two-step UI: it mirrors today's manual flow minus the terminal,
and automates the N-worker fan-out.

### 7.5 Security

Input validation is the security boundary, and it is real, not decorative:

- `execFile` with an **argument array**, never a shell string
- registry values validated against `/^[A-Za-z0-9][A-Za-z0-9._-]*$/` so a stray
  `--token=...` can never become a flag (covered by a spec)
- free-text params (e.g. image `version`) must pass the same gate
- namespaces validated as DNS-1123 labels
- server binds **127.0.0.1 only**

⚠️ **Becomes mandatory once this can deploy:**
- **Mutations must be POST + `Origin` check.** Today every endpoint is GET. Any
  website you visit can issue a cross-origin GET to `localhost:14777`; a GET
  that restarts a deployment is a real CSRF hole.
- **Prod guardrails**: type-to-confirm the service name, plus an audit log of
  who/what/when.

---

## 8. Roadmap

| Phase | Scope | New infra |
| --- | --- | --- |
| **P1** | parse `.services.d` as config source; pods with type + resources + version label; rollout restart; scale via patch; kube-proxy DNS links; copy-buttons for psql/vault | none |
| **P2** | job engine + SSE; containerize → fan-out deploy; canary commands | job store |
| **P3** | port-forward lifecycle; log streaming | process registry |

P1 delivers most of the cheat-sheet with no architectural risk. P2 is the real
win (fire-and-forget multi-worker deploys).

---

## 9. Open questions

1. Does `svctl jenkins run-pipeline` exit right after printing the Jenkins URL,
   or does it tail the build and print the image version at the end? The
   cheat-sheet says "copy the image from the output", which suggests the version
   does eventually appear. **Decides whether P2 needs Jenkins polling.**
   Test: `time cli/svctl jenkins run-pipeline containerize athena stg --dry-run`
2. Is there a `--json` / non-interactive output flag? Determines whether version
   capture is robust parsing or regex-scraping.
3. Is a Jenkins API token available for polling build status?

## 10. Loose ends

- **Auth classifier bug** (§3) — expired certs read as `unknown`. Small fix.
- **35MB of unexplained binaries**: `cli/db/dist/main` (21M) and
  `cli/pki/dist/main` (14M) appeared under `~/Desktop/kube-tools/cli/` during
  this session. The kubeconfig has **no exec credential plugins**, so kubectl
  did not create them. Origin unconfirmed — possibly a bootstrap run from the
  wrong cwd. `.gitignore` already matches `dist/`, so they won't be committed.
  Pinning svctl's cwd to the repo should prevent a recurrence.
