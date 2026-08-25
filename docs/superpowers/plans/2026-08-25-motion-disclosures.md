# Purposeful Motion Disclosures Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give pointer-owned Project, decision-history, research-result, and chat-tool disclosures bounded expansion and icon motion while keyboard and reduced-motion paths remain immediate.

**Architecture:** Consume slice 1's app-owned `collapse` contract and add its bounded CSS recipe, then inject that structural contract into editor-owned surfaces so `@chopin/editor` never depends on the web app. One shared wrapper owns retained exit, interruption, `inert`, and `aria-hidden`; each consumer keeps its state, content, and accessible trigger.

**Tech Stack:** React 19, TypeScript, native CSS transitions, `useTransitionPresence`, Bun tests, Playwright.

---

## Dependency gate and file map

Do not implement against the current detached design commit. After slice 1 merges:

```bash
git switch -c maggie/motion-disclosures
git fetch origin
git rebase origin/main
rg -n "MotionKind|MOTION_STATES|motionContract|closeDuration" apps/web/src --glob '*.{ts,tsx}'
```

Expected: `apps/web/src/motion-contract.ts` already owns `collapse` with a 250ms close duration and the shared motion states. Slice 2 consumes that shipped contract rather than changing or duplicating it.

Files:

- `apps/web/src/theme.css`, `theme.test.ts`: collapse CSS states and icon motion.
- New `packages/editor/src/disclosure-motion.tsx` and test; `packages/editor/src/index.ts`: shared retained wrapper.
- `apps/web/src/project-sidebar.tsx`, `navigation-chrome.test.ts`: Projects.
- `packages/editor/src/decisions.tsx`, `decisions.test.tsx`: resolved history.
- `packages/editor/src/background-work.tsx`, `background-work.test.ts`: research results.
- `apps/web/src/chat/transcript.tsx`: finished tool logs.
- `apps/web/src/room-workspace.tsx`: inject the app contract and input sampler into editor surfaces.
- `e2e/document-navigation.e2e.ts`, `sidecar.e2e.ts`, `jobs.e2e.ts`, `smoke.e2e.ts`: browser policy.

### Task 1: Implement the shipped collapse contract in CSS

**Files:**

- Modify: `apps/web/src/theme.css`
- Modify: `apps/web/src/theme.test.ts`

- [ ] **Step 1: Write failing static CSS assertions**

Add a `disclosure motion` suite to `theme.test.ts` that asserts the shipped contract's recipe:

```ts
expect(THEME).toMatch(/\.motion-collapse\s*{[^}]*var\(--acc-expand\)[^}]*var\(--motion-move\)/s);
expect(THEME).toMatch(/\.motion-collapse\.is-closing\s*{[^}]*var\(--acc-collapse\)/s);
expect(THEME).toMatch(
	/:root\[data-motion-input="pointer"\][^{]*\.motion-disclosure-icon[^}]*var\(--icon-swap-dur\)/s,
);
expect(THEME).toMatch(
	/@media \(prefers-reduced-motion: reduce\)[\s\S]*\.motion-collapse[^{]*{[^}]*transition:\s*none/s,
);
```

- [ ] **Step 2: Verify red**

Run: `bun test apps/web/src/theme.test.ts`

Expected: FAIL because the `collapse` selectors are absent.

- [ ] **Step 3: Add the bounded CSS recipe**

Keep slice 1's `--acc-expand` and `--acc-collapse` at 250ms, matching the shipped registry duration, then add:

```css
.motion-collapse {
	display: grid;
	grid-template-rows: 0fr;
	transition: grid-template-rows var(--acc-expand) var(--motion-move);
}

.motion-collapse-content {
	min-height: 0;
	overflow: hidden;
	opacity: 0;
	transform: translateY(-4px);
	transition:
		opacity var(--acc-expand) var(--motion-move),
		transform var(--acc-expand) var(--motion-move);
}

.motion-collapse.is-open {
	grid-template-rows: 1fr;
}
.motion-collapse.is-open > .motion-collapse-content {
	opacity: 1;
	transform: translateY(0);
}
.motion-collapse.is-closing {
	grid-template-rows: 0fr;
	transition-duration: var(--acc-collapse);
}
.motion-collapse.is-closing > .motion-collapse-content {
	opacity: 0;
	transform: translateY(-4px);
	transition-duration: var(--acc-collapse);
}

.motion-disclosure-icon {
	display: inline-flex;
	transform: rotate(0deg);
}
:root[data-motion-input="pointer"] .motion-disclosure-icon {
	transition: transform var(--icon-swap-dur) var(--motion-smooth-out);
}
.motion-disclosure-icon[data-open] {
	transform: rotate(90deg);
}
```

Add `.motion-collapse`, `.motion-collapse-content`, and `.motion-disclosure-icon` to the existing reduced-motion rule with `transition: none`.

- [ ] **Step 4: Verify green and commit**

Run: `bun test apps/web/src/motion-contract.test.ts apps/web/src/theme.test.ts`

```bash
git add apps/web/src/theme.css apps/web/src/theme.test.ts
git commit -m "Add collapse motion contract"
```

### Task 2: Add shared retained disclosure content

**Files:**

- Create: `packages/editor/src/disclosure-motion.tsx`
- Create: `packages/editor/src/disclosure-motion.test.tsx`
- Modify: `packages/editor/src/index.ts`

- [ ] **Step 1: Write the failing wrapper tests**

Server-render `MotionDisclosure` with
`motion={{ className: "motion-collapse", closeDuration: 250 }}`. Assert an open render contains its id, `data-motion-disclosure`, and `motion-collapse-content`; assert a closed render is empty. Also assert:

```ts
expect(disclosureAccessibility("closing")).toEqual({
	ariaHidden: "true",
	inert: true,
});
```

- [ ] **Step 2: Verify red**

Run: `bun test packages/editor/src/disclosure-motion.test.tsx`

Expected: FAIL because the module is missing.

- [ ] **Step 3: Implement the injected wrapper**

```tsx
import { useTransitionPresence } from "./transition-presence";
import type { PresencePhase } from "./transition-presence";
import type { ReactNode } from "react";

export type MotionDisclosureContract = {
	readonly className: string;
	readonly closeDuration: number;
};

export function disclosureAccessibility(phase: PresencePhase) {
	let active = phase !== "closing";
	return { ariaHidden: active ? undefined : "true" as const, inert: !active };
}

export function MotionDisclosure(
	{ children, className = "", id, immediately, motion, open, surface }: {
		children: ReactNode;
		className?: string;
		id: string;
		immediately: boolean;
		motion: MotionDisclosureContract;
		open: boolean;
		surface: string;
	},
) {
	let presence = useTransitionPresence(open ? true : undefined, motion.closeDuration, immediately);
	if (presence.phase === "closed") return null;
	let accessibility = disclosureAccessibility(presence.phase);
	return (
		<div
			aria-hidden={accessibility.ariaHidden}
			className={`${motion.className} ${presence.className} ${className}`.trim()}
			data-motion-disclosure={surface}
			id={id}
			inert={accessibility.inert}
		>
			<div className="motion-collapse-content">{children}</div>
		</div>
	);
}

export function MotionDisclosureIcon({ children, open }: { children: ReactNode; open: boolean }) {
	return (
		<span aria-hidden="true" className="motion-disclosure-icon" data-open={open ? "" : undefined}>
			{children}
		</span>
	);
}
```

Export both components, `disclosureAccessibility`, and `MotionDisclosureContract` from `index.ts`.

- [ ] **Step 4: Verify and commit**

Run: `bun test packages/editor/src/disclosure-motion.test.tsx && bun run types`

```bash
git add docs/superpowers/plans/2026-08-25-motion-disclosures.md packages/editor/src/disclosure-motion.tsx \
	packages/editor/src/disclosure-motion.test.tsx packages/editor/src/index.ts
git commit -m "Add shared disclosure motion presence"
```

### Task 3: Animate Project expansion

**Files:** `apps/web/src/project-sidebar.tsx`, `apps/web/src/navigation-chrome.test.ts`, `e2e/document-navigation.e2e.ts`

- [ ] **Step 1: Write failing tests**

The markup test asserts an expanded Project trigger has `aria-controls`, and its body has `data-motion-disclosure="projects"`. The browser test pointer-collapses the seeded `score` Project, asserts retained content is immediately `aria-hidden` and `inert`, then clicks the trigger during exit and asserts the same content becomes active with no duplicate.

Run: `bun test apps/web/src/navigation-chrome.test.ts`

Expected: FAIL because the body conditionally unmounts.

- [ ] **Step 2: Wrap the existing body**

In `Project`, add `useId`, `MotionDisclosure`, `motionContract`, and `motionImmediately`:

```tsx
let contentId = useId();
let collapseMotion = motionContract("collapse");
```

Set `aria-controls={contentId}` on the existing trigger. Move the existing unavailable, error, loading, channel/research, loading-more, and load-more branches unchanged inside:

```tsx
<MotionDisclosure
	id={contentId}
	immediately={motionImmediately()}
	motion={collapseMotion}
	open={expanded}
	surface="projects"
>
	<div className="project-sidebar-project-content">{projectContent}</div>
</MotionDisclosure>;
```

Use a local `projectContent` React node containing those existing branches; do not animate updates while the Project is already open.

- [ ] **Step 3: Verify and commit**

Run: `bun test apps/web/src/navigation-chrome.test.ts`

Run: `bun run e2e -- e2e/document-navigation.e2e.ts`

```bash
git add apps/web/src/project-sidebar.tsx apps/web/src/navigation-chrome.test.ts e2e/document-navigation.e2e.ts
git commit -m "Animate Project disclosures"
```

### Task 4: Animate decision history and caret state

**Files:** `packages/editor/src/decisions.tsx`, `decisions.test.tsx`, `apps/web/src/room-workspace.tsx`, `e2e/sidecar.e2e.ts`

- [ ] **Step 1: Write failing tests**

Extend the server-render helper with the fixture contract. Assert restored open history has `aria-controls`, `data-motion-disclosure="decision-history"`, and one `.motion-disclosure-icon[data-open]`. In Playwright, focus `1 resolved`, press Space, assert content appears without `is-closing`; press Space again and assert immediate unmount.

Run: `bun test packages/editor/src/decisions.test.tsx`

- [ ] **Step 2: Retain history and rotate one caret**

Add required `motion: MotionDisclosureContract` and optional `motionImmediately?: () => boolean` props, plus `useId`. Set `aria-controls` on the trigger. Remove `CaretDownIcon`; render:

```tsx
<MotionDisclosureIcon open={history}>
	<CaretRightIcon size={16} weight="bold" />
</MotionDisclosureIcon>
<MotionDisclosure
	className="plan-decision-history-motion"
	id={historyId}
	immediately={motionImmediately?.() ?? false}
	motion={motion}
	open={history}
	surface="decision-history"
>
	<div className="mt-2 flex flex-col gap-3">{settled.map(question)}</div>
</MotionDisclosure>
```

In `RoomWorkspace`, pass `motion={motionContract("collapse")}` and the existing `settleMotionImmediately` function. Do not change storage, reveal focus, highlights, or ordering.

- [ ] **Step 3: Verify and commit**

Run: `bun test packages/editor/src/decisions.test.tsx`

Run: `bun run e2e -- e2e/sidecar.e2e.ts`

```bash
git add packages/editor/src/decisions.tsx packages/editor/src/decisions.test.tsx \
	apps/web/src/room-workspace.tsx e2e/sidecar.e2e.ts
git commit -m "Animate decision history disclosure"
```

### Task 5: Animate completed research results

**Files:** `packages/editor/src/background-work.tsx`, `background-work.test.ts`, `apps/web/src/room-workspace.tsx`, `e2e/jobs.e2e.ts`

- [ ] **Step 1: Write failing tests**

Server-render `BackgroundJob` with a completed result and fixture contract; assert the closed trigger has `aria-controls` and no result content. Add Playwright coverage that reduced motion opens immediately, pointer-close enters retained `aria-hidden`/`inert`, and enabling reduced motion during exit unmounts immediately.

- [ ] **Step 2: Wrap resolved detail without delaying its fetch**

Add `motion: MotionDisclosureContract` and `motionImmediately?: () => boolean` to `BackgroundWorkProps`, pass them to `BackgroundJob`, and add `useId`. Keep `store.detail(job.id)` in the existing toggle. Set `aria-controls` on the trigger and replace both result conditionals with:

```tsx
<MotionDisclosure
	id={resultId}
	immediately={motionImmediately?.() ?? false}
	motion={motion}
	open={open && detail !== undefined}
	surface="research-result"
>
	{artifact
		? (
			<div className="plan-background-job-result">
				<h3>{artifact.title}</h3>
				<p>{artifact.summary}</p>
			</div>
		)
		: <p>Result is unavailable.</p>}
</MotionDisclosure>;
```

Pass the app contract and sampler from `RoomWorkspace`. Do not animate progress, running status, artifact arrival before detail resolves, cancellation, or errors.

- [ ] **Step 3: Verify and commit**

Run: `bun test packages/editor/src/background-work.test.ts`

Run: `bun run e2e -- e2e/jobs.e2e.ts`

```bash
git add packages/editor/src/background-work.tsx packages/editor/src/background-work.test.ts \
	apps/web/src/room-workspace.tsx e2e/jobs.e2e.ts
git commit -m "Animate research result disclosures"
```

### Task 6: Animate finished chat tool logs and caret state

**Files:** `apps/web/src/chat/transcript.tsx`, `e2e/smoke.e2e.ts`

- [ ] **Step 1: Write the failing browser assertion**

Extend `chat groups authors and collapses a finished tool run`: after opening, assert one icon has `data-open`; close and assert the log remains `aria-hidden` and `inert`; reopen before exit completes and assert the same log and icon become open.

Run: `bun run e2e -- e2e/smoke.e2e.ts --grep "chat groups authors"`

- [ ] **Step 2: Retain the log and rotate one right caret**

Add `useId`, the shared disclosure pieces, `motionContract`, and `motionImmediately`. Remove the down-chevron import. Keep the running tool row unchanged. Set `aria-controls` on the finished-run trigger, wrap the existing right-chevron image in `MotionDisclosureIcon`, and wrap the existing `<ul aria-label="Tool calls">` in:

```tsx
<MotionDisclosure
	id={contentId}
	immediately={motionImmediately()}
	motion={motionContract("collapse")}
	open={open}
	surface="chat-tools"
>
	{toolList}
</MotionDisclosure>;
```

Do not animate streaming text, running tools, loader rotation, or activity updates.

- [ ] **Step 3: Verify and commit**

Run: `bun test apps/web/src/chat/model.test.ts`

Run: `bun run e2e -- e2e/smoke.e2e.ts --grep "chat groups authors"`

```bash
git add apps/web/src/chat/transcript.tsx e2e/smoke.e2e.ts
git commit -m "Animate chat tool disclosures"
```

### Task 7: Verify and deliver a ready PR

- [ ] **Step 1: Format and inspect**

```bash
bun run fix
git status --short
git diff --check
git diff --stat origin/main...HEAD
```

Expected: only the planned disclosure implementation, tests, and plan file changed.

- [ ] **Step 2: Run narrow tests, types, and validation**

```bash
bun test apps/web/src/motion-contract.test.ts apps/web/src/theme.test.ts \
	packages/editor/src/disclosure-motion.test.tsx packages/editor/src/decisions.test.tsx \
	packages/editor/src/background-work.test.ts apps/web/src/navigation-chrome.test.ts \
	apps/web/src/chat/model.test.ts
bun run types
bun run ci
```

Expected: PASS.

- [ ] **Step 3: Run relevant Playwright files**

Stop developer processes on ports 8788 and 8789, then run:

```bash
bun run e2e -- e2e/document-navigation.e2e.ts e2e/sidecar.e2e.ts \
	e2e/jobs.e2e.ts e2e/smoke.e2e.ts
```

Expected: PASS for pointer interruption, keyboard immediacy, reduced-motion settlement, accessibility, and existing behaviour.

- [ ] **Step 4: Rebase, rerun gates, and open the PR**

```bash
git fetch origin
git rebase origin/main
bun run types
bun run ci
git push -u origin maggie/motion-disclosures
gh pr create --base main --head maggie/motion-disclosures \
	--title "Animate disclosure expansion" \
	--body "Implements purposeful-motion slice 2 for Projects, decision history, research results, and chat tool logs. Pointer-owned changes use the shared collapse contract; keyboard and reduced-motion paths settle immediately."
gh pr checks --watch
```

Fix any check failure with the narrowest regression, push, and watch again. Stop with a ready, passing PR; do not merge.

## Self-review

- All four surfaces consume slice 1's registry entry; editor packages receive it as data.
- Pointer expansion is bounded to one clipped container; close is retained and interruptible.
- Keyboard and reduced-motion paths are immediate, including preference changes during exit.
- Closing content is immediately `inert` and `aria-hidden`.
- Existing caret assets rotate as one element; Project and research semantics are not redesigned.
- Streaming, progress, typing, selection, reference pickers, and running tools remain immediate.
- CSS uses semantic tokens, stays below 300ms, and has a reduced-motion rule.
- The PR is ready and passing, and remains unmerged.
