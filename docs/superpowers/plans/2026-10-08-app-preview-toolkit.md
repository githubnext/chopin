# App-preview toolkit implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Open one reviewable PR that shows how a local coding agent can prepare a
faithful, adjustable app-component preview using a skill and portable helpers.

**Architecture:** Keep the authoring toolkit in one canonical skill directory and
the runnable demonstration in a separate, database-free test harness. Reuse one
illustrative app's component source in its reference and preview views. Keep the
MCP request/result contract, production renderer and deployment with their owners.

**Tech stack:** Bun 1.4.2, TypeScript, React 19.2.4, Base UI 1.7.0, the repository's
pinned Vite and Playwright, native browser controls, app-owned CSS and local assets.

**Basis:** [Approved toolkit direction](../../app-preview-toolkit.md). Planning
branch: `maggie/app-preview-toolkit`, starting at
`7f95d854c9cca03081fbf19dd608fda078060c83`. The earlier decision-card branch and
experiment are evidence; do not merge their fixture implementation into this PR.

## Working rules

- Implement one slice at a time. Report what works, evidence and the next slice.
- Give workers explicit file ownership; they are not alone and must preserve
  others' changes. Keep dependent edits and integration sequential.
- Run meaningful tests at the narrowest layer. Use browser tests for layout,
  portals, pointer/keyboard ordering and isolation; do not simulate these in Bun.
- No live credentials, service calls, deployment, PR merge or invented MCP tools.
- Keep the whole skill portable. Helpers use relative imports and browser types,
  not `@chopin/*`, server internals or paths to this checkout.

## Slice 1: Portable control and preview helpers

**Files:**

- Create `skills/building-app-previews/assets/controls.ts` and `controls.test.ts`.
- Create `skills/building-app-previews/assets/preview.ts` and `preview.test.ts`.
- Create `skills/tsconfig.json`; extend the root `package.json` types command.

- [ ] Specify the authoring interface before implementation. Numeric controls have
      an ID, label, unit, minimum, maximum and step; colours use `#RRGGBB`. A
      separate baseline supplies one value per declared control. This local API
      describes rendering inputs, not an MCP envelope.
- [ ] Add failing unit cases for duplicate/unsafe IDs, unknown or missing values,
      non-finite numbers, range and step errors, invalid colours, invalid baseline
      and attempted mutation of retained definitions. Use two differently named
      definitions so no Chopin-specific parameter survives.
- [ ] Implement validation and `createPreview(definition, render)`. Its `apply`
      method accepts a complete snapshot and calls the supplied renderer only
      after validation; `reset` applies the immutable baseline. Return explicit
      failures. A callback receiving values is not proof of browser paint.
- [ ] Test callback failure and retry, and verify invalid input never invokes it.
      A fresh consumer must be able to copy the helpers together and typecheck
      without a Chopin runtime dependency.
- [ ] Run `bun test skills/building-app-previews/assets` and `bun run types`.
      Expected: helper tests and the new skill typecheck pass.
- [ ] Run `bun run fix`, inspect the diff, commit this slice.

## Slice 2: One real component and a built local preview

**Files:**

- Create `e2e/app-preview-toolkit/fixture-app/billing-card.tsx`, `components.tsx`,
  `theme.css`, `main.tsx`, `index.html` and `assets/mark.svg`.
- Create `e2e/app-preview-toolkit/preview.tsx`, `preview.html`, `build.ts`,
  `server.ts`, `host.ts`, `host.css` and `index.html`.
- Modify root `package.json`, `bun.lock` and `e2e/tsconfig.json` as needed for
  explicit test dependencies, JSX and the `preview-toolkit:dev` command.

- [ ] Build an illustrative billing app with a price row, action button and Base
      UI popover. Use its own tokens, bundled mark and local font. Declare the
      fixture's test dependencies explicitly; do not resolve them through hidden
      imports into another workspace's `node_modules`.
- [ ] Render the source-app view with fixture data. Render the preview by importing
      the same billing card, children and theme. Only the preview entry imports
      the skill helper and maps spacing/accent values to actual props or tokens.
- [ ] Build the source reference and preview with the pinned Vite dependencies.
      Reuse the target CSS/asset pipeline. Produce static resources with an exact
      file list and SHA-256 checksums; omit private paths, credentials and fixture
      data that was not selected for the preview. Do not claim this list is the
      engineer's eventual result schema or production integrity policy.
- [ ] Serve built resources on loopback from a separate preview origin. The
      demonstration frame uses `sandbox="allow-scripts"`; the local-only message
      receiver checks its parent/source and validates snapshots. Keep that demo
      transport in `e2e/`, outside the portable authoring API.
- [ ] Add native numeric/colour inputs, Reset, press-and-hold baseline peek and
      wide/narrow layout. Provide Copy/Download values, clearly labelled local
      output. Never label this action Save decision or claim shared persistence.
- [ ] Show build/load/render failures in the host with a retry path. Confirm a
      failed render does not silently replace the user's requested values.
- [ ] Run the built preview after stopping development compilation. Document
      `bun run preview-toolkit:dev` as the direct local review command.
- [ ] Run `bun run fix`, inspect changes, commit the working example.

## Slice 3: Browser evidence and CI

**Files:**

- Create `e2e/app-preview-toolkit/playwright.config.ts` and `preview.e2e.ts`.
- Modify `e2e/playwright.config.ts`, root `package.json` and `.github/workflows/ci.yml`.

- [ ] Add a database-free Playwright configuration with fresh loopback servers,
      `reuseExistingServer: false`, wide/narrow Chromium projects and ignored
      output directories. Add `preview-toolkit:test` and a browser CI step.
      Exclude these tests from the PostgreSQL suite's recursive discovery.
- [ ] Compare screenshots of the source-app component and embedded baseline at
      equal component widths after fonts load. Require equal output within a
      documented rendering tolerance; do not manufacture separate lookalike markup.
- [ ] Check numeric and colour changes in computed styles and visible content,
      child rendering, portal visibility, font/asset loading and narrow overflow.
      Exercise pointer hold/release/cancel, Space hold/release, blur and Reset;
      peeking must leave exported chosen values unchanged.
- [ ] Send malformed/out-of-range snapshots and a message from another window.
      Verify rejection and unchanged display. Exercise a failed render and retry
      with the last requested valid snapshot.
- [ ] Observe console errors, failed resources and unexpected network attempts.
      Check the frame cannot read parent DOM/storage. State that local browser
      checks do not certify production hosting or private-code publication.
- [ ] Run `bun run preview-toolkit:test`, `bun test skills`, `bun run types`,
      `bun run ci` and `bun run build`. Inspect production output for fixture
      markers and toolkit imports; all demonstration UI must remain absent.
- [ ] Capture and inspect real wide/narrow/baseline/adjusted screenshots for the
      PR. Keep generated reports and screenshots out of the code diff.
- [ ] Commit tested browser coverage and CI integration.

## Slice 4: Skill, instructions and an independent agent trial

**Files:**

- Create `skills/building-app-previews/SKILL.md`, `prompt.md` and references
  `react-preview.md`, `capabilities.md` and `reporting.md`.
- Create `.agents/skills/building-app-previews` as its canonical relative symlink.
- Update `docs/app-preview-toolkit.md` and link it from `docs/local-agent-mcp.md`.

- [ ] Write a short provider-neutral skill: inspect the target repo and real
      component, preserve required context, choose meaningful controls, prepare
      fixtures, build, verify fidelity, report resources/evidence/limits. Follow
      the target app's design instructions and currently supplied capabilities.
- [ ] Document dependency/provider/portal/font requirements and extraction of
      server-coupled views. Describe runtime CSS injection and large bundles as
      compatibility cases requiring evidence, not promises of universal support.
- [ ] Give concrete helper usage and a starter request. Installation means the
      whole skill folder, including assets and references; verify harness
      discovery or explicitly read the skill. Do not prescribe global config
      changes or imply that copying a skill starts MCP work.
- [ ] Document source commit/dirty state, component and token references,
      control units/baseline, built-resource checksums, browser evidence and
      limitations. Use the current supplied MCP descriptors for publication;
      otherwise return local resources and explicitly report integration absent.
- [ ] Give a fresh subagent the skill, a small second component in a disposable
      app workspace and a realistic preview request. It owns only its temporary
      workspace and has no publication permissions. Do not give it the intended
      answer or the first fixture's completed adapter.
- [ ] Build and browser-check its actual output; report fidelity, dependency and
      control errors. Revise instructions only for observed failures and repeat
      the affected checks. Record the trial's useful outcome in the toolkit docs.
- [ ] Validate frontmatter, exact-case relative links and copied helper use;
      run `bun run fix`, inspect its changes and run `bun run ci`.
- [ ] Commit the skill and its documented evidence.

## Slice 5: Reviewable PR handoff

- [ ] Run the focused units and browser suite, `bun run types`, `bun run ci` and
      `bun run build`. Run the normal unit suite once before handoff; investigate
      actual new failures and report any unrelated baseline failures accurately.
- [ ] Request two independent code reviews: toolkit/skill usability and browser
      behaviour/boundary correctness. Resolve material findings in small commits.
- [ ] Use `pr-visual-preview` to attach real UI images and a compact architecture
      diagram; verify the images render in the published description.
- [ ] Open a regular PR from `maggie/app-preview-toolkit`. Explain that this adds
      agent-side authoring tools and a tested local example, with no production
      Chopin feature, MCP publication, durable Save or private hosting.
- [ ] Check GitHub validation, browser and container jobs. Hand Maggie and
      Krzysztof the PR, local review command, screenshots, remaining limits and
      the narrow next integration step: map these authoring outputs and render
      callback into the supplied request/result and production preview contracts.
      Do not send a Slack/email message or merge/deploy without explicit instruction.
