# Archived Chats Sidebar Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the mixed archive checkbox with a distinct archived-chats sidebar mode.

**Architecture:** Keep `NavigationShell` as the owner of the existing `showArchived` boolean and
reuse the current `includeArchived=true` catalogue request. `ProjectSidebar` interprets that boolean
as a two-mode view, filters the mixed response to archived documents, and renders mode-specific
navigation controls. Restoring a document returns the shell to active mode.

**Tech Stack:** React 19, TypeScript, CSS, Bun tests, Playwright

**Spec:** `docs/superpowers/specs/2026-08-24-archived-chats-sidebar-design.md`

## Global Constraints

- The footer label is exactly **Archived chats**.
- The archive return label is exactly **← Back to active docs**.
- The supplied box-archive SVG renders through `NavigationIcon` at 14px.
- Active mode keeps the existing active-only API request.
- Archive mode reuses `includeArchived=true` and displays only channels with `archivedAt`.
- The account control remains anchored at the bottom in both modes.
- Do not add routes, persisted mode state, server/storage/protocol changes, or dependencies.
- TypeScript uses tabs, double quotes, semicolons, and local `let` bindings.
- Run `bun run fix` after code edits and inspect every formatting change.

---

### Task 1: Render active and archived sidebar modes

**Files:**

- Create: `apps/web/src/assets/figma/navigation/box-archive.svg`
- Modify: `apps/web/src/project-sidebar.tsx:1-362`
- Modify: `apps/web/src/navigation.css:53-122`
- Test: `apps/web/src/navigation-chrome.test.ts:28-146`

**Interfaces:**

- Consumes: existing `showArchived: boolean` and
  `onShowArchivedChange(show: boolean): void` `ProjectSidebar` props.
- Produces: the same public props; active mode calls `onShowArchivedChange(true)` from the footer,
  archive mode calls `onShowArchivedChange(false)` from the back control.
- Produces: `Project` receives `archiveMode: boolean` and filters its local channel list before
  rendering without changing `ProjectDocuments` or the catalogue hooks.

- [ ] **Step 1: Add a failing static-render test for both modes**

Add a focused test in `navigation-chrome.test.ts` that renders one active and one archived channel:

```tsx
test("separates active and archived documents into sidebar modes", () => {
	let active = {
		createdAt: "2026-08-24T10:00:00.000Z",
		createdBy: "U_test",
		id: "active-document",
		repositoryId: "R_test",
		repositoryName: "testing-sql-transcripts",
		repositoryOwner: "MaggieAppleton",
		revision: 0,
		slug: "active-document",
		title: "Active document",
		updatedAt: "2026-08-24T10:00:00.000Z",
	};
	let archived = {
		...active,
		archivedAt: "2026-08-24T11:00:00.000Z",
		id: "archived-document",
		slug: "archived-document",
		title: "Archived document",
		updatedAt: "2026-08-24T11:00:00.000Z",
	};
	let props = {
		canCreateDocument: true,
		creatingNewDocument: false,
		creatingProjectIds: new Set<string>(),
		onAccount: () => {},
		onAddProject: () => {},
		onCollapse: () => {},
		onCreateDocument: () => {},
		onDocumentAction: () => {},
		onLoadMore: () => {},
		onNewDocument: () => {},
		onSearch: () => {},
		onShowArchivedChange: () => {},
		projects: [{
			documents: { status: "ready" as const, channels: [active, archived] },
			project: {
				available: true,
				position: 0,
				repositoryId: "R_test",
				repositoryName: "testing-sql-transcripts",
				repositoryOwner: "MaggieAppleton",
			},
		}],
		user: { avatarUrl: "", id: "user-one", login: "MaggieAppleton" },
	};
	let activeMarkup = renderToStaticMarkup(createElement(ProjectSidebar, {
		...props,
		showArchived: false,
	}));
	let archivedMarkup = renderToStaticMarkup(createElement(ProjectSidebar, {
		...props,
		showArchived: true,
	}));

	expect(activeMarkup).toContain("Archived chats");
	expect(activeMarkup).toContain("box-archive.svg");
	expect(activeMarkup).toMatch(/height="14" src="[^"]*box-archive\.svg" width="14"/);
	expect(activeMarkup).toContain("Active document");
	expect(activeMarkup).not.toContain("Archived document");
	expect(activeMarkup).not.toContain("Show archived documents");
	expect(activeMarkup.indexOf("Archived chats")).toBeLessThan(activeMarkup.indexOf("user-one"));

	expect(archivedMarkup).toContain("← Back to active docs");
	expect(archivedMarkup).toContain("Archived document");
	expect(archivedMarkup).not.toContain("Active document");
	expect(archivedMarkup).not.toContain("Archived chats");
	expect(archivedMarkup).not.toContain("New document");
	expect(archivedMarkup).not.toContain(">Search<");
	expect(archivedMarkup).not.toContain("Add Project");
	expect(archivedMarkup).not.toContain(">Archived</span>");
});
```

- [ ] **Step 2: Run the static test and verify it fails**

Run:

```bash
bun test apps/web/src/navigation-chrome.test.ts
```

Expected: FAIL because `Archived chats`, `box-archive.svg`, and the archived-only view do not exist.

- [ ] **Step 3: Add the supplied archive asset**

Create `box-archive.svg` from the approved SVG, preserving its `18 18` view box and strokes:

```svg
<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 18 18">
  <title>box-archive</title>
  <g fill="none" stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" stroke="#212121">
    <path d="M14.75,6.25v7c0,1.105-.895,2-2,2H5.25c-1.105,0-2-.895-2-2V6.25" />
    <rect x="1.75" y="2.75" width="14.5" height="3.5" rx="1" ry="1" />
    <line x1="7" y1="9.25" x2="11" y2="9.25" />
  </g>
</svg>
```

- [ ] **Step 4: Implement the two sidebar bodies and archived-only filtering**

In `project-sidebar.tsx`, import `boxArchiveIcon`. Add `archiveMode: boolean` to `Project`, filter the
mixed catalogue, and hide creation affordances:

```tsx
let { documents, project } = entry;
let channels = documents.channels.filter(channel =>
	archiveMode ? channel.archivedAt !== undefined : channel.archivedAt === undefined
);
```

Gate the project-level create button with `!archiveMode`, omit the `Archived` badge from document
links, and pass `onNewResearch={archiveMode ? undefined : onNewResearch}`.

Replace the checkbox and unconditional primary actions with a mode-specific local, then render
`{primaryActions}` after the sidebar header:

```tsx
let primaryActions = (
	<div className="project-sidebar-primary-actions">
		{showArchived
			? (
				<button
					className="project-sidebar-primary-action"
					onClick={() => onShowArchivedChange(false)}
					type="button"
				>
					<span aria-hidden="true">←</span>
					<span>Back to active docs</span>
				</button>
			)
			: (
				<>
					<button
						className="project-sidebar-primary-action"
						disabled={!canCreateDocument || creatingNewDocument}
						onClick={onNewDocument}
						type="button"
					>
						<NavigationIcon src={newDocumentIcon} />
						<span>New document</span>
					</button>
					<button
						className="project-sidebar-primary-action"
						onClick={onSearch}
						type="button"
					>
						<NavigationIcon src={searchIcon} />
						<span>Search</span>
					</button>
				</>
			)}
	</div>
);
```

Hide the Add Project button when `showArchived` is true. Pass `archiveMode={showArchived}` to every
`Project`. Define this local and render `{archiveFooter}` immediately before
`project-sidebar-account-wrap`:

```tsx
let archiveFooter = !showArchived
	? (
		<div className="project-sidebar-footer-actions">
			<button
				className="project-sidebar-primary-action"
				onClick={() => onShowArchivedChange(true)}
				type="button"
			>
				<NavigationIcon src={boxArchiveIcon} />
				<span>Archived chats</span>
			</button>
		</div>
	)
	: null;
```

- [ ] **Step 5: Match the footer to existing navigation styling**

In `navigation.css`, delete `.project-sidebar-archived-toggle` and its input rule. Share the existing
layout declarations with the new footer wrapper:

```css
.project-sidebar-primary-actions,
.project-sidebar-footer-actions {
	display: flex;
	flex-direction: column;
	padding: 0 8px;
}

.project-sidebar-footer-actions {
	flex: 0 0 auto;
}
```

Do not add a new font size, color, hover rule, or icon opacity rule; the button must inherit
`project-sidebar-primary-action` behavior.

- [ ] **Step 6: Format and run the focused checks**

Run:

```bash
bun run fix
git diff --check
bun test apps/web/src/navigation-chrome.test.ts
bun run types
```

Expected: formatting changes are limited to the four Task 1 files; the test and typecheck pass.

- [ ] **Step 7: Commit the presentation slice**

```bash
git add apps/web/src/assets/figma/navigation/box-archive.svg apps/web/src/project-sidebar.tsx apps/web/src/navigation.css apps/web/src/navigation-chrome.test.ts
git commit -m "Move archived chats into sidebar section"
```

### Task 2: Return restored documents to the active catalogue

**Files:**

- Modify: `apps/web/src/navigation-shell.tsx:607-625`
- Test: `e2e/document-navigation.e2e.ts:339-382`

**Interfaces:**

- Consumes: Task 1's unchanged `onShowArchivedChange(show: boolean): void` contract.
- Produces: a successful `restore` mutation calls `setShowArchived(false)` after accepting the
  returned channel; archive and failed mutations do not change sidebar mode.

- [ ] **Step 1: Rewrite the existing archive E2E expectations for the new navigation**

Replace the checkbox and archive-search assertions in
`writers can archive, restore, and permanently delete a document` with:

```tsx
await projects.getByRole("button", { name: "Archived chats", exact: true }).click();
await expect(projects.getByRole("button", { name: "Back to active docs", exact: false }))
	.toBeVisible();
await expect(projects.getByRole("link", { name: title, exact: true })).toBeVisible();
await expect(projects.getByRole("button", { name: "New document", exact: true })).toHaveCount(0);
await expect(projects.getByRole("button", { name: "Search", exact: true })).toHaveCount(0);

await headerAction(ana, "Restore");
await expect(content(ana)).toHaveAttribute("contenteditable", "true");
await expect(content(bo)).toHaveAttribute("contenteditable", "true");
await expect(ana.getByText("Archived, read-only", { exact: true })).toHaveCount(0);
await expect(projects.getByRole("button", { name: "Archived chats", exact: true })).toBeVisible();
await expect(projects.getByRole("link", { name: title, exact: true })).toBeVisible();
await expect(projects.getByRole("button", { name: "Back to active docs", exact: false }))
	.toHaveCount(0);
```

Retain the permanent-delete half of the lifecycle test after those assertions:

```tsx
await headerAction(ana, "Archive");
await expect(content(ana)).toHaveAttribute("contenteditable", "false");
await headerAction(ana, "Delete permanently");
let confirmation = ana.getByRole("dialog", { name: "Delete document permanently?" });
await confirmation.getByRole("button", { name: "Delete permanently", exact: true }).click();
await expect(ana).not.toHaveURL(path);
await expect(bo).not.toHaveURL(path);
let unavailable = await ana.request.get(`/api/channels/${room}`);
expect(unavailable.status()).toBe(404);
```

- [ ] **Step 2: Run the targeted E2E test and verify the restore transition fails**

Run:

```bash
bun run e2e e2e/document-navigation.e2e.ts --grep "writers can archive"
```

Expected: FAIL after Restore because the sidebar remains in archive mode and `Archived chats` is not
visible.

- [ ] **Step 3: Switch to active mode only after a successful restore**

Update the mutation success callback in `navigation-shell.tsx`:

```tsx
void mutation.then(detail => {
	acceptChannel(detail.channel);
	if (action === "restore") setShowArchived(false);
}, reason => {
	setError({ reason });
});
```

Do not switch modes before the request succeeds. This preserves retry context on restore failure.

- [ ] **Step 4: Run formatting and complete verification**

Run:

```bash
bun run fix
git diff --check
bun test apps/web/src/navigation-chrome.test.ts
bun run types
bun run e2e e2e/document-navigation.e2e.ts --grep "writers can archive"
bun run ci
```

Expected: all commands pass. Inspect `git diff` and keep formatter changes scoped to files in this
plan.

- [ ] **Step 5: Commit the behavior slice**

```bash
git add apps/web/src/navigation-shell.tsx e2e/document-navigation.e2e.ts
git commit -m "Return restored documents to active navigation"
```

## Final Acceptance

- Active mode contains New document, Search, Projects, Archived chats, then the account control.
- Archive mode contains ← Back to active docs, project-grouped archived documents, then the account.
- Active documents never appear in archive mode, and archive badges are absent there.
- Restoring succeeds before returning to active mode; restore failure leaves archive mode intact.
- The supplied archive glyph renders at 14px in inline and drawer sidebars.
- `bun test apps/web/src/navigation-chrome.test.ts`, `bun run types`, the targeted archive E2E test,
  and `bun run ci` pass.
