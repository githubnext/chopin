# Collaborative visual decision implementation plan

> Implement in small vertical slices with bounded worker ownership and review between slices.

**Goal:** Tune the real Chopin decision card collaboratively and save one attributed,
durable revision with its document projection.

**Architecture:** Reuse Questionnaire identity and its protected Lexical/MDX projection,
marked as the built-in visual specimen. Store a separate validated visual definition,
draft revision, per-control values, and saved attribution in the channel sidecar.
The trusted card owns controls; a verified immutable bundle renders QuestionView in
an opaque iframe on a credential-free origin.

**Stack:** TypeScript, Bun, React, existing Questionnaire dialect, fenced PostgreSQL
commits, the existing WebSocket, Vite, and Playwright. No Dial Kit dependency or
temporary experiment code enters the product.

## Slice 1: accepted shared draft and atomic Save

Files: `packages/protocol/visual-decision.d.ts`, `packages/question/src/visual.ts`, the
Questionnaire dialect files, `apps/server/src/visual-decisions/`,
`apps/server/src/plan/service.ts`, `apps/server/src/main.ts`.

- [x] Define bounded controls `optionPadding` (4, 6, 8 px) and `selectedColor`
  (`#RRGGBB`), immutable bundle identity and baseline, revisioned visual state,
  and create/open/edit/save frames (Reset edits back to baseline). Keep draft
  counters separate from document and storage counters.
- [x] Test validation, independent control edits, same-control accepted order,
  stale Save, in-flight claim, persistence failure/retry, restored state, and
  protected document projections before implementing each behavior.
- [x] Stage cloned state under the document queue; commit before map replacement,
  acknowledgement or broadcast. Save claims the accepted revision and atomically
  stages values, saver/time, record and existing Questionnaire projection.
- [x] Add writer-only built-in creation and mutation; permit viewers to open and
  observe. Recheck archived/implementation-lock and socket access boundaries.
- [x] Run relevant domain, dialect and persistence tests; inspect and commit.

## Slice 2: verified real-component preview and recovery

Files: `apps/web/src/visual-preview/`, producer/Vite configuration, dedicated
credential-free preview server and policy, fixed descriptor route, build commands.

- [x] Compile the real `QuestionView`, shared theme/option styles and local fonts
  into one immutable inline bundle with exact SHA-256 and response hash CSP.
- [x] Verify exact manifest/bytes in the trusted host. Fetch with credentials
  omitted from a fixed configured origin; no bundle URL controls host fetching.
- [x] Use `sandbox="allow-scripts"`, no referrer, source/origin/session/revision
  checked versioned messages, bounded size, and no authority from replies.
- [x] On every unexpected load rotate the handshake session; if readiness fails,
  replace the iframe from the trusted URL at most twice, then show host Retry.
  Preserve accepted values through replacement.
- [x] Gate non-loopback enablement on a separate registrable credential-free site;
  document operator obligations. Do not deploy.
- [x] Verify policy, bridge and bundle unit tests; inspect and commit.

## Slice 3: one preview and trusted controls

Files: `packages/editor/src/widgets/visual-decision.tsx`, small client/controller
and styles, Questionnaire renderer/Decisions integration, workspace descriptor.

- [x] Render one preview, Save decision in the header, right inspector on wide
  containers and controls below on narrow containers. Show current values.
- [x] Add bounded padding and colour inputs, shared Reset, live draft subscriptions,
  permission/disconnection/pending states and concise stale/failure recovery.
- [x] Implement pointer/touch and Space hold/release; clear on cancel/blur.
  Assistive activation toggles peek until next activation or focus loss.
- [x] Restore accepted draft on reconnect and saved values/saver/time on reload.
- [x] Add a bounded writer action to create the built-in decision in Decisions.
- [x] Run client/controller tests, inspect actual UI and commit.

## Slice 4: browser evidence and branch handoff

Files: `e2e/visual-decision*.e2e.ts`, preview E2E setup and focused fixtures,
`docs/visual-decisions.md`.

- [x] Exercise two authenticated editors: separate controls, same control, stale
  Save, held Save claim, reconnect, reload, durable values and attribution.
- [x] Inject a real storage commit failure through a test-only PostgreSQL trigger
  and prove no partial publication and successful retry. Test raw viewer mutation refusal.
- [x] Verify desktop/mobile layout, one preview, Reset and peek pointer/touch,
  Space and assistive activation including blur/cancel.
- [x] Repeat cookie/storage/egress/top-popup/self-navigation/bridge probes against
  actual response policy; prove recovery from blocked self-navigation, reject
  wrong/stale/malformed replies, and retain accepted draft values.
- [x] Run focused unit tests, browser integration, `bun run types`, `bun run fix`
  (inspect changes) and `bun run ci`; fix failures in scope.
- [x] Capture real wide/narrow/saved UI screenshots outside git; review the full
  branch, commit verified changes and report limits and next reviewable step.

## Progress and decisions

- Fresh worktree `/private/tmp/chopin-visual-decision`; branch
  `maggie/collaborative-visual-decision`; exact base `38561f45`.
- `6e131218` and its findings are evidence only. The production boundary is a new
  focused implementation; arbitrary/private bundle publication stays out of scope.
- Existing Questionnaire projections avoid a new Lexical collaboration node. A
  visual marker distinguishes rendering; authoritative values stay in the sidecar.
- Approved spec supplies the interaction/reference decisions; no new design
  approval or PR/merge is needed for this authorized branch implementation.
- Verification: 356 focused unit tests, 72 PostgreSQL persistence/lifecycle tests,
  and all 11 Chromium integration scenarios pass. Workspace/E2E TypeScript,
  production build, formatting and local CI pass.
- The broader unit run had four timing failures in existing Git/harness fixtures;
  isolated reruns passed. This is recorded without claiming a wholly green broad run.
- Real wide/narrow/saved screenshots are outside git. Production enablement still
  requires a reviewed credential-free preview site; historical digest retention
  also needs delivery work. No PR, merge or deployment was performed.
- Container packaging passed with verbose install logging, followed by a
  networking-disabled check of packaged bytes/CSP/manifest and preview imports.
  Local and Linux builds have different digests; retain published bundles across rebuilds.
