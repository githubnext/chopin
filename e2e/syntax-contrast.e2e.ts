import { content, expect, test } from "./room";

const CODE = `\`\`\`typescript title="tokens.ts"
export const spacing = { compact: 8, comfortable: 12 };
\`\`\`

\`\`\`css
.button { padding-inline: var(--space-3); }
\`\`\`

\`\`\`diff
--- a/tokens.ts
+++ b/tokens.ts
@@ -1,2 +1,2 @@
-// old spacing
-export const spacing = { compact: 8 };
+// new spacing
+export const spacing = { compact: 12 };
\`\`\`
`;

test("code is coloured in place and a diff keeps its drawn preview, each with distinct syntax", async ({ join, seed }) => {
	await seed(CODE);
	let page = await join("ana");
	let previews = content(page).locator("[data-plan-preview] .plan-code-view");
	await expect(previews).toHaveCount(1);
	await expect(content(page).getByRole("group", { name: "Code preview" })).toHaveCount(0);
	await expect(content(page).getByRole("group", { name: "Diff preview" })).toHaveCount(1);
	await expect(content(page).getByRole("region", { name: "Code preview" })).toHaveCount(0);
	await expect(previews.locator("[data-diff]")).toHaveCount(1);
	await expect(previews.locator("[data-line][data-line-type='change-deletion']").first())
		.toContainText(
			"// old spacing",
		);
	await expect(previews.locator("[data-line][data-line-type='change-addition']").first())
		.toContainText(
			"// new spacing",
		);

	let tokens = previews.locator("[data-line] span[style*='color']");
	await expect.poll(() => tokens.count()).toBeGreaterThan(10);
	let seen = new Set<string>();
	for (let index = 0; index < await tokens.count(); index++) {
		let token = tokens.nth(index);
		let color = await token.evaluate(node => getComputedStyle(node).color);
		seen.add(color);
	}
	// Keep syntax categories distinct without imposing a contrast threshold.
	expect(seen.size).toBeGreaterThanOrEqual(5);

	// The code is painted over its own text, one highlight per role, each its own colour.
	let source = content(page).locator(".planCode [data-plan-source]").first();
	await expect.poll(() =>
		source.evaluate(element =>
			new Set(
				[...CSS.highlights.keys()].filter(name => name.startsWith("plan-code-")).map(name =>
					getComputedStyle(element, `::highlight(${name})`).color
				),
			).size
		)
	).toBeGreaterThanOrEqual(4);
});

test("a narrow code block scrolls its own lane to the caret", async ({ join, seed }) => {
	await seed(
		'```typescript\nexport const longLine = "ThisCodeLineIsIntentionallyLongEnoughToNeedItsOwnKeyboardScrollAreaInTheNarrowDocumentPane";\n```\n',
	);
	let page = await join("ana", { viewport: { width: 390, height: 844 } });
	let source = content(page).locator(".planCode [data-plan-source]");
	await expect(source).toBeVisible();
	await expect.poll(() => source.evaluate(node => node.scrollWidth > node.clientWidth)).toBe(true);
	await source.click({ position: { x: 20, y: 10 } });
	await page.keyboard.press("End");
	await expect.poll(() => source.evaluate(node => node.scrollLeft)).toBeGreaterThan(0);
});

test("diff preview text remains selectable", async ({ join, seed }) => {
	await seed(CODE);
	let page = await join("ana");
	let previews = content(page).locator("[data-plan-preview] .plan-code-view");
	await expect(previews).toHaveCount(1);
	let token = previews.locator("[data-line] span[style*='color']").first();
	await expect(token).toBeVisible();
	let selected = await token.evaluate(node => {
		let range = document.createRange();
		range.selectNodeContents(node);
		window.getSelection()?.removeAllRanges();
		window.getSelection()?.addRange(range);
		return window.getSelection()?.toString();
	});
	expect(selected).toBeTruthy();
	expect(selected).toBe(await token.textContent());
});
