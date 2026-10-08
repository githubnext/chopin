# Collaborative visual decisions

In **Decisions**, a repository writer can choose **Tune decision card** to create
the built-in visual decision. It renders Chopin's real decision options with two
controls: vertical padding of 4, 6, or 8 px, and selected-option colour in
`#RRGGBB` format. The inspector sits beside the preview when the card has room and
below it in a narrow container. Hold **Show current** to see the frozen baseline.
An assistive activation toggles that view until another activation or focus loss.

Editors share accepted control values live. Different controls converge
independently; the last server-accepted edit wins for a control. **Reset** changes
the shared draft. Native controls follow input immediately while acknowledgements
catch up; the preview shows accepted values. Unfinished colour text stays local
and survives unrelated padding updates. Viewers observe updates and can peek,
but cannot edit or save.
Reconnect restores accepted state before replaying unacknowledged edits. Durable
client sequence high-water marks prevent a lost acknowledgement from replaying
an old value over a collaborator's newer edit.

**Save decision** claims one accepted revision, pauses further edits, and stages
the values, saver, timestamp, and Questionnaire document projection together.
Publication follows the fenced durable commit. A stale Save returns the latest
values for review. An explicitly rolled-back PostgreSQL transaction releases the
claim for retry; uncertain connection, fencing, and corruption failures retain
the existing fatal storage boundary. A saved visual decision is immutable and
appears in resolved decision history.

The sidecar owns the immutable definition, draft, and saved record. The
Questionnaire's `visual="decision-card-v1"` marker selects the renderer; its
attributed Answer is a protected projection, not editable authority. Visual
draft revisions are independent of document, Yjs, and storage counters.

## Local preview

`bun run build` produces the inline preview bundle from the real `QuestionView`,
shared theme, and embedded local fonts. It also writes the exact SHA-256 manifest
and hash-based CSP. Generated files under `apps/web/preview/dist` are ignored.
The experiment at `6e131218` informed the boundary, but none of its temporary jig
or Dial Kit is a production dependency.

Run the dedicated preview process separately:

```bash
VISUAL_PREVIEW_APP_ORIGIN=http://127.0.0.1:8787 bun run start:visual-preview
```

Set `VISUAL_PREVIEW_ORIGIN=http://localhost:8793` on the Chopin process. The local
hosts deliberately differ. Without a configured preview, visual decision
creation is refused. Existing records remain durable.

The authenticated trusted host obtains a fixed descriptor, fetches preview bytes
with credentials omitted, checks the manifest, digest and response CSP, then
loads an opaque `sandbox="allow-scripts"` iframe. The preview accepts only
versioned messages from its parent. Replies must match the current frame source,
opaque origin, session, revision and values; replies never update saved values.
Host CSP restricts frame navigation to the configured preview origin. Each
unexpected load starts a fresh handshake; failure replaces the frame at most
twice, then exposes a host-owned **Retry preview** action. Replacement retains
the latest desired values.

## Production deployment gate

Do not enable this feature on a production instance until a separate
credential-free preview site is provisioned and reviewed. A second port or a
sibling subdomain of the Chopin site is insufficient.

Non-loopback configuration requires HTTPS for both sites, distinct registrable
domains (including private public-suffix rules), and
`VISUAL_PREVIEW_CREDENTIAL_FREE=1`. That flag is an operator assertion. The
preview site's ingress, cookies, authentication, redirects and response headers
must be checked before setting it; runtime domain checks cannot establish those
operational facts. The site must serve only the verified immutable bundle and
manifest, with the expected CSP, no reusable Chopin credential, no Set-Cookie,
and no bundle-controlled fetch targets. Set `VISUAL_PREVIEW_APP_ORIGIN` to the
exact application origin, and the preview host/port to its deployment bindings.
The application's CSP and preview frame-ancestor policy bind those origins.

This branch does not deploy either site. Historical bundle retention is another
delivery requirement before rebuilding a published specimen: local and Linux
container builds produced different digests at the same source revision. Retain
the exact published bytes rather than regenerating an old bundle. The current
server serves one digest, so an older saved decision safely shows an unavailable
preview after a bundle change. Its frozen baseline, values and attribution remain
in the record; silently substituting the new bundle is refused.

## Verification and limits

The focused browser suite uses real authentication, WebSockets, document
collaboration and PostgreSQL:

```bash
bun run e2e --config e2e/visual-decision.playwright.config.ts
```

Its Save failure and in-flight claim probes use a test-only PostgreSQL trigger
and advisory lock, never a production failure endpoint. It checks concurrent
edits, stale and rolled-back Saves, reconnect/reload, write permissions, protected
projections, wide/narrow placement, pointer/touch/Space/assistive peek, immutable
bytes, cookies/storage, egress/navigation and bridge rejection/recovery.

The built-in public specimen contains no private repository code. There is no
arbitrary bundle publication or decision editing after Save. A document permits
20 visual decisions; each decision retains up to 512 editing client sessions
without evicting deduplication history. The iframe has no hard CPU or memory
quota. Schema-valid size claims can be false; the trusted host caps displayed
height at 300–640 px. Browser evidence is Chromium-specific and does not certify
arbitrary code, private bundles, or other browser engines.

The focused unit run passed 356 tests, all 72 PostgreSQL persistence/lifecycle
tests passed, and all 11 Chromium integration scenarios passed. TypeScript,
build and local CI validation passed. The container build passed with verbose
install logging; a networking-disabled runtime check verified its packaged
manifest, bytes, CSP and preview imports. The broader unit run
passed 4,187 tests with three skips and four timing failures in existing
Git/harness fixtures. Those failures passed isolated reruns; the broad run itself
was not wholly green.
