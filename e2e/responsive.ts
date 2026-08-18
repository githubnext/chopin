import { expect } from "@playwright/test";

import type { Locator, Page } from "@playwright/test";

export const RESPONSIVE_VIEWPORTS = [
	{ name: "phone-320", width: 320, height: 568 },
	{ name: "phone-390", width: 390, height: 844 },
	{ name: "phone-430", width: 430, height: 932 },
	{ name: "phone-landscape", width: 844, height: 390 },
	{ name: "tablet-portrait", width: 768, height: 1024 },
	{ name: "tablet-landscape", width: 1024, height: 768 },
	{ name: "desktop", width: 1440, height: 900 },
] as const;

const TABS = "01K0N4TR8K7JGM4R1J7PW4R8YJ";
const TAB_FIRST = "01K0N4V4E7Y6P4MJ5WD8XZF3B2";
const TAB_SECOND = "01K0N4W3B7P27CBAEC7A8C8WEA";
const TAB_THIRD = "01K0N4X9ERK4P3R5AZBJ8Y0P6C";
const TAB_FOURTH = "01K0N4Z7WH8C7H1P2Q9N4S6J3D";
const CALLOUT = "01K0N4Y9VG9DHBFZB6HC89E2AW";
const LATEX_SLASH = "\\";

/** Kept remote in canonical MDX; browser tests fulfill it before navigation. */
export const RESPONSIVE_IMAGE_URL = "https://example.com/images/responsive-workspace-reference.png";

let paragraphs = Array.from(
	{ length: 24 },
	(_, index) =>
		`Paragraph ${
			index + 1
		} keeps the representative plan long enough to exercise scrolling without reducing its prose to a synthetic row.`,
).join("\n\n");

/** A single source that makes responsive tests exercise each document surface. */
export const RESPONSIVE_SOURCE = `# Responsive architecture review

This deliberately long opening paragraph gives the fixture comment injector enough ordinary prose to quote while a reader can still find its argument among the richer blocks below.

The canonical reference is [TheCompleteArchitectureDecisionRecordForResponsiveWorkspaceContainmentMustWrapWithoutWideningTheDocument](https://example.com/architecture/decisions/responsive-workspace/viewport-safe-area-and-keyboard-avoidance-with-a-very-long-path-that-must-wrap-cleanly).

| UnbreakableResponsibility | UnbreakableViewportConstraint | UnbreakableInteractionSurface | UnbreakableVerificationSignal | UnbreakableRendererBoundary | UnbreakableCollaborationRecord | UnbreakableOverflowOwnership | UnbreakableAccessibleMeasure |
| ------------------------- | ----------------------------- | ----------------------------- | ----------------------------- | --------------------------- | ------------------------------ | ---------------------------- | ---------------------------- |
| DocumentSynchronization | CompactDestinationSwitching | CollaborativeEditorIdentity | NoHorizontalOverflow | PreviewIsASecondReading | SourceRemainsCollaborative | WidgetOwnsItsScrollbar | ProseKeepsItsMeasure |
| ConversationContinuity | CompactFocusContainment | DraftPreservation | VisibleControlBounds | RendererLoadsOnDemand | StableLexicalIdentity | WidgetOwnsItsScrollbar | ReadableCellMinimum |

\`\`\`typescript
export function destinationFor(width: number): "compact" | "split" {
	return width < 1200 ? "compact" : "split";
}
export const unbrokenPreviewLine = "ThisPreviewLineIsDeliberatelyLongEnoughToRequireTheCodeWidgetToOwnHorizontalScrollingWithoutWideningTheCollaborativeDocument";
\`\`\`

\`\`\`diff
--- a/apps/web/src/workspace.tsx
+++ b/apps/web/src/workspace.tsx
@@ -1,1 +1,1 @@
-<main className="min-w-[400px]" />
+<main className="min-w-0 w-full" />
\`\`\`

![Responsive workspace reference](${RESPONSIVE_IMAGE_URL})

\`\`\`mermaid
flowchart LR
	CompactDocumentMeasureThatReadersCanTrack --> IndependentWidgetScrollersThatPreserveTheDocumentWidth
	IndependentWidgetScrollersThatPreserveTheDocumentWidth --> KeyboardSafeDestinationSwitchingAcrossResponsiveWorkspaces
	KeyboardSafeDestinationSwitchingAcrossResponsiveWorkspaces --> DurableAgentChangeChipsAndCollaboratorCursorLabels
\`\`\`

$$
${LATEX_SLASH}mathrm{CompactDocumentMeasureMustRemainReadableWhileIndependentWidgetsOwnTheirOverflow} ${LATEX_SLASH}Rightarrow ${LATEX_SLASH}mathrm{ResponsiveWorkspace}
$$

<Tabs id="${TABS}">
<Tab id="${TAB_FIRST}" label="Compact destination switching">

One destination occupies the available width at a time.

</Tab>
<Tab id="${TAB_SECOND}" label="Wide split workspace reading">

Conversation remains beside the document when room permits it.

</Tab>
<Tab id="${TAB_THIRD}" label="Keyboard-safe compact conversation destination">

Temporary conversation still preserves the document's readable measure.

</Tab>
<Tab id="${TAB_FOURTH}" label="Independent wide-widget scrolling contract">

Each wide widget owns its overflow without widening the collaborative source.

</Tab>
</Tabs>

<Callout id="${CALLOUT}" type="warning" title="EveryVisibleControlStaysInTheCompactViewportWhileItsOwnInputScrollsWithoutWideningTheDocument">

Every visible control and focused element stays inside the visual viewport.

</Callout>

Inline \`UnbreakableInlineCodeTokenThatMustStayInsideTheReadableDocumentMeasureEvenWhenItsAuthoredIntrinsicWidthFarExceedsTheDesktopReadingColumnAndNeedsToWrapWithoutWideningTheCollaborativeDocument\` belongs with the surrounding prose.

${paragraphs}
`;

export async function expectNoHorizontalOverflow(page: Page): Promise<void> {
	let dimensions = await page.evaluate(() => ({
		scrollWidth: document.documentElement.scrollWidth,
		clientWidth: document.documentElement.clientWidth,
	}));
	expect(dimensions.scrollWidth).toBeLessThanOrEqual(dimensions.clientWidth);
}

export async function expectInsideViewport(locator: Locator): Promise<void> {
	let outside = await locator.evaluateAll(nodes =>
		nodes.flatMap(node => {
			let element = node as HTMLElement;
			let style = getComputedStyle(element);
			let rectangle = element.getBoundingClientRect();
			if (
				style.display === "none"
				|| style.visibility === "hidden"
				|| rectangle.width === 0
				|| rectangle.height === 0
			) return [];

			let viewport = visualViewport ?? {
				offsetLeft: 0,
				offsetTop: 0,
				width: innerWidth,
				height: innerHeight,
			};
			let inside = rectangle.left >= viewport.offsetLeft
				&& rectangle.top >= viewport.offsetTop
				&& rectangle.right <= viewport.offsetLeft + viewport.width
				&& rectangle.bottom <= viewport.offsetTop + viewport.height;
			return inside ? [] : [{
				left: rectangle.left,
				top: rectangle.top,
				right: rectangle.right,
				bottom: rectangle.bottom,
				viewport,
			}];
		})
	);
	expect(outside).toEqual([]);
}
