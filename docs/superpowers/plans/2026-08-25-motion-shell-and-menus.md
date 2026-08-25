# Shell and Menus Motion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development
> (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add purposeful, pointer-owned motion to the desktop Projects sidebar, document action
menus, and comment preview tooltips without changing their keyboard, focus, responsive, or
reduced-motion behaviour.

**Architecture:** Keep `useTransitionPresence` as the mount/unmount lifecycle authority. Add a
small app-owned semantic registry for the two contracts used by this slice (`popover` and
`sidebar`), with CSS in the app theme/navigation styles; keep the editor tooltip contract in the
editor stylesheet so the editor package never depends on the web app. Drive geometry from the
already measured trigger and keep browser-owned timing, focus, inertness, and breakpoint checks in
Playwright.

**Tech Stack:** React 19, TypeScript, CSS transitions and custom properties, Bun tests, Playwright
Chromium.

---

## File map

- Create `apps/web/src/motion-contract.ts`: semantic app-shell class and close-duration registry.
- Create `apps/web/src/motion-contract.test.ts`: exact contract mapping and state-class coverage.
- Modify `apps/web/src/theme.css`: declare the on-screen movement easing token and popover states.
- Modify `apps/web/src/theme.test.ts`: statically prove token use and reduced-motion coverage.
- Modify `apps/web/src/navigation-shell.tsx`: retain and isolate the inline sidebar during exit.
- Modify `apps/web/src/navigation.css`: animate the bounded sidebar track and its child.
- Modify `apps/web/src/document-actions-menu.tsx`: measured presence, trigger origin, exit inertness.
- Modify `packages/editor/src/comment-layer.tsx`: one presence-managed preview tooltip.
- Modify `packages/editor/src/styles.css`: editor-owned preview states and reduced-motion rule.
- Modify `e2e/responsive-workspace.e2e.ts`: wide/compact breakpoint and inline sidebar lifecycle.
- Modify `e2e/document-navigation.e2e.ts`: pointer interruption, keyboard immediacy, origin, focus.
- Modify `e2e/sidecar.e2e.ts`: pointer/keyboard/reduced-motion preview behaviour.

### Task 1: Semantic shell motion contracts

**Files:**

- Create: `apps/web/src/motion-contract.ts`
- Create: `apps/web/src/motion-contract.test.ts`
- Modify: `apps/web/src/theme.css`
- Modify: `apps/web/src/theme.test.ts`

- [ ] **Step 1: Write the failing semantic mapping test**

```ts
import { describe, expect, it } from "bun:test";
import { MOTION_STATES, motionContract } from "./motion-contract";

describe("motion contracts", () => {
	it("maps shell surfaces to one class, close duration, and shared states", () => {
		expect(MOTION_STATES).toEqual(["", "is-open", "is-closing"]);
		expect(motionContract("popover")).toEqual({
			className: "motion-popover",
			closeDuration: 150,
		});
		expect(motionContract("sidebar")).toEqual({
			className: "motion-sidebar",
			closeDuration: 180,
		});
	});
});
```

- [ ] **Step 2: Run the contract test and verify red**

Run: `bun test apps/web/src/motion-contract.test.ts`

Expected: FAIL because `./motion-contract` does not exist.

- [ ] **Step 3: Add the minimal registry**

```ts
export type MotionKind = "popover" | "sidebar";

export const MOTION_STATES = ["", "is-open", "is-closing"] as const;

let contracts = {
	popover: { className: "motion-popover", closeDuration: 150 },
	sidebar: { className: "motion-sidebar", closeDuration: 180 },
} as const satisfies Record<MotionKind, { className: string; closeDuration: number }>;

export function motionContract(kind: MotionKind): (typeof contracts)[MotionKind] {
	return contracts[kind];
}
```

- [ ] **Step 4: Run the contract test and verify green**

Run: `bun test apps/web/src/motion-contract.test.ts`

Expected: 1 pass, 0 fail.

- [ ] **Step 5: Add a failing static theme contract test**

Append a `motion contracts` suite to `apps/web/src/theme.test.ts` that checks:

```ts
describe("motion contracts", () => {
	it("uses semantic tokens for app popovers", () => {
		expect(THEME).toMatch(
			/\.motion-popover\s*{[^}]*var\(--dropdown-open-dur\)[^}]*var\(--dropdown-ease\)/s,
		);
	});

	it("settles every new contract under reduced motion", () => {
		expect(THEME).toMatch(
			/@media \(prefers-reduced-motion: reduce\)\s*{[^}]*\.motion-popover[^}]*transition:\s*none/s,
		);
	});
});
```

- [ ] **Step 6: Run the theme test and verify red**

Run: `bun test apps/web/src/theme.test.ts`

Expected: FAIL because the new popover selector is not declared.

- [ ] **Step 7: Add only the tokens and state selectors used by this slice**

In `apps/web/src/theme.css`, add `.motion-popover` opening/open/closing selectors using
`--dropdown-open-dur`, `--dropdown-close-dur`, `--dropdown-ease`,
`--dropdown-pre-scale`, `--dropdown-closing-scale`, and runtime
`--motion-origin-x`/`--motion-origin-y` fallbacks. Include `.motion-popover` in the existing reduced
motion rule. Do not change `.motion-dropdown`, because existing picker/account behaviour is outside
this slice.

- [ ] **Step 8: Run focused unit/static tests**

Run:
`bun test apps/web/src/motion-contract.test.ts apps/web/src/theme.test.ts`

Expected: all pass.

### Task 2: Desktop Projects sidebar presence

**Files:**

- Modify: `apps/web/src/navigation-shell.tsx`
- Modify: `apps/web/src/navigation.css`
- Modify: `e2e/responsive-workspace.e2e.ts`

- [ ] **Step 1: Write the failing wide-screen lifecycle test**

Extend the existing 1024px test to click `Collapse Projects sidebar` and assert immediately that:

```ts
let track = page.locator(".motion-sidebar");
let opener = page.getByRole("button", { name: "Open Projects sidebar" });

await page.getByRole("button", { name: "Collapse Projects sidebar" }).click();
await expect(track).toHaveAttribute("aria-hidden", "true");
await expect(track).toHaveAttribute("inert", "");
await expect(opener).toBeFocused();
await expect(track).toHaveCount(0);
```

Then reopen, collapse, reopen before the 180ms exit completes, and assert the complementary
`Projects` landmark stays mounted and becomes active again. Retain the existing 1023px compact
assertions so the drawer remains the only Projects presentation below the breakpoint.

- [ ] **Step 2: Run the representative test and verify red**

Run:
`bun run e2e e2e/responsive-workspace.e2e.ts --project=fixtures --grep "wide side of the Projects transition"`

Expected: FAIL because the inline sidebar unmounts immediately and does not restore focus.

- [ ] **Step 3: Add sidebar presence without changing the responsive model**

In `NavigationShell`, read `motionContract("sidebar")`, create an inline presence from
`mode === "inline" && !collapsed`, and force immediate settlement when the responsive mode changes.
Render the retained frame while presence is not closed:

```tsx
let sidebarMotion = motionContract("sidebar");
let previousMode = useRef(mode);
let modeChanged = previousMode.current !== mode;
previousMode.current = mode;
let sidebarPresence = useTransitionPresence(
	mode === "inline" && !collapsed ? true : undefined,
	sidebarMotion.closeDuration,
	immediateMotion || modeChanged,
);
```

Give the frame `aria-hidden` and `inert` as soon as it closes, set
`--project-sidebar-width: ${width}px`, and focus the existing expand button on the next frame after
collapse. Keep the drawer presence and all drawer behaviour unchanged.

- [ ] **Step 4: Add the bounded track and child movement CSS**

First add static assertions to `apps/web/src/theme.test.ts` that `.motion-sidebar` consumes
`--sidebar-open-dur` and `--motion-move`, and that the navigation reduced-motion query disables the
track and child transitions. Run `bun test apps/web/src/theme.test.ts` and verify those assertions
fail before editing CSS.

Add `--motion-move: cubic-bezier(0.65, 0, 0.35, 1);` beside `--motion-smooth-out` in
`apps/web/src/theme.css`.

Use `.motion-sidebar` for the only new layout transition in this slice: width/flex-basis from `0`
to `--project-sidebar-width` using `--sidebar-open-dur` and `--motion-move`. Pair the child sidebar
opacity/translate transition with the same duration and curve. Use the 180ms close token for
`.is-closing`, disable pointer events during exit, and add both parent and child selectors to the
navigation reduced-motion rule.

- [ ] **Step 5: Run the test and verify green**

Run the Step 2 command.

Expected: 1 pass, 0 fail.

- [ ] **Step 6: Run unit and static checks for this vertical slice**

Run:
`bun test apps/web/src/navigation-model.test.ts apps/web/src/theme.test.ts`

Expected: all assertions pass.

### Task 3: Measured document action menu presence and origin

**Files:**

- Modify: `apps/web/src/document-actions-menu.tsx`
- Modify: `apps/web/src/navigation.css`
- Modify: `e2e/document-navigation.e2e.ts`

- [ ] **Step 1: Write failing browser tests at the menu boundary**

Add one test that pointer-opens the header menu, records the trigger centre and menu rectangle, and
asserts computed `transformOrigin` is the trigger-facing edge within the menu. Dismiss with Escape
and assert `aria-hidden`, `inert`, immediate trigger focus, retained closing DOM, then unmount.
Reopen during the close and assert the same menu becomes active without a duplicate.

Add one keyboard test that focuses the trigger, presses `ArrowDown`, and asserts the first menu item
is focused and computed `transitionDuration` is `0s`; repeated ArrowDown navigation must remain
immediate.

- [ ] **Step 2: Run the menu tests and verify red**

Run:
`bun run e2e e2e/document-navigation.e2e.ts --project=chromium --grep "document action menu motion"`

Expected: FAIL because the menu has no semantic presence, origin, or closing state.

- [ ] **Step 3: Separate measurement from animated presence**

In `DocumentActionsMenu`, keep `open` as intent and change position to `CSSProperties | undefined`.
Render a hidden measurement menu while `open && !position`; once layout measurement succeeds, put
the measured style into `useTransitionPresence`. Compute runtime `--motion-origin-x` and
`--motion-origin-y` from the trigger centre clamped to the placed menu rectangle. If measurement
cannot resolve, leave the menu hidden and make dismissal immediate rather than guessing an origin.

- [ ] **Step 4: Apply lifecycle accessibility and focus**

Use `motionContract("popover")` and `motionImmediately()`. While closing, keep the portal mounted,
set `aria-hidden="true"` and `inert`, remove document listeners, and restore trigger focus
immediately for Escape/action dismissal. Outside pointer/focus dismissal must not steal focus back
from the user's destination. Keep `aria-expanded` tied to intent and preserve every existing menu
key action.

- [ ] **Step 5: Apply the popover class**

Add `motion-popover`, the presence class, and the existing `document-actions-menu` class to the
placed menu. Do not add animation to slash menus, reference pickers, list navigation, or other menu
surfaces.

- [ ] **Step 6: Run menu unit and browser tests**

Run:
`bun test apps/web/src/document-actions-menu.test.ts apps/web/src/motion-contract.test.ts`

Then run the Step 2 Playwright command.

Expected: all pass.

### Task 4: Comment preview tooltip presence

**Files:**

- Modify: `packages/editor/src/comment-layer.tsx`
- Modify: `packages/editor/src/styles.css`
- Modify: `apps/web/src/theme.test.ts`
- Modify: `e2e/sidecar.e2e.ts`

- [ ] **Step 1: Write failing tooltip browser coverage**

Extend the marked-passage preview test to assert pointer hover starts from a non-`1` opacity/scale,
leaving removes `aria-describedby` immediately while the tooltip remains `aria-hidden` during its
150ms exit, and re-hovering cancels that exit without mounting a second tooltip. Add keyboard focus
and reduced-motion cases that assert `transitionDuration === "0s"`, including toggling reduced
motion during an active exit and observing immediate unmount.

- [ ] **Step 2: Run the tooltip tests and verify red**

Run:
`bun run e2e e2e/sidecar.e2e.ts --project=fixtures --grep "comment preview motion"`

Expected: FAIL because previews mount and unmount immediately.

- [ ] **Step 3: Move the preview to one presence-owned surface**

Build one optional preview value from the active `preview` id after the existing geometry has been
calculated. Render a `PreviewSurface` once per comment layer, not once per mapped thread. Inside it,
call `useTransitionPresence(value, 150, immediately)`, keep the previous `ThreadView`, style, id,
and measurement callback during closing, and set `aria-hidden`/`inert` immediately on exit. Keep
`aria-describedby` tied to active preview intent so assistive technology never points at outgoing
content.

- [ ] **Step 4: Add the editor-owned tooltip CSS contract**

First add static assertions to `apps/web/src/theme.test.ts` that `.motion-comment-preview` consumes
the dropdown duration/easing tokens and appears in the editor reduced-motion query. Run
`bun test apps/web/src/theme.test.ts` and verify those assertions fail before editing CSS.

Add `.motion-comment-preview`, `.is-open`, and `.is-closing` rules beside the existing comment
surface rules. Use `--dropdown-open-dur`, `--dropdown-close-dur`, `--dropdown-ease`, opacity, and a
small scale from the trigger-facing inline edge. Add the selector to the editor reduced-motion
rule. Do not change comment cards or compact sheets.

- [ ] **Step 5: Run tooltip, presence, and static tests**

Run:
`bun test packages/editor/src/transition-presence.test.ts apps/web/src/theme.test.ts`

Then run the Step 2 Playwright command.

Expected: all pass.

### Task 5: Slice verification and ready PR

**Files:**

- Modify only files listed above and this plan/spec documentation.

- [ ] **Step 1: Format and inspect the formatter's changes**

Run: `bun run fix`

Then run: `git status --short` and `git diff --check`.

Expected: only slice-1 files are changed; no whitespace errors.

- [ ] **Step 2: Run narrow unit tests**

Run:
`bun test apps/web/src/motion-contract.test.ts apps/web/src/theme.test.ts apps/web/src/document-actions-menu.test.ts apps/web/src/navigation-model.test.ts packages/editor/src/transition-presence.test.ts`

Expected: all pass.

- [ ] **Step 3: Run complete type and validation gates**

Run: `bun run types`

Run: `bun run ci`

Expected: both exit 0.

- [ ] **Step 4: Run the relevant Playwright files together**

Run:
`bun run e2e e2e/responsive-workspace.e2e.ts e2e/document-navigation.e2e.ts e2e/sidecar.e2e.ts`

Expected: all selected Chromium/fixtures tests pass, with no reused developer process on ports 8788
or 8789.

- [ ] **Step 5: Review scope and create commits**

Compare `git diff origin/main...HEAD` against slice 1 of
`docs/superpowers/specs/2026-08-25-purposeful-motion-coverage-design.md`. Confirm no disclosure,
content-swap, feedback, toast, slash-menu, reference-picker, typing, cursor, streaming, or progress
motion was added. Commit the implementation and plan on `maggie/motion-shell-and-menus`.

- [ ] **Step 6: Push and open a ready PR**

Push `maggie/motion-shell-and-menus` and create a non-draft PR against `main`. The PR body must name
the three covered surfaces, pointer/keyboard/reduced-motion policy, lifecycle/focus guarantees,
and the exact verification commands. Do not merge.

- [ ] **Step 7: Monitor required checks to completion**

Run `gh pr checks --watch` for the created PR. Diagnose and fix any failure within slice 1, rerun the
corresponding local verification, push the fix, and continue watching until every required check is
passing and the PR is ready for review.
