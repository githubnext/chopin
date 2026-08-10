# Chat Markdown Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Render a deliberately small Markdown subset in every participant message without changing the composer or transcript data.

**Architecture:** Add one `MessageMarkdown` view beside the transcript and keep `MessageBody` responsible only for message controls and streaming state. `react-markdown` parses standard Markdown with an explicit element allowlist; a colocated stylesheet gives those elements compact rail typography.

**Tech Stack:** React 19, `react-markdown`, Tailwind theme tokens, Playwright

---

## File map

- Create `apps/web/src/chat/markdown.tsx`: safe Markdown-to-React boundary and supported-element policy.
- Create `apps/web/src/chat/markdown.css`: compact message typography using existing colour, radius and font tokens.
- Modify `apps/web/src/chat/transcript.tsx`: render member and Planner message text through `MessageMarkdown`.
- Modify `apps/web/package.json` and `bun.lock`: declare and lock `react-markdown`.
- Modify `e2e/smoke.e2e.ts`: prove both participant kinds render the chosen semantics and unsafe content stays inert.

### Task 1: Lock down the message contract

**Files:**

- Test: `e2e/smoke.e2e.ts`

- [ ] **Step 1: Add a failing browser test after the existing chat transcript tests**

````ts
test("chat renders participant Markdown without admitting document features", async ({ join, page }) => {
	await injectChatHistory(page, frame => ({
		...frame,
		entries: [
			{
				id: "m1",
				author: { kind: "member", handle: "maggie" },
				text: [
					"**Bold** and *italic* with [the docs](https://example.com).",
					"",
					"- first",
					"- second",
					"",
					"1. one",
					"2. two",
					"",
					"> quoted",
					"",
					"Use `bun test`.",
					"",
					"```ts",
					"let answer = 42;",
					"```",
					"",
					"# Ordinary message text",
					"",
					"![remote](https://example.invalid/pixel.png)",
					'<img src="https://example.invalid/raw.png" alt="raw">',
				].join("\n"),
				ts: 1_700_000_000,
			},
			{
				id: "a1",
				author: { kind: "agent" },
				text: "Planner wrote **strongly**.",
				ts: 1_700_000_001,
			},
		],
	}));

	await join("ana");
	let chat = page.locator("#pane-chat");
	let member = chat.locator("[data-chat-entry]").filter({ hasText: "Bold and italic" });
	let planner = chat.locator("[data-chat-entry]").filter({ hasText: "Planner wrote strongly" });

	await expect(member.locator("strong")).toHaveText("Bold");
	await expect(member.locator("em")).toHaveText("italic");
	await expect(member.locator("ul")).toContainText("first");
	await expect(member.locator("ol")).toContainText("one");
	await expect(member.locator("blockquote")).toHaveText("quoted");
	await expect(member.getByRole("link", { name: "the docs" })).toHaveAttribute("target", "_blank");
	await expect(member.locator("p code")).toHaveText("bun test");
	await expect(member.locator("pre code")).toContainText("let answer = 42;");
	await expect(member.getByRole("heading", { name: "Ordinary message text" })).toHaveCount(0);
	await expect(member).toContainText("Ordinary message text");
	await expect(member.locator('img[src*="example.invalid"]')).toHaveCount(0);
	await expect(planner.locator("strong")).toHaveText("strongly");
});
````

- [ ] **Step 2: Run the focused test and verify it fails**

Run:

```bash
bun run e2e -- --grep "chat renders participant Markdown"
```

Expected: FAIL because `strong`, `em`, lists, blockquotes, links and code elements do not yet exist in the transcript.

### Task 2: Add the safe Markdown renderer

**Files:**

- Create: `apps/web/src/chat/markdown.tsx`
- Create: `apps/web/src/chat/markdown.css`
- Modify: `apps/web/src/chat/transcript.tsx`
- Modify: `apps/web/package.json`
- Modify: `bun.lock`
- Test: `e2e/smoke.e2e.ts`

- [ ] **Step 1: Add the renderer dependency to the web workspace**

Run:

```bash
bun add react-markdown --cwd apps/web
```

Expected: `react-markdown` appears in `apps/web/package.json`; `bun.lock` records it and its parser dependencies.

- [ ] **Step 2: Create the rendering boundary**

Create `apps/web/src/chat/markdown.tsx`:

```tsx
import ReactMarkdown from "react-markdown";

import "./markdown.css";

import type { Components } from "react-markdown";

const ELEMENTS = [
	"a",
	"blockquote",
	"br",
	"code",
	"em",
	"h1",
	"h2",
	"h3",
	"h4",
	"h5",
	"h6",
	"li",
	"ol",
	"p",
	"pre",
	"strong",
	"ul",
];

let paragraph: Components["p"] = ({ children }) => <p>{children}</p>;

const COMPONENTS: Components = {
	a: ({ children, href }) => (
		<a href={href} rel="noopener noreferrer" target="_blank">
			{children}
		</a>
	),
	h1: paragraph,
	h2: paragraph,
	h3: paragraph,
	h4: paragraph,
	h5: paragraph,
	h6: paragraph,
};

export function MessageMarkdown({ source }: { source: string }) {
	return (
		<div className="chat-markdown" data-chat-markdown>
			<ReactMarkdown
				allowedElements={ELEMENTS}
				components={COMPONENTS}
				skipHtml
				unwrapDisallowed
			>
				{source}
			</ReactMarkdown>
		</div>
	);
}
```

The allowlist admits only the approved chat syntax. Heading nodes are retained long enough to keep their text, then rendered as ordinary paragraphs. Images and horizontal rules are removed; raw HTML is skipped; the library's default URL transform rejects unsafe protocols.

- [ ] **Step 3: Add compact rail typography**

Create `apps/web/src/chat/markdown.css`:

```css
.chat-markdown {
	min-width: 0;
	overflow-wrap: anywhere;
	font-size: var(--text-base);
	line-height: 1.5;
}

.chat-markdown > :first-child {
	margin-block-start: 0;
}

.chat-markdown > :last-child {
	margin-block-end: 0;
}

.chat-markdown p,
.chat-markdown ul,
.chat-markdown ol,
.chat-markdown blockquote,
.chat-markdown pre {
	margin-block: 0.5rem;
}

.chat-markdown ul,
.chat-markdown ol {
	padding-inline-start: 1.25rem;
}

.chat-markdown ul {
	list-style: disc;
}

.chat-markdown ol {
	list-style: decimal;
}

.chat-markdown li + li {
	margin-block-start: 0.125rem;
}

.chat-markdown blockquote {
	border-inline-start: 2px solid var(--color-edge);
	padding-inline-start: 0.75rem;
	color: var(--color-text-secondary);
}

.chat-markdown a {
	color: var(--color-brand-ink);
	text-decoration: underline;
	text-underline-offset: 0.125rem;
}

.chat-markdown :not(pre) > code {
	border-radius: var(--radius-sm);
	background: var(--color-inset);
	padding: 0.125rem 0.25rem;
	font-family: var(--font-mono);
	font-size: var(--text-sm);
}

.chat-markdown pre {
	overflow-x: auto;
	border-radius: var(--radius-md);
	background: var(--color-inset);
	padding: 0.75rem;
}

.chat-markdown pre code {
	font-family: var(--font-mono);
	font-size: var(--text-sm);
}
```

- [ ] **Step 4: Route participant prose through the renderer**

In `apps/web/src/chat/transcript.tsx`, import the new view:

```tsx
import { MessageMarkdown } from "./markdown";
```

Replace the plain message paragraph inside `MessageBody` with:

```tsx
<div className="min-w-0 flex-1">
	<MessageMarkdown source={text} />
	{message.streaming && <span className="ml-0.5 animate-pulse">▍</span>}
</div>;
```

Keep the queued-message withdraw button as the adjacent flex item. Leave `SystemEntry` unchanged so system lines remain plain application text.

- [ ] **Step 5: Run the focused browser test and verify it passes**

Run:

```bash
bun run e2e -- --grep "chat renders participant Markdown"
```

Expected: PASS. The participant and Planner entries contain semantic formatting, headings have no heading role, and no remote image element exists.

- [ ] **Step 6: Run the web typecheck and production build**

Run:

```bash
bun run types
bun run build
```

Expected: both commands exit 0.

- [ ] **Step 7: Commit the vertical slice**

```bash
git add apps/web/src/chat/markdown.tsx apps/web/src/chat/markdown.css apps/web/src/chat/transcript.tsx apps/web/package.json bun.lock e2e/smoke.e2e.ts
git commit -m "Render Markdown in chat messages"
```

### Task 3: Verify and deliver

**Files:**

- Verify only; fix files from Task 2 if a check exposes a regression.

- [ ] **Step 1: Run the complete repository checks**

Run:

```bash
bun run ci
bun run types
bun test
bun run build
bun run e2e
```

Expected: every command exits 0.

- [ ] **Step 2: Inspect the final diff and whitespace**

Run:

```bash
git diff origin/main...HEAD --stat
git diff --check origin/main...HEAD
git status --short
```

Expected: the diff contains only the design, plan, dependency, renderer, styles, transcript wiring and browser coverage; the whitespace check reports nothing; the working tree is clean.

- [ ] **Step 3: Push and open the pull request**

```bash
git push -u origin bb/sanitize-planner-sidebar-markdown-thr_nc5yeewq67
gh pr create --base main --title "Render Markdown in chat messages" --body "## Summary

- render a safe, compact Markdown subset in participant and Planner messages
- keep headings flat and exclude raw HTML, images, tables and task lists
- cover member and agent output in the browser suite

## Testing

- bun run ci
- bun run types
- bun test
- bun run build
- bun run e2e"
```
