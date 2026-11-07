# Deploys nobody can see

A deploy can be invisible to the people using Chopin: no notice, no reload, no lost edit, and
a message to a document's machine answered once. This page is for the operator who wants that.
It says what Chopin does when it is stopped, what the proxy in front of it must do, what a
deploy script runs and in what order, and what is not done yet.

It covers Stage 1 of the zero-downtime upgrades design, invisible restarts on one server: two
processes overlap on one database, and only one serves at a time. The later stages (checks that
a release is safe before it serves, several processes, and updating connected machines) are not
part of it; see [What is not done](#what-is-not-done).

Chopin does not ship a proxy. The files in [`deploy/overlap`](../deploy/overlap) are a reference
configuration and a local setup to try the overlap, not a production deployment.

## What happens in a deploy

A process started with `HANDOVER=wait` does not exit when another process holds the database's
writer lease. It starts **beside** it, in standby:

- `GET /api/health/live` answers `200 standby` and `GET /api/health/ready` answers `503`.
- The built client's files are served at once. Every other request and WebSocket upgrade is held
  for up to `HANDOVER_HOLD_MS`, then answered `503` with `Retry-After: 1`. That is a fallback for a
  proxy that cannot hold requests.
- It reads the lease row with plain reads every 100 ms and takes the lease only when the row
  shows it released or expired, so it never queues behind the holder's writes. Nothing is
  renewed or timed until it has the lease.

The platform then sends SIGTERM to the **old** process, only once the new one is warm. The old
process:

1. Keeps serving and stays ready. From the signal on, every answer carries `Connection: close`,
   so the proxy keeps no idle connection to it. It starts no new Planner turn: a request that
   would have started one is saved and waits for the new process. It asks GitHub for no token
   refresh.
2. Lets turns already running finish, up to `HANDOVER_TURN_WAIT_MS`, with no socket closed. A turn
   still running then is cut off, with a notice in its Chat, and is never run again.
3. Commits and checkpoints every document, still serving.
4. **The cut**, in this order, so it never refuses a request and answers nothing once it has let go:
   1. `GET /api/health/ready` answers `503 draining` for the whole `HANDOVER_UNREADY_MS`, while the
      process serves every request. It logs how many readiness checks it answered in that window.
      Zero means no proxy checks readiness actively.
   2. It stops its listener without closing a socket.
   3. It finishes the requests already running, up to `HANDOVER_REQUEST_WAIT_MS`. A request still
      running then is abandoned: its connection is closed with no byte of an answer, its handler is
      told (an MCP call stops its work as it does when its caller goes away) and whatever it makes
      afterwards is dropped. Each is logged. A request that reaches an open connection after this
      is closed the same way, so nothing is answered once the lease is released. Sockets are left
      for the last step.
   4. It stops admitting edits, commits what is left, and writes what each connected remote
      Planner holds (see [Remote Planner](#a-remote-planner-and-its-machine)).
   5. It releases the lease.
   6. It tells every client the server is restarting, closes each socket with 1012 and exits 0.

A message, an `invoke_planner` call or a Build press that was being saved when step 4 began is
finished first: closing a document's Chat waits for every send already admitted, so each is saved
as a row and answered, never refused as closed. A message that reaches the process after that, and
every frame from step 4 on, gets no answer at all. Its page keeps it, sees the socket close with
1012, and sends it again, with the same request id, to the new process, which saves it once; the
page shows it as waiting to send meanwhile, and never as a message that could not be sent. A Build
press is not sent again by the page: one that reaches a closed Chat reads as any request lost to a
restart does, and can be pressed again. MCP has no such page: no HTTP request reaches the process
after step 2, and one still running at the bound of step 3 is the one planned exception (its
connection is closed without an answer; the proxy retries a GET and answers any other method 502). An `invoke_planner` call that did get as far as a closed
Chat answers `planner-unavailable`, which the caller may retry; the retry is held by the proxy
until the new process is ready.

The new process takes the lease within about 100 ms of the release, finishes its startup and
becomes ready. The proxy's next health check adopts it and the requests it held reach it. Then it
starts the Planner requests that were saved. Browsers that lost their socket at step 6 reconnect
inside their grace and show nothing; the editor keeps every update the old process had not
acknowledged and sends it again.

### The budget

Measured from the release, which is when clients lose their sockets, the design's targets are:

| Step                                                        | Within                      |
| ----------------------------------------------------------- | --------------------------- |
| The waiting process sees the release                        | 100 ms, the poll interval   |
| Its startup under the lease                                 | 300 ms                      |
| The proxy's active health check adopts it                   | 250 ms, the health interval |
| A request the proxy holds is tried again                    | 100 ms, `lb_try_interval`   |
| **Summed worst case, from the release to a served request** | **about 750 ms**            |

A tab waits at most about 1.2 s after losing its socket before it reconnects, and shows its
"reconnecting" notice at 1.5 s, so this leaves slack. A request that reaches the proxy during the
cut waits a little longer than the gap itself: up to the unready window and the in-flight bound
before the release, and then the gap. That delays held requests but starts no client's grace.

`bun scripts/overlap.ts` measures it (see [Try it locally](#try-it-locally)). Twenty overlapped
hand-overs of two processes on one host behind the reference proxy, with six clients asking every
10 ms, gave no request that was not answered 2xx, and a first answer 94 to 379 ms after the
release. Ten deploys of the two Compose slots gave none either, and a first answer 133 to 281 ms
after the release in nine and 1.19 s in one, inside a tab's 1.5 s but not the budget. The
same Compose deploy without the wait for the proxy to find the new slot (step 5 below) took 2.9 s,
0.17 s and 0.93 s.

## What the proxy must do

The proxy decides whether a deploy is visible. It must:

- **Check readiness actively.** Send new connections only to an upstream whose
  `GET /api/health/ready` answers 200, and check it often. A proxy with only passive health checks
  learns nothing in the unready window, so it may send a request to a listener the cut stops next.
- **Set `HANDOVER_UNREADY_MS` to the check's interval plus a margin.** The process cannot count
  proxies; it waits the whole window and logs the readiness checks it answered. With a 250 ms
  interval, 300 ms is right. A window with zero checks is logged as a risk.
- **Hold requests while no upstream is ready, and try them again**, for every method. This is
  what covers the gap between the release and the next health check. A proxy that cannot hold
  requests makes the gap visible: the server's own standby hold covers only a short one.
- **Keep established WebSockets** until the server closes them. Chopin closes them itself at the
  end of the cut.
- **Pass an upstream's status through**, or at least not answer a 4xx of its own while it waits.
  A tab that loaded an older build treats any 4xx on its reconnect probe as a refusal and stops
  retrying.

Chopin sends `Connection: close` from SIGTERM so a proxy does not keep an idle connection to
the old process, and `GET /api/health/live` / `GET /api/health/ready` answer a status word and
nothing else, without authentication.

### Caddy

[`deploy/overlap/Caddyfile`](../deploy/overlap/Caddyfile) is the reference. Its upstream block:

```caddyfile
reverse_proxy chopin-a:8787 chopin-b:8787 {
	lb_policy first
	lb_try_duration 5s
	lb_try_interval 100ms
	health_uri /api/health/ready
	health_interval 250ms
	health_timeout 1s
	health_status 200
}
```

- `lb_policy first` with two upstreams is safe because only the lease holder is ready.
- `lb_try_duration` is how long a request waits for an upstream. It must cover the unready
  window, the in-flight bound and the budget above; 5 s leaves room. A request still unrouted
  after it gets Caddy's error.
- `lb_try_interval` and `health_interval` are the largest terms in the budget. Caddy's defaults
  (250 ms and 30 s) would make adoption slower than a tab waits.
- `health_timeout 1s` with the default `health_fails 1`: a check that takes longer than a
  second fails and takes the only ready upstream out for an interval. The ready answer comes from
  state the process already holds and runs no query, so a slow answer means the process stalled.
  `health_fails 2` tolerates one failed check, but needs two answers of 503 at the cut, so
  `HANDOVER_UNREADY_MS` would be two intervals plus the margin.
- **No `lb_retry_match`.** The old process never refuses a request that was routed to it, so
  there is no 503 to retry.

Checked against Caddy 2.11.9 with stand-in backends (they show how Caddy behaves, not how fast
Chopin hands over):

- A dial that is refused is retried until `lb_try_duration` for every method: a GET, POST, PUT and
  DELETE sent while the upstream's listener was closed were each delivered exactly once when it
  opened again 700 ms later, and with no `lb_try_duration` the same POST was answered 502 at once.
- An upstream's 503 reaches the client as it is. Retrying it by status with `lb_retry_match` is
  not a remedy under `lb_policy first`: the same upstream was chosen again until the try duration
  ran out and Caddy answered 502.

Put the `reverse_proxy` block inside your own site block. Validate your Caddyfile with
`caddy validate` before a rollout.

## Two slots and a deploy script

The overlap needs two named slots, `chopin-a` and `chopin-b`, sharing one image tag, one set of
settings and one database, both with `HANDOVER=wait`. A deploy starts the idle slot and then
stops the serving one. Do not use a plain `docker compose up --detach` after an image change:
it recreates both slots at once, which stops the serving slot together with the idle one, a
stop-then-start deploy with no overlap. Name the slot instead.

A deploy script does, in this order:

1. Build the image with the image that runs now as `PREVIOUS_IMAGE`, so a tab left open still
   finds the files of its build (`docker build --build-arg PREVIOUS_IMAGE=<running image>`; see
   [Self-hosting](self-hosting.md#deploy-the-docker-image)). The build's entrypoint applies
   migrations when a slot starts; they must be **expand-only** (see
   [Rollback](#rollback)).
2. `docker compose pull chopin-a chopin-b`, so a newer database or proxy image is not pulled as a
   side effect.
3. `docker compose up --detach --no-deps chopin-<idle slot>`. Naming the slot limits the
   recreation to it, and `--no-deps` keeps Compose from recreating the database.
4. Wait until that slot's `GET /api/health/live` answers `200 standby`, or `ready` when the old
   slot had already died and the new one took over at once. Without `HANDOVER=wait` the slot
   exits instead and this never succeeds.
5. Wait for the proxy to find the slot: at least `health_timeout` plus `health_interval`, 1.25 s
   for the reference, and the script waits 1.5 s. A stopped slot's name does not resolve, and a
   proxy check of a name Docker's DNS has to look up elsewhere can hang until `health_timeout`.
   Stopping the old slot before the proxy has checked the new one makes the gap as long as
   that.
6. `docker compose stop chopin-<serving slot>`. It sends SIGTERM and waits up to
   `stop_grace_period`.
7. Check `GET /api/health/ready` on the new slot, and keep the old container until you trust the
   release. The next deploy uses the other slot.

A slot that fails before it reaches standby (bad configuration, a failed migration) leaves the old
one serving: stop it, fix the release, and try again. Never stop the serving slot first.

### Settings

| Where                 | Setting                         | Value for the reference                |
| --------------------- | ------------------------------- | -------------------------------------- |
| Both slots            | `HANDOVER`                      | `wait`                                 |
| Both slots            | `HANDOVER_UNREADY_MS`           | `300` (health interval plus 50 ms)     |
| Both slots, optional  | `HANDOVER_TURN_WAIT_MS`         | `10000`, the default                   |
| Both slots, optional  | `HANDOVER_REQUEST_WAIT_MS`      | `1000`, the default                    |
| Both slots, optional  | `HANDOVER_PLANNER_WINDOW_MS`    | `10000`, the default                   |
| Both slots, optional  | `HANDOVER_HOLD_MS`              | `20000`, the default                   |
| Each slot's service   | `stop_grace_period`             | `30s`                                  |
| The image build       | `PREVIOUS_IMAGE` build argument | the image running now                  |
| Each slot's container | Docker `HEALTHCHECK`            | `GET /api/health/live`, as the image's |
| Both slots            | A volume at `/var/lib/chopin`   | shared, for the Atomic journal         |

What each does is in [Self-hosting](self-hosting.md#runtime-configuration). The turn wait, the
unready window, the request wait and about three seconds to commit must fit inside
`stop_grace_period` with a margin, or the platform kills the old process before it releases the
lease and the new one waits out the lease's 30 s TTL, which is a visible outage. Both slots must
share `SESSION_ENCRYPTION_KEY`, `APP_ORIGIN`, `PREVIOUS_ORIGINS` and the GitHub App's client ID;
never change them in the same deploy as a version.

The Docker `HEALTHCHECK` asks the liveness endpoint, not `/api/session`, because a slot in standby
holds every other request. If you run the standby behind something that checks `/api/session`,
that check fails until the slot takes over.

Mount a volume at `/var/lib/chopin` if you run `HARNESS=atomic`: it keeps the Planner's
per-document directories and the workflow journal across a container replacement. Without it, a
run cannot resume after one.

## A remote Planner and its machine

Under `HARNESS=remote` a connected client keeps the document's Planner. A deploy is invisible to
it too, provided it follows the rules below.

- At the cut, the server writes each live link's sessions, waiting requests, unacknowledged
  answers and unheard Stops to storage, with a hand-over window of `HANDOVER_PLANNER_WINDOW_MS`
  from the release: the next process counts it from the moment it rebuilds the hold, so a slow
  write or release takes nothing from what the client was told. Until it ends, the document shows the machine as connected, and a message to
  it is saved and started when the client returns.
- A client that offered the `restart-notice` feature is sent `restarting` with
  `reconnectWithinMs` before the close. It must connect again at once and, if its `resume` is
  refused with `retry`, try again every 250 ms until `reconnectWithinMs` has passed, then on its
  own backoff. The new process does not refuse a `resume` inside that window because the owner's
  browser has not reconnected yet: it holds it, and answers when the browser's sign-in is back.
  See [Agent connection](agent-connection.md#when-the-server-is-restarting).
- A client without the feature sees a 1012 close and resumes on its own backoff. If that is
  longer than the window, the document shows the machine as away when the window ends, as for any
  lost connection, and what was sent meanwhile waits.
- A paired machine's backend keeps working: the credential the server issued it is stored by
  digest, so the new process accepts an unexpired one at once and the backend sees no HTTP 401.
  Older connectors need no change. The machine's connection itself is kept in memory, so its
  connector opens a new one as soon as the new process says it does not know it. Until then a
  machine whose backend holds a Planner, or is expected back within its window, is listed as
  connected and is the document's machine, and a document whose Planner such a machine held is
  still asked of it: each restored hold counts as the document being in use, since which documents
  are in use is not kept. Without that the connector's first poll would be told to run no
  Planners and would stop the backend.

A message to the document's machine is never refused because it is away. It appears in Chat at
once, is saved on the server, and is delivered by itself, in order and exactly once, when the
machine is back. Its mark says how far it has got: waiting to send while the browser itself is
offline, sent once the server has it, delivered once the machine took it. A deploy is one
more reason the machine can be away for a moment. See
[Saved requests](hosted-agent.md#saved-requests).

## Rollback

- **Migrations must be expand-only** while an old process serves beside a new one: add tables and
  columns, never drop or rename what the running release reads. A release with a contract step
  deploys by stop-then-start, with a visible gap. Chopin does not yet check this for you.
- The previous release refuses migration IDs it does not know, so rolling back to a release
  without this stage needs a database restore past the newer migrations, as before. The new
  tables are unused by it.
- Saved Planner requests are rows the previous release does not read. Before an older release
  takes over, a newer one should resolve every row (cancel those waiting, mark those started
  as interrupted, each with a notice). That drain option is not built.

## Try it locally

`scripts/overlap.ts` runs a deploy that overlaps two processes behind the reference proxy, asks
the proxy continuously, and reports the failures and the gap from the release to the first
answer:

```bash
# Two containers of one image, with Compose, the way a deploy script drives them.
docker build --tag chopin:one .
bun scripts/overlap.ts compose up --image chopin:one
docker build --build-arg PREVIOUS_IMAGE=chopin:one --tag chopin:two .
bun scripts/overlap.ts compose deploy --image chopin:two
bun scripts/overlap.ts compose down

# Two processes on the host (Linux) against a disposable, empty database, 20 hand-overs.
bun run build
bun scripts/overlap.ts processes --database 'postgresql://chopin:chopin@127.0.0.1:5432/overlap' --hand-overs 20
```

It exits 1 when any request was not answered 2xx, no request was answered after the release, the
gap passes `--max-gap-ms` (1.5 s, the browser's grace) or the old process did not exit 0.
`--warm-ms` (1.5 s) is the wait for the proxy to find the new slot before the old one is
stopped. The script's `startProxy` runs the same reference proxy for a test that starts the two
processes itself.

### The browser test of a hand-over

`e2e/handover.e2e.ts` starts the two processes itself, with a proxy in front, and hands the writer
lease from one to the other under open tabs, with a paired machine's Planner backend (and, in two
cases, a Planner attached under its owner's own sign-in) attached through the proxy. It is part of
`bun run e2e`, on ports 8801 to 8803 and a database of its own in the fourth database's cluster.
Its cases:

- A person types without stopping, with an unsent message in the composer, while the old process
  is stopped. The page is sampled every 25 ms: it says nothing of the connection or the machine
  (no notice of any kind), the machine's button never leaves its connected state, the page is not
  reloaded, every word typed arrives once and in order, the unsent message is kept, an agent's
  MCP session still works in the new process and an asset of a build that is gone is a 404. The
  same sample holds every case below to what the page offers, part by part, as it was when the
  hand-over began: Build plan, what Chat says before anyone has spoken, what the composer lets a
  person do, and the document's lock. A tab that comes back from a restart in silence draws
  what it drew before (`readsConnected` in `apps/web/src/wire-loss.ts`, and Chat's held
  participation), so Build plan does not go for the moment the socket is being opened again.
- A comment being written, with its words and its offer to send it to Chopin (made while a
  Planner runs for the document), is still open with both after the hand-over, and a comment
  started after it is offered the same.
- A message sent to the Planner with a turn running, one sent while the old process waits for the
  turn, a comment sent to Chopin, one typed before the cut and sent after it, and one the page had
  not yet sent, are each answered once and in the order they were accepted, and a teammate's tab
  and a tab opened afterwards see each reply once.
- A message sent from an open child keeps the child it was about, and the turn can read it in the
  new process.
- A message sent while the machine's Planner is away through the whole cut shows as sent, never as
  failed, and is delivered once, with one reply, when it is back.
- A Planner attached under its owner's sign-in, with a question left open, resumes within its
  window, with the owner's tab in front, with it really in the background, and with it frozen
  for a moment. The client resumes with its question still waiting, and the answer a member
  gives the card reaches that question, once, whether it is given before or after the client is
  back; no turn of its own follows it. A further case answers the question while the old process
  still waits for the turn that asked it: the turn receives the answer and no second turn
  follows. Another leaves the client away and has the same account attach again with nothing to
  resume after the answer was given: the answer is handed to it once, as a turn.

  Playwright makes every page it drives look focused and in front, which also keeps the page's
  timers at full speed, so a tab it launched cannot be put in the background whatever is in
  front of it. `e2e/background-browser.ts` therefore starts a headless Chromium itself and
  drives it over the DevTools protocol with Playwright's overrides off (`noDefaults`). A tab
  behind another there reads `hidden`, and a 25 ms timer in it fires about once a second (the test
  checks both before it begins), and `Page.setWebLifecycleState` freezes a tab as the browser
  does one it has left alone. It needs no display. What the owner's login did (a Planner's
  client resumes once the owner's browser has sent its cookie to the new process, retried
  every 250 ms):

  | Owner's tab                               | Planner resumed after the release          | Window |
  | ----------------------------------------- | ------------------------------------------ | ------ |
  | in front                                  | 407 to 582 ms                              | 10 s   |
  | in the background, timers at one a second | 736 to 929 ms                              | 10 s   |
  | frozen for 3 s after the release          | 3.1 to 3.3 s, 98 to 263 ms after it thawed | 10 s   |

  A background tab costs a few hundred milliseconds, so the design's assumption that the login is
  back by about 1.5 s holds for it. A frozen tab sends nothing, so its login, and with it the
  client's `resume`, waits for the tab to run again: a tab the browser keeps frozen for longer than
  the window is the design's bounded exception (open question 3 (h)): members then see the
  Planner away, as for a client that does not resume, and the hand-over logs a remote-Planner
  miss whose cause is the login. Nothing is shown to a teammate through any of the three, and
  the Planner is taken back with its question. A frozen tab learns that its sockets are gone when
  it runs again: the browser ends the sockets of a page it freezes (they close with 1006, no word
  from the server, deploy or none). A hidden page's timers run once a second and a frozen
  page's not at all, so its reconnect and the grace of the one notice fell due in the same tick
  and it said it was offline, locked, for the moment before the socket opened. The grace is now
  counted only while the page can be looked at (`countGrace` in `packages/editor`): a hidden or
  frozen tab says nothing of being offline, however long its connection takes to come back, and
  counts the grace whole from when it is shown, thawed or restored while the loss lasts. The test
  holds the frozen tab to what it holds every tab to, except that what it offers reads as it is
  until its sockets are open again (Build plan is gone meanwhile); a second test freezes a hidden
  tab with its connection away for longer than the grace and expects neither the notice nor the
  lock, then shows it while it is still away and expects the notice. Chromium's intensive throttling of a tab hidden for more than five minutes was not
  measured: it takes that long to begin.

The gap is measured from the old process's release of the lease, which the test sees by reading
the lease row, to the first request the proxy answers, by asking the proxy every 15 ms from four
clients. The test fails above the design's 750 ms budget (the browser's grace is 1.5 s, and it
prints both beside the measured gap). In 88 hand-overs on a developer machine (eight runs of the
file in a row, none failing) the first answer came 131 to 390 ms after the release (median 238 ms),
and in 22 behind the reference Caddy (two runs), 117 to 361 ms. Not one of the 332 to 1,134
requests per hand-over was answered anything but 2xx.

The proxy is `e2e/holding-proxy.ts`, which does what the reference Caddyfile does (checks
`/api/health/ready` every 250 ms, holds a request for up to 5 s while no upstream is ready,
retries a refused connection every 100 ms and keeps a WebSocket until a side closes it), because
CI cannot be assumed to have Caddy or a container to run it in; `e2e/holding-proxy.test.ts` holds
it to that. `CHOPIN_E2E_PROXY=caddy bun run e2e e2e/handover.e2e.ts` runs the reference proxy
instead, in a container on the host's network (Linux, with the `caddy:2.11-alpine` image).

## Deploy under load

`scripts/deploy-under-load.ts` is the design's deploy-under-load test: many clients do what
people, agents and machines do while Chopin is deployed over and over behind the reference proxy.
It takes minutes, so it is run by hand, or from the `deploy under load` workflow
(`.github/workflows/deploy-under-load.yml`, started with "Run workflow", with no schedule), and
is not part of `bun test` or of the required checks. It is what the design asks to pass on the
built image before strict invisibility is switched on in a hosted deployment.

```bash
# Two processes on this host, with the reference Caddy in a container on the host's network
# (Linux). The database is a disposable cluster; the run creates a database in it and drops it.
bun run build
bun scripts/deploy-under-load.ts --database 'postgresql://chopin:chopin@127.0.0.1:5432/chopin' \
  --documents 20 --editors 60 --hand-overs 10 --type-ms 1000

# The built image in the two-slot Compose project: what a deploy runs.
docker build --tag chopin:load .
bun scripts/deploy-under-load.ts --mode compose --image chopin:load \
  --documents 20 --editors 60 --hand-overs 10 --type-ms 1000
```

It prints a summary, writes a JSON report (`.scratch/deploy-under-load.json`, or `--report`) and
exits 1 when a gate fails. `--proxy holding` uses the stand-in proxy of the browser test where
there is no Docker, `--skip-build` leaves out the build, `--restart-jitter-ms` changes how long a
client waits before its first attempt after a restart it was told of (a tab's own is 1 s). It uses
ports 8810 to 8813.

**What runs.** Two real Chopin processes over one database, `HANDOVER=wait`, started and stopped
as a deploy does: either two processes on the host or the image in the Compose project of
[`deploy/overlap`](../deploy/overlap) (`compose.load.yaml` adds the fake GitHub of the browser
tests, the only thing that is faked besides the model that checks a reply). Through the proxy:

- **Editors.** Each is a signed-in socket with the editor and document a browser has (a headless
  Lexical editor bound to a Yjs document), typing a word into a paragraph of its own every
  `--type-ms`, keeping every update the server has not acknowledged and sending it again when it
  is back. It comes back after a loss on a tab's own ladder (`apps/web/src/wire-loss.ts`: the
  jittered first attempt after a restart it was told of, the probe before each later one, the
  rescue point at 1.2 s), so its gap means what a tab's does.
- **The owner's Planner.** A machine paired with a key, polling for the Planners Chopin asks for,
  and a backend attached for each document that answers each message once and resumes its session
  after a restart as [Agent connection](agent-connection.md) asks of one.
- **Planner requests of every kind.** Steadily, and before and during every deploy: a turn is
  running at the signal and a message waits behind it, and while the old process waits for that
  turn it is given one of each kind (a Chat message, an `invoke_planner` call, a system
  `invoke_planner` call, a comment note, a task draft), all saved as rows and started by the new
  process.
- **MCP.** Sessions that read documents every 200 ms and make the `invoke_planner` calls above.
- **A build.** The real connector (`apps/connector`) paired with a key, running the fake
  implementer of its own tests, which stops at its first task until the deploys are over, so a
  build is running through all of them.
- **The proxy's own view.** Four clients ask the proxy for a page, the session and a logout every
  15 ms, which is what the gap from the release to the first served request is measured by.

**What it records, and the gates.** For each deploy, from the moment the old process hears
SIGTERM: when readiness goes off, the listener stops, the lease is released and taken, the new
process answers ready and the proxy serves again, the cut's phases and the readiness checks it
refused as the old process logs them, how long the new process took to be ready, the old and new
process's processor use where they are processes on this host, and, for the clients, each one's
time from its socket closing to its document being open again, split into the wait before its
first attempt, the upgrade and the open. Over the run: every non-2xx answer the proxy gave, the
edits (every word typed against the stored document), the Planner requests and what became of
each, the MCP and API calls, each Planner's resume time against its window and any miss, the
database's peak connections, and how late the driver's own timers ran. A gate fails the run:

| Gate                                                                                                                       | Why                                       |
| -------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------- |
| Every old process exits 0                                                                                                  | It finished its cut inside its grace      |
| The first request is served within 750 ms of the release (`--max-gap-ms`)                                                  | The design's budget                       |
| No request through the proxy was not answered 2xx, apart from a request the cut closed at the in-flight bound (see below)  | The deploy is not seen by a request       |
| No client without its document longer than a tab waits before saying so: 5 s for a restart it was told of, 1.5 s otherwise | No notice                                 |
| No client's document was replaced under it                                                                                 | No `replaced` reset                       |
| Every word typed is in the stored document exactly once and in order                                                       | No edit lost or doubled                   |
| Every Planner request was acknowledged, reached the Planner exactly once, and none is left waiting                         | No request lost, doubled or left spinning |
| Every MCP and other API call was answered                                                                                  | The agents' sessions survive              |
| No Planner was withdrawn from its machine, and none missed its window                                                      | The remote Planner is never shown away    |
| A build that ran across the deploys finished Built: stopped, with no error, every task completed, a pull request for each  | Machines' work survives                   |

A failure counts as the request the cut closed only if it is the same method and path as one the
old process logged closing, is not a GET (the proxy tries a GET again on the new process), was
answered 502 or not at all, and ended while the old process was cutting. Each closed request
explains one failure: a second failure, or any other, fails the run, however many requests the cut
closed. A build counts as finished only when Chopin reports it stopped without an error, every
task completed and one pull request delivered for each; any other stopped run fails the gate.

The design's stricter 1.5 s grace is reported, not gated: the number of reconnects that took
longer, per deploy, is in the summary. The tab on this branch says nothing about a restart it
was told of for five seconds (`RESTART_QUIET_MS`), and a deploy of the shape measured here keeps
every client inside that.

**What it measured on this checkout** (a 256-core host, Bun 1.4.4, PostgreSQL 17 in Docker,
Caddy 2.11). The first two rows ran the image this checkout builds, the third its processes.
Every gate passed in each.

| Run                                                              | Deploys | First answer after the release | Not answered 2xx | Words lost or doubled |
| ---------------------------------------------------------------- | ------- | ------------------------------ | ---------------- | --------------------- |
| Image, 20 documents, 60 clients, a word a second, 4 MCP sessions | 10      | 183 to 288 ms                  | 0 of 15,136      | 0 of 6,638            |
| Image, 3 documents, 6 clients, with a build                      | 3       | 227 to 592 ms                  | 0 of 4,201       | 0 of 794              |
| Processes, 20 documents, 60 clients, reference Caddy             | 10      | 146 to 354 ms                  | 0 of 13,218      | 0 of 6,038            |

In the first row 282 Planner requests (114 Chat messages, 54 comment notes, 54 and 30
`invoke_planner` calls, 30 task drafts) were each started exactly once, 1,850 MCP calls were
answered, the build finished Built, and the slowest Planner client of each deploy resumed 522 to
895 ms after the release, inside its 10 s window. The old process's cut took 41 ms to commit, 21
to 24 ms to persist link state and 1 ms to release, after a 300 ms unready window in which the
proxy's checks were refused 63 times, and the new process was ready 22 to 44 ms after taking the
lease. The driver's own timers were late by at most 16 ms.

**What it found.**

- **The HTTP side is clean.** Across every run the proxy answered every request it was asked
  during a deploy, and the first answer came within the 750 ms budget.
- **A reconnect surge is the margin that is left.** With 60 clients on 20 documents, about one
  client in ten took longer than the design's 1.5 s to have its document open again (58 of 600
  in the image run, the longest 2.8 s), and none longer than the tab's 5 s. A client's time is
  the sum of three things, each given as its 50th percentile, 95th percentile and greatest in ms
  across the ten deploys: the wait before its first attempt (376 to 604, 928 to 993, up to
  999: the restart's jitter), the upgrade (126 to 231, 302 to 415, 329 to 523: the proxy holding
  it until the new process is ready, then the login restored from the database) and opening the
  document on a process that has not opened it (163 to 294, 504 to 1,921, 1,170 to 2,563: a cold
  process opening 20 documents for 60 sockets at once, on one thread). Removing the jitter does
  not remove the surge, it moves it: in three deploys of 60 clients on 20 documents, with no
  jitter 6 of 180 took longer than 1.5 s, with 250 ms 4 and with the tab's own 1 s, 10 and 11 in
  two runs. Twenty clients on 20 documents (0 of 60) and six on three stayed inside 1.5 s, and 60
  clients on 5 documents did not (4 of 180). The design asked for the upgrade to be measured at
  this moment, and this is that measurement: strict invisibility inside 1.5 s holds at the sizes
  the design's own targets covered, and is not shown for sixty clients. That is the limit to
  state when switching it on, and the number to improve; opening documents before the cut would
  be the way, and is not part of this stage.
- **A commit cost more with every open comment thread.** The load found it by growing: at the
  same offered load the old process used 73% of a core before the first deploy and 108% before
  the tenth, and an edit took 19 ms to be acknowledged and then 166 to 228 ms. A profile put it in
  `Comments.rebase`: each commit hashed the whole document once for every open thread. The hash of
  a committed state is now kept for that state (`digests` in `apps/server/src/plan/room.ts`),
  which about halves the growth: 84 to 102% of a core before the last deploys and edits in 78 to
  105 ms. Some growth with the number of threads is still left, and deploying does not cause it.
- **A saturated process cannot hand over.** At 60 clients typing four words a second on 20
  documents (240 updates a second) the one process stayed at 100% of a core, never answered a
  readiness check after SIGTERM and was killed at its 30 s grace, so the run failed its gates.
  The size to run is the documented one, a word a second from each of 60 clients.

**Reading a result.** The driver is one process, so its own timers must not be late: the summary
says by how much they were (14 to 21 ms here). The processor use of the old process says whether
a run measured the deploy or a server with no room left; above about 90% it is the latter.

## What is not done

These are in the design and are not part of this stage:

- **Release safety (Stage 2):** a check that a migration is expand-only, a canary and automatic
  rollback, a relaxed migration-ID check so the previous release runs against the newer schema,
  the rollback drain option above, and moving migrations off the critical path.
- **Several processes (Stage 3):** more than one process serving at once, document-level ownership
  and routing.
- **Connected machines (Stage 4):** updating a machine's connector when idle and resuming runs.
- **Running the deploy-under-load test on a schedule**, and switching strict invisibility on in a
  hosted deployment after it passes on the image that deployment ships. The test is built (see
  [Deploy under load](#deploy-under-load)) and run by hand or from a workflow dispatch.
