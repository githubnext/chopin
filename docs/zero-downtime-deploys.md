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
  Older connectors need no change.

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
processes itself, such as the browser test of a hand-over under an open tab.

## What is not done

These are in the design and are not part of this stage:

- **Release safety (Stage 2):** a check that a migration is expand-only, a canary and automatic
  rollback, a relaxed migration-ID check so the previous release runs against the newer schema,
  the rollback drain option above, and moving migrations off the critical path.
- **Several processes (Stage 3):** more than one process serving at once, document-level ownership
  and routing.
- **Connected machines (Stage 4):** updating a machine's connector when idle and resuming runs.
- **A deploy-under-load test** with many clients and every kind of work through the proxy, run
  nightly or by hand, and switching strict invisibility on in a hosted deployment after it passes.
