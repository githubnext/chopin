/**
 * Wireframe fences, drawn.
 *
 * A wireframe is chromeless: no label, no source toggle, no language menu.
 * The source is reached by going into the drawing, and folds shut again on
 * Escape or when focus leaves. What the parser and the outline decide is unit
 * tested in `packages/diagrams`; this is the browser's half.
 */

import { content, expect, test, written } from "./room";
import { expectNoHorizontalOverflow } from "./responsive";

const PANEL = `\`\`\`wireframe
panel "Implementation"
  header
    button "Approve" primary
  text "Build on Laptop" muted
\`\`\`
`;

test("a wireframe fence is drawn without chrome, its source folded away", async ({ join, seed }) => {
	await seed(`Before\n\n${PANEL}\nAfter\n`);
	let page = await join("ana");
	let block = content(page).locator(".planCode");
	let drawing = block.getByRole("region", { name: "Implementation wireframe", exact: true });

	await expect(drawing).toBeVisible();
	await expect(drawing.getByText("Approve", { exact: true })).toBeVisible();
	await expect(block.locator("[data-plan-source]")).toBeHidden();
	// No toggle, no language control, and no real controls inside the drawing.
	await expect(block.getByRole("button")).toHaveCount(0);
	await expect(block.getByRole("textbox")).toHaveCount(0);
	await expect(block.getByText("Wireframe", { exact: true })).toHaveCount(0);
});

test("going into a wireframe opens its source, and editing redraws it", async ({ join, room, seed }) => {
	await seed(PANEL);
	let page = await join("ana");
	let block = content(page).locator(".planCode");
	let drawing = block.getByRole("region", { name: "Implementation wireframe", exact: true });
	let source = block.locator("[data-plan-source]");

	await drawing.click();
	await expect(source).toBeVisible();
	await expect(drawing).toBeVisible();
	await expect(content(page)).toBeFocused();

	await page.keyboard.press("Enter");
	await page.keyboard.type('  text "Added later"');
	await written(page, room, /^ {2}text "Added later"$/m);
	await expect(drawing.getByText("Added later", { exact: true })).toBeVisible();

	await page.keyboard.press("Escape");
	await expect(source).toBeHidden();
	await expect(drawing).toBeFocused();

	await page.keyboard.press("Enter");
	await expect(source).toBeVisible();
	await expect(content(page)).toBeFocused();

	// Leaving the editor folds it as Escape does.
	await content(page).evaluate(element => (element as HTMLElement).blur());
	await expect(source).toBeHidden();
	await expect(drawing).toBeVisible();
});

test("an invalid wireframe is code with its problem, until it is fixed", async ({ join, room, seed }) => {
	await seed('```wireframe\npanel "P"\n  button "Go"\n  x\n```\n');
	let page = await join("ana");
	let block = content(page).locator(".planCode");
	let source = block.locator("[data-plan-source]");

	await expect(source).toBeVisible();
	await expect(block.getByRole("region")).toHaveCount(0);
	let error = block.locator("[data-plan-error]");
	await expect(error.getByText("This wireframe could not be drawn")).toBeVisible();
	await expect(error).toContainText('Line 4: Unknown kind "x".');
	await expect(block.getByRole("button")).toHaveCount(0);

	// The end of the last line, then the stray word goes.
	let box = (await source.boundingBox())!;
	await source.click({ position: { x: box.width - 4, y: box.height - 4 } });
	await page.keyboard.press("Backspace");
	await written(page, room, /```wireframe\npanel "P"\n {2}button "Go"\n\s*```/);

	await expect(block.getByRole("region", { name: "P wireframe", exact: true })).toBeVisible();
	await expect(error).toHaveCount(0);
	// Still being written in, so the source stays open below the drawing.
	await expect(source).toBeVisible();
	await expect(block).toHaveAttribute("data-plan-language", "wireframe");
});

test("a narrow wireframe reflows: rows stack and a flow runs downward", async ({ join, seed }) => {
	await seed(`\`\`\`wireframe
row flow
  card "First"
    text "One"
  card "Second" #second
    text "Two"
note "Waits on the first" -> #second
\`\`\`
`);
	let page = await join("ana", { viewport: { width: 390, height: 844 } });
	let drawing = content(page).getByRole("region", { name: "Wireframe", exact: true });
	await expect(drawing).toBeVisible();

	let first = await drawing.getByText("One", { exact: true }).boundingBox();
	let second = await drawing.getByText("Two", { exact: true }).boundingBox();
	let note = await drawing.getByText("Waits on the first", { exact: true }).boundingBox();
	expect(second!.y).toBeGreaterThan(first!.y + first!.height);
	// Notes move below the drawing rather than beside it.
	expect(note!.y).toBeGreaterThan(second!.y + second!.height);
	await expectNoHorizontalOverflow(page);
});
