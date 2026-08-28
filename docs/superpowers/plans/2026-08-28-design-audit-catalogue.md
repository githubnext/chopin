# Design Audit Catalogue Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a development-only page that exposes Chopin's foundations, controls, application surfaces, and authored-content components in deterministic visual states.

**Architecture:** `apps/web` owns a lazily loaded `/design-audit` route. Small catalogue modules compose real web and editor components; pure fixture data describes coverage. A read-only static editor entry point renders authored MDX through the production dialect and widget renderers without opening a WebSocket.

**Tech Stack:** React 19, TypeScript, Vite, Tailwind CSS v4, MDXEditor/Lexical, Bun tests.

---

This plan builds the inspection surface. Screenshot findings will produce a separate, evidence-based
normalisation plan; naming exact remediation files before seeing the catalogue would be guesswork.

### Task 1: Development-only route

**Files:**
- Create: `apps/web/src/design-audit/route.ts`
- Create: `apps/web/src/design-audit/route.test.ts`
- Create: `apps/web/src/design-audit/page.tsx`
- Modify: `apps/web/src/main.tsx`

- [ ] **Step 1: Write the route test**

```ts
import { describe, expect, it } from "bun:test";
import { isDesignAuditRoute } from "./route";

describe("design audit route", () => {
	 it("exists only in development at its exact path", () => {
		 expect(isDesignAuditRoute("/design-audit", true)).toBe(true);
		 expect(isDesignAuditRoute("/design-audit", false)).toBe(false);
		 expect(isDesignAuditRoute("/design-audit/extra", true)).toBe(false);
	 });
});
```

- [ ] **Step 2: Verify the test fails**

Run: `bun test apps/web/src/design-audit/route.test.ts`
Expected: FAIL because `route.ts` does not exist.

- [ ] **Step 3: Add the pure route predicate**

```ts
export function isDesignAuditRoute(pathname: string, development: boolean): boolean {
	return development && pathname === "/design-audit";
}
```

- [ ] **Step 4: Add lazy route selection to `main.tsx`**

Keep the current application root unchanged for ordinary paths. On the audit path, dynamically import
`./design-audit/page` and render its `DesignAuditPage`. The import must be inside the
`import.meta.env.DEV`-guarded branch so a normal production build removes the route chunk.

- [ ] **Step 5: Add a minimal labelled page and verify**

```tsx
export function DesignAuditPage() {
	return <main data-design-audit=""><h1>Chopin design audit</h1></main>;
}
```

Run: `bun test apps/web/src/design-audit/route.test.ts && bun --cwd apps/web run types`
Expected: PASS.

- [ ] **Step 6: Verify production exclusion and commit**

Run: `bun --cwd apps/web run build && ! rg -l "Chopin design audit" apps/web/dist`
Expected: build passes and `rg` finds no catalogue string.

Commit: `git commit -am "Add development design audit route"`

### Task 2: Coverage inventory and catalogue frame

**Files:**
- Create: `apps/web/src/design-audit/inventory.ts`
- Create: `apps/web/src/design-audit/inventory.test.ts`
- Create: `apps/web/src/design-audit/frame.tsx`
- Create: `apps/web/src/design-audit/styles.css`
- Modify: `apps/web/src/design-audit/page.tsx`

- [ ] **Step 1: Write inventory coverage tests**

Define `AuditGroup`, `AuditItem`, and exported `AUDIT_INVENTORY`. Assert that the inventory contains the
required groups `foundations`, `controls`, `surfaces`, `authored-content`, and the named specimens from
the approved spec. Assert every item has a unique `id`, a source path, and at least one state.

- [ ] **Step 2: Verify the inventory test fails**

Run: `bun test apps/web/src/design-audit/inventory.test.ts`
Expected: FAIL because `inventory.ts` does not exist.

- [ ] **Step 3: Implement the typed inventory**

```ts
export type AuditItem = {
	id: string;
	label: string;
	source: string;
	states: readonly string[];
	judgement?: string;
};

export type AuditGroup = {
	id: "foundations" | "controls" | "surfaces" | "authored-content";
	label: string;
	items: readonly AuditItem[];
};
```

Populate it with buttons, icon buttons, links, fields, selection, tabs, menus, dropdowns, dialogs,
lists, navigation rows, chat, decisions, resolved comments, loading, empty, error, callout, research,
code, diff, diagram, formula, image, and table.

- [ ] **Step 4: Build the frame**

`frame.tsx` owns `AuditSection`, `AuditPlate`, `StateLabel`, the sticky table of contents, and the
desktop/narrow preview-width control. `styles.css` may style only catalogue scaffolding; specimens use
the real application classes.

- [ ] **Step 5: Run tests and commit**

Run: `bun test apps/web/src/design-audit/inventory.test.ts && bun --cwd apps/web run types`
Expected: PASS.

Commit: `git add apps/web/src/design-audit && git commit -m "Map design audit coverage"`

### Task 3: Foundations and controls

**Files:**
- Create: `apps/web/src/design-audit/foundations.tsx`
- Create: `apps/web/src/design-audit/controls.tsx`
- Modify: `apps/web/src/design-audit/page.tsx`

- [ ] **Step 1: Add source-contract assertions to the inventory test**

Assert each foundation and control inventory ID appears in its specimen module. This is intentionally
a source contract because Bun has no DOM and the repository forbids synthetic layout DOMs.

- [ ] **Step 2: Render foundations**

Show the emitted colour tokens, type scale, 4px spacing scale, radii, and the three semantic shadows.
Render all local SVG and Phosphor icons in one 16px default frame, with separate 14px compact and 20px
emphasis examples. Label the byte-identical collapse/conversation-close pair.

- [ ] **Step 3: Render every control state**

Use the real `btn`, `btn-md`, `btn-sm`, `btn-icon`, `btn-primary`, `btn-secondary`, `btn-ghost`,
`btn-destructive`, `field`, `field-ghost`, and `choice-control` utilities. Include resting, labelled
forced-hover, labelled forced-active, keyboard-focusable, disabled, busy, selected, invalid, and
read-only examples. Include text links, tablist/tab states, list selection, dropdown, and menu rows.

- [ ] **Step 4: Verify and commit**

Run: `bun test apps/web/src/design-audit/inventory.test.ts && bun --cwd apps/web run types`
Expected: PASS.

Commit: `git add apps/web/src/design-audit && git commit -m "Catalogue foundations and controls"`

### Task 4: Application surfaces

**Files:**
- Create: `apps/web/src/design-audit/surfaces.tsx`
- Create: `apps/web/src/design-audit/fixtures.ts`
- Modify: `apps/web/src/design-audit/page.tsx`

- [ ] **Step 1: Add surface fixtures**

Create deterministic fixture records for a user, chat messages, repository/document rows, research
requests in queued/running/failed/cancelled/ready states, resolved decisions, resolved comments, and
loading/empty/error content. Use valid protocol shapes and fixed ULIDs/UUIDs.

- [ ] **Step 2: Compose real surfaces**

Render actual exported or app-owned components where their API is small: `NavigationDialog`,
`DocumentActionsMenu`, `ConversationToggle`, `TerminalAlert`, `Face`, `SendAction`, `ResearchCard`,
`ResearchComposer`, `QuestionnaireCard`, and chat transcript elements. For tightly coupled surfaces,
extract a reusable presentational component from the current owner rather than copying its markup.

- [ ] **Step 3: Show layout variants**

Place dialogs, menus, popovers, cards, navigation/list rows, conversation messages, composer controls,
decision cards, resolved-comment cards, and loading states in labelled plates. Interactive dialog/menu
launchers must restore focus and close with Escape; inline specimens remain open for screenshots.

- [ ] **Step 4: Verify and commit**

Run: `bun test apps/web/src/design-audit/inventory.test.ts packages/editor/src/card.test.ts && bun --cwd apps/web run types`
Expected: PASS.

Commit: `git add apps/web/src/design-audit apps/web/src packages/editor/src && git commit -m "Catalogue application surfaces"`

### Task 5: Authored-content fixture

**Files:**
- Create: `packages/editor/src/static-plan-editor.tsx`
- Create: `packages/editor/src/static-plan-editor.test.ts`
- Modify: `packages/editor/package.json`
- Create: `apps/web/src/design-audit/authored-content.tsx`
- Modify: `apps/web/src/design-audit/page.tsx`

- [ ] **Step 1: Write the static-editor source contract**

Assert the fixture entry point registers the production widget renderers, uses `dialectPlugins`, uses
the production `widgetsPlugin`, sets `readOnly`, and does not import collaboration or `PlanProvider`.

- [ ] **Step 2: Implement `StaticPlanEditor`**

Mount `MDXEditor` with supplied canonical `source`, the same lexical theme and content class as
`PlanEditor`, `dialectPlugins({ core: false })`, `markdownShortcutPlugin()`, and `widgetsPlugin`.
Accept optional `research` and `questions` fixture stores. Export it only from an explicit
`@chopin/editor/static` package subpath.

- [ ] **Step 3: Create the canonical document fixture**

Include ordinary prose and links, headings, ordered/unordered/task lists, table, note/tip/warning/danger
callouts, tabs, inline/block maths, plain and TypeScript code, valid and invalid diffs, Mermaid diagram,
image success/failure specimens, a research node, and decision-related prose. Use the real dialect
syntax and fixed valid IDs.

- [ ] **Step 4: Show sidecar states beside the document**

Render `ResearchCard` for each lifecycle state, a populated `ResearchComposer`, resolved decision and
comment cards, plus their empty/loading/error variants. This keeps record-owned state authoritative
instead of forging decision records inside MDX.

- [ ] **Step 5: Verify and commit**

Run: `bun test packages/editor/src/static-plan-editor.test.ts apps/web/src/design-audit/inventory.test.ts && bun --cwd packages/editor run types && bun --cwd apps/web run types`
Expected: PASS.

Commit: `git add packages/editor apps/web/src/design-audit && git commit -m "Catalogue authored document components"`

### Task 6: Browser audit handoff

**Files:**
- Create: `docs/design-system-audit.md`

- [ ] **Step 1: Start the real development server**

Run: `bun run dev`
Expected: the supervisor reports the local application URL. Open `/design-audit` without signing in.

- [ ] **Step 2: Inspect desktop and mobile in one broad pass**

Capture full-page and section screenshots at 1440px and 390px. Check overflow, target size, focus,
disabled state, hierarchy, icon geometry/colour, spacing rhythm, surface elevation, modal/menu behaviour,
tabs, authored blocks, and loading states.

- [ ] **Step 3: Inspect the authenticated application**

Open the ordinary application root. If it shows GitHub sign-in, stop and notify the user so they can
complete authentication. Once signed in, compare the repository picker, navigation, document,
conversation, decisions, comments, research, dialogs, menus, and loading transitions against the
catalogue at desktop and mobile widths.

- [ ] **Step 4: Record evidence**

Create `docs/design-system-audit.md` with a health score, P0–P3 findings with file/line evidence,
positive findings, exact duplicate icons, and a human-judgement parking lot. Each finding must explain
impact and name the token/component boundary that should own the fix.

- [ ] **Step 5: Write the evidence-based normalisation plan**

Create a second small-slice plan from the verified P1/P2 findings. Do not include speculative P3 work.

- [ ] **Step 6: Commit the audit**

Commit: `git add docs/design-system-audit.md docs/superpowers/plans && git commit -m "Document design system audit findings"`
