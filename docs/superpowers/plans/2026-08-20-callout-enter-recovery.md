# Callout Enter Recovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Repair already-open legacy callouts so Enter creates an in-callout paragraph and a second Enter removes that empty paragraph before exiting the callout.

**Architecture:** A focused editor helper registers a `CalloutNode` transform that wraps direct inline children in paragraphs without replacing those children. It also normalises callouts already present when the helper registers; the existing Enter command then handles paragraph creation and exit unchanged.

**Tech Stack:** TypeScript, Lexical node transforms, React, Bun tests, Playwright

---

## File map

- Create `packages/editor/src/widgets/callout-shape.ts`: own legacy callout-tree repair and its Lexical registration.
- Create `packages/editor/src/widgets/callout-shape.test.ts`: prove already-present raw text is wrapped without losing node identity.
- Modify `packages/editor/src/widgets/callout.tsx`: register the repair with the mounted editor.
- Modify `e2e/toolbar.e2e.ts`: explicitly prove the empty exit paragraph is removed.

### Task 1: Normalise legacy callout children

**Files:**

- Create: `packages/editor/src/widgets/callout-shape.test.ts`
- Create: `packages/editor/src/widgets/callout-shape.ts`
- Modify: `packages/editor/src/widgets/callout.tsx:20-28,306-316`

- [ ] **Step 1: Write the failing headless regression test**

Create `packages/editor/src/widgets/callout-shape.test.ts`:

```ts
import { describe, expect, it } from "bun:test";
import { createHeadlessEditor } from "@lexical/headless";
import { $createParagraphNode, $createTextNode, $getRoot, $isParagraphNode } from "lexical";
import { $createCalloutNode, $isCalloutNode, registry } from "@chopin/dialect";

import { registerCalloutNormalization } from "./callout-shape";

function headless() {
	let schema = registry();
	return createHeadlessEditor({
		nodes: schema.nodes,
		onError(error) {
			throw error;
		},
	});
}

describe("callout shape", () => {
	it("wraps legacy direct text without replacing it", () => {
		let editor = headless();
		let textKey = "";

		editor.update(() => {
			let callout = $createCalloutNode("01K0N4W3B7P27CBAEC7A8C8WEA");
			let text = $createTextNode("Body text.");
			textKey = text.getKey();
			callout.append(text);
			$getRoot().append(callout);
		}, { discrete: true });

		let unregister = registerCalloutNormalization(editor);
		editor.getEditorState().read(() => {
			let callout = $getRoot().getFirstChild();
			expect($isCalloutNode(callout)).toBe(true);
			if (!$isCalloutNode(callout)) return;

			let paragraph = callout.getFirstChild();
			expect($isParagraphNode(paragraph)).toBe(true);
			if (!$isParagraphNode(paragraph)) return;
			expect(paragraph.getTextContent()).toBe("Body text.");
			expect(paragraph.getFirstChild()?.getKey()).toBe(textKey);
		});
		unregister();
	});

	it("leaves valid block children unchanged", () => {
		let editor = headless();
		let paragraphKey = "";

		editor.update(() => {
			let callout = $createCalloutNode("01K0N4W3B7P27CBAEC7A8C8WEA");
			let paragraph = $createParagraphNode().append($createTextNode("Already valid."));
			paragraphKey = paragraph.getKey();
			callout.append(paragraph);
			$getRoot().append(callout);
		}, { discrete: true });

		let unregister = registerCalloutNormalization(editor);
		editor.getEditorState().read(() => {
			let callout = $getRoot().getFirstChild();
			expect($isCalloutNode(callout)).toBe(true);
			if (!$isCalloutNode(callout)) return;
			expect(callout.getFirstChild()?.getKey()).toBe(paragraphKey);
		});
		unregister();
	});
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run:

```bash
bun test packages/editor/src/widgets/callout-shape.test.ts
```

Expected: FAIL because `./callout-shape` does not exist.

- [ ] **Step 3: Implement the normaliser and registration**

Create `packages/editor/src/widgets/callout-shape.ts`:

```ts
/** Repairs the child shape written by the original callout slash command. */

import { $createParagraphNode, $nodesOfType } from "lexical";
import { CalloutNode } from "@chopin/dialect";

import type { ElementNode, LexicalEditor } from "lexical";

function $normalizeCalloutChildren(callout: CalloutNode): void {
	let paragraph: ElementNode | undefined;
	for (let child of callout.getChildren()) {
		if (!child.isInline()) {
			paragraph = undefined;
			continue;
		}
		if (!paragraph) {
			paragraph = $createParagraphNode();
			child.insertBefore(paragraph);
		}
		paragraph.append(child);
	}
}

export function registerCalloutNormalization(editor: LexicalEditor): () => void {
	let unregister = editor.registerNodeTransform(CalloutNode, $normalizeCalloutChildren);
	// Registration happens before ordinary document loading, but this pass also
	// repairs a callout that was already open when the new client code arrived.
	editor.update(
		() => {
			for (let callout of $nodesOfType(CalloutNode)) $normalizeCalloutChildren(callout);
		},
		{ discrete: true },
	);
	return unregister;
}
```

- [ ] **Step 4: Register the normaliser in the callout plugin**

Add this local import to `packages/editor/src/widgets/callout.tsx`, after the package imports and before the type imports:

```ts
import { registerCalloutNormalization } from "./callout-shape";
```

Add this effect immediately after the state declarations in `CalloutPlugin`:

```ts
useEffect(() => registerCalloutNormalization(editor), [editor]);
```

Do not change `EnterPlugin`: keeping its command registration untouched also
keeps Shift-Enter on Lexical's separate line-break path.

- [ ] **Step 5: Run the focused unit test**

Run:

```bash
bun test packages/editor/src/widgets/callout-shape.test.ts
```

Expected: PASS; the text has the same Lexical key inside a new paragraph.

- [ ] **Step 6: Commit the normalisation**

```bash
git add packages/editor/src/widgets/callout-shape.ts packages/editor/src/widgets/callout-shape.test.ts packages/editor/src/widgets/callout.tsx
git commit -m "Repair legacy callout children"
```

### Task 2: Make empty-paragraph removal explicit in the browser test

**Files:**

- Modify: `e2e/toolbar.e2e.ts:122-145`

- [ ] **Step 1: Strengthen the existing double-Enter test**

In `enter twice leaves a callout at the end of the plan`, replace the two Enter presses after `Still in it.` with:

```ts
await page.keyboard.press("Enter");
await expect(body.locator(":scope > p")).toHaveCount(3);
await expect(body.locator(":scope > p").last()).toBeEmpty();

await page.keyboard.press("Enter");
await expect(body.locator(":scope > p")).toHaveCount(2);
```

Keep the subsequent `Outside the callout.` typing and persistence assertions. The immediate count of two proves the empty paragraph was removed as part of exit, rather than merely hidden or left in the source.

- [ ] **Step 2: Run the focused browser test**

Run:

```bash
bun run e2e e2e/toolbar.e2e.ts --grep "enter twice leaves"
```

Expected: PASS with one Chromium test. The first Enter leaves three callout paragraphs; the second returns the count to two and later text persists after `</Callout>`.

- [ ] **Step 3: Commit the browser assertion**

```bash
git add e2e/toolbar.e2e.ts
git commit -m "Test removal of callout exit paragraph"
```

### Task 3: Verify the complete slice

**Files:**

- Verify only; no new files.

- [ ] **Step 1: Run all unit tests**

Run:

```bash
bun test
```

Expected: all unit tests pass.

- [ ] **Step 2: Run type checking**

Run:

```bash
bun run types
```

Expected: every workspace and the E2E project type-check successfully.

- [ ] **Step 3: Run static checks**

Run:

```bash
bun run ci
```

Expected: dprint, oxlint, and token checks pass.

- [ ] **Step 4: Check the final diff**

Run:

```bash
git diff --check d770003..HEAD
git status --short
```

Expected: no whitespace errors and no uncommitted implementation files.
