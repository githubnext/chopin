# Purposeful App Motion Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Establish the shared presence lifecycle, input-modality signal, and semantic motion variables needed by later Chopin transition checkpoints.

**Architecture:** A generic hook in `@chopin/editor` retains conditionally rendered React surfaces through their CSS exit phase, so both the editor and web app can use one lifecycle. The web root records pointer versus keyboard input for CSS and installs semantic recipe variables without replacing Chopin's existing 120ms control-feedback token.

**Tech Stack:** React 19, TypeScript, native CSS custom properties, Bun tests.

---

### Task 1: Shared transition presence lifecycle

**Files:**

- Create: `packages/editor/src/transition-presence.ts`
- Create: `packages/editor/src/transition-presence.test.ts`
- Modify: `packages/editor/src/index.ts`

- [ ] **Step 1: Write the failing lifecycle test**

```ts
import { describe, expect, test } from "bun:test";
import { presenceClass, transitionPresence } from "./transition-presence";

describe("transition presence", () => {
	test("opens on a frame and closes after its exit", () => {
		expect(presenceClass("closed")).toBe("");
		let phase = transitionPresence("closed", "open");
		expect(phase).toBe("opening");
		expect(presenceClass(phase)).toBe("");
		phase = transitionPresence(phase, "finish");
		expect(phase).toBe("open");
		expect(presenceClass(phase)).toBe("is-open");
		phase = transitionPresence(phase, "close");
		expect(phase).toBe("closing");
		expect(presenceClass(phase)).toBe("is-closing");
		expect(transitionPresence(phase, "finish")).toBe("closed");
	});

	test("reopening cancels a close", () => {
		expect(transitionPresence("closing", "open")).toBe("open");
	});
});
```

- [ ] **Step 2: Run the test and confirm the missing module failure**

Run: `bun test packages/editor/src/transition-presence.test.ts`

Expected: FAIL because `./transition-presence` does not exist.

- [ ] **Step 3: Implement the reducer and hook**

Create `packages/editor/src/transition-presence.ts`:

```ts
import { useEffect, useReducer, useRef } from "react";

import type { TransitionEventHandler } from "react";

export type PresencePhase = "closed" | "opening" | "open" | "closing";
export type PresenceAction = "open" | "close" | "finish";

export type TransitionPresence<T> = {
	className: "" | "is-open" | "is-closing";
	mounted: boolean;
	onTransitionEnd: TransitionEventHandler<HTMLElement>;
	phase: PresencePhase;
	value: T | undefined;
};

export function transitionPresence(phase: PresencePhase, action: PresenceAction): PresencePhase {
	if (action === "open") return phase === "closed" ? "opening" : "open";
	if (action === "close") return phase === "closed" ? "closed" : "closing";
	if (phase === "opening") return "open";
	if (phase === "closing") return "closed";
	return phase;
}

export function presenceClass(phase: PresencePhase): TransitionPresence<unknown>["className"] {
	return phase === "open" ? "is-open" : phase === "closing" ? "is-closing" : "";
}

function duration(name: string, fallback: number): number {
	let raw = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
	if (raw.endsWith("ms")) return Number.parseFloat(raw) || fallback;
	if (raw.endsWith("s")) return (Number.parseFloat(raw) || fallback / 1000) * 1000;
	return fallback;
}

function immediate(): boolean {
	return matchMedia("(prefers-reduced-motion: reduce)").matches
		|| document.documentElement.dataset.motionInput === "keyboard";
}

export function useTransitionPresence<T>(
	value: T | undefined,
	closeDuration: string,
	fallback: number,
): TransitionPresence<T> {
	let latest = useRef(value);
	if (value !== undefined) latest.current = value;
	let [phase, dispatch] = useReducer(
		transitionPresence,
		value === undefined ? "closed" : "open",
	);

	useEffect(() => dispatch(value === undefined ? "close" : "open"), [value]);
	useEffect(() => {
		if (phase === "opening") {
			let frame = requestAnimationFrame(() => dispatch("finish"));
			return () => cancelAnimationFrame(frame);
		}
		if (phase !== "closing") return;
		let reduced = immediate();
		let delay = reduced ? 0 : duration(closeDuration, fallback) + 50;
		let timer = window.setTimeout(() => dispatch("finish"), delay);
		return () => window.clearTimeout(timer);
	}, [closeDuration, fallback, phase]);

	return {
		className: presenceClass(phase),
		mounted: phase !== "closed" && latest.current !== undefined,
		onTransitionEnd: event => {
			if (phase === "closing" && event.target === event.currentTarget) dispatch("finish");
		},
		phase,
		value: phase === "closed" ? undefined : latest.current,
	};
}
```

- [ ] **Step 4: Export the lifecycle without widening package dependencies**

Add to `packages/editor/src/index.ts`:

```ts
export { presenceClass, transitionPresence, useTransitionPresence } from "./transition-presence";
export type { PresenceAction, PresencePhase, TransitionPresence } from "./transition-presence";
```

- [ ] **Step 5: Run the narrow tests and typecheck**

Run: `bun test packages/editor/src/transition-presence.test.ts && bun run types`

Expected: PASS.

- [ ] **Step 6: Commit the presence primitive**

```bash
git add packages/editor/src/transition-presence.ts packages/editor/src/transition-presence.test.ts packages/editor/src/index.ts
git commit -m "Add shared transition presence lifecycle"
```

### Task 2: Pointer and keyboard motion intent

**Files:**

- Create: `apps/web/src/motion-input.ts`
- Create: `apps/web/src/motion-input.test.ts`
- Modify: `apps/web/src/main.tsx`

- [ ] **Step 1: Write the failing input-classification test**

```ts
import { expect, test } from "bun:test";
import { motionInput } from "./motion-input";

test("classifies only input events that should change motion", () => {
	expect(motionInput("keydown")).toBe("keyboard");
	expect(motionInput("pointerdown")).toBe("pointer");
	expect(motionInput("focusin")).toBeUndefined();
});
```

- [ ] **Step 2: Run the test and confirm the missing module failure**

Run: `bun test apps/web/src/motion-input.test.ts`

Expected: FAIL because `./motion-input` does not exist.

- [ ] **Step 3: Implement input tracking**

Create `apps/web/src/motion-input.ts`:

```ts
import { useEffect } from "react";

export function motionInput(type: string): "keyboard" | "pointer" | undefined {
	return type === "keydown" ? "keyboard" : type === "pointerdown" ? "pointer" : undefined;
}

export function useMotionInput() {
	useEffect(() => {
		let record = (event: Event) => {
			let input = motionInput(event.type);
			if (input) document.documentElement.dataset.motionInput = input;
		};
		window.addEventListener("keydown", record, true);
		window.addEventListener("pointerdown", record, true);
		return () => {
			window.removeEventListener("keydown", record, true);
			window.removeEventListener("pointerdown", record, true);
		};
	}, []);
}
```

- [ ] **Step 4: Install tracking at the web root**

Import `useMotionInput` in `apps/web/src/main.tsx` and call it with the existing root hooks:

```ts
function Root() {
	useMotionInput();
	usePointerCapabilities();
	useVisualViewport();
	return <App />;
}
```

- [ ] **Step 5: Run tests and commit**

Run: `bun test apps/web/src/motion-input.test.ts && bun run types`

Expected: PASS.

```bash
git add apps/web/src/motion-input.ts apps/web/src/motion-input.test.ts apps/web/src/main.tsx
git commit -m "Track input modality for product motion"
```

### Task 3: Semantic surface-motion variables

**Files:**

- Modify: `apps/web/src/theme.css`
- Modify: `apps/web/src/theme.test.ts`

- [ ] **Step 1: Write the failing token-separation test**

Add to `apps/web/src/theme.test.ts`:

```ts
describe("product motion", () => {
	it("keeps frequent feedback separate from surface motion", () => {
		expect(THEME).toMatch(/--duration-fast:\s*120ms/);
		for (
			let token of [
				"dropdown-open-dur",
				"modal-open-dur",
				"drawer-open-dur",
				"panel-open-dur",
				"page-slide-dur",
				"icon-swap-dur",
				"badge-pop-dur",
				"acc-expand",
				"toast-open",
			]
		) {
			expect(THEME).toContain(`--${token}:`);
		}
	});
});
```

- [ ] **Step 2: Run the test and confirm semantic tokens are absent**

Run: `bun test apps/web/src/theme.test.ts`

Expected: FAIL on `--dropdown-open-dur`.

- [ ] **Step 3: Add the semantic variables without the universal root block**

Add beneath the existing duration tokens in `apps/web/src/theme.css`:

```css
/* Surface motion uses semantic names so 120ms control feedback stays fast. */
--motion-smooth-out: cubic-bezier(0.22, 1, 0.36, 1);
--dropdown-open-dur: 250ms;
--dropdown-close-dur: 150ms;
--dropdown-pre-scale: 0.97;
--dropdown-closing-scale: 0.99;
--dropdown-ease: var(--motion-smooth-out);
--modal-open-dur: 250ms;
--modal-close-dur: 150ms;
--modal-scale: 0.96;
--modal-scale-close: 0.96;
--modal-ease: var(--motion-smooth-out);
--sidebar-open-dur: 250ms;
--sidebar-close-dur: 180ms;
--drawer-open-dur: 250ms;
--drawer-close-dur: 180ms;
--drawer-distance: 8px;
--panel-open-dur: 280ms;
--panel-close-dur: 220ms;
--panel-distance: 12px;
--panel-blur: 2px;
--page-slide-dur: 250ms;
--page-slide-distance: 8px;
--page-blur: 3px;
--icon-swap-dur: 250ms;
--icon-swap-blur: 2px;
--badge-pop-dur: 500ms;
--badge-close-dur: 180ms;
--acc-expand: 250ms;
--acc-collapse: 250ms;
--toast-open: 280ms;
--toast-close: 200ms;
```

Do not copy transitions.dev's `--duration-fast: 250ms` or `--ease-out: ease-out`; both names already have app-wide meaning in Chopin.

- [ ] **Step 4: Run formatting, tests, and token validation**

Run: `bun run fix && git diff --check && bun test apps/web/src/theme.test.ts && bun run ci`

Expected: PASS and `tokens ok`.

- [ ] **Step 5: Inspect and commit the foundation**

Confirm the diff contains no component transition, motion dependency, or universal transitions.dev root import.

```bash
git add apps/web/src/theme.css apps/web/src/theme.test.ts
git commit -m "Define semantic surface motion variables"
```

### Task 4: Foundation verification

**Files:** No additional files.

- [ ] **Step 1: Run the checkpoint verification set**

Run: `bun run fix && git diff --check && bun test packages/editor/src/transition-presence.test.ts apps/web/src/motion-input.test.ts apps/web/src/theme.test.ts && bun run types && bun run ci`

Expected: every command passes.

- [ ] **Step 2: Review the checkpoint before planning navigation surfaces**

Show the presence API, the input-modality attribute, and the semantic token diff. Confirm the foundation remains presentation-only and does not change existing UI behaviour. Then write the separate checkpoint-2 plan for global navigation, dialogs, menus, and the drawer.
