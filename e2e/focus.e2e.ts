import { content, expect, test } from "./room";
import { expectFocusIndicator } from "./focus";

let CALLOUT = `<Callout id="01K0N4W3B7P27CBAEC7A8C8WEA" type="note" title="Note">

Body text.

</Callout>`;

test("the plan editor uses its caret as its focus indicator", async ({ join, seed }) => {
	await seed("Plan text");
	let page = await join("ana");
	let editor = content(page);
	await editor.focus();

	await expect(editor).toBeFocused();
	await expect(editor).toHaveCSS("outline-style", "none");
});

test("a plan control keeps its focus ring inside the document scrollport", async ({ join, seed }) => {
	await seed(CALLOUT);
	let page = await join("ana");
	let trigger = content(page).getByRole("combobox", { name: "Change callout type: Note" });
	await trigger.focus();
	await trigger.evaluate(element => {
		let scrollport = element.closest("[data-plan-scroll]")!;
		let targetBounds = element.getBoundingClientRect();
		let scrollportBounds = scrollport.getBoundingClientRect();
		let x = scrollportBounds.left - targetBounds.left;
		let y = scrollportBounds.top - targetBounds.top;
		(element as HTMLElement).style.transform = `translate(${x}px, ${y}px)`;
	});

	await expectFocusIndicator(trigger);
});
