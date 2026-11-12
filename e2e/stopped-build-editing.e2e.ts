/**
 * A build that was stopped after its agent had claimed the tasks leaves the document as editable as
 * it was before the build. The document here has the shape of a long specification: headings,
 * prose, lists, code in two languages and a table.
 */

import { content, expect, ready, test, written } from "./room";
import { stoppedClaimedBuild } from "./build-seed";
import type { Page } from "@playwright/test";
import type { Graph } from "../apps/server/src/tasks/graphs";

const SPECIFICATION = `# Badge Renewal Specification

Renewal issues a fresh badge to a member whose old one is about to lapse.

## Scope

- A member asks for a renewal with their number and a code.
- An operator renews on a member's behalf.

1. Look up the member.
2. Check the code.
3. Issue the badge.

## Shape

\`\`\`rust
pub fn renew(member: &Member, code: &str) -> Result<Badge, RenewalError> {
    check(member, code)?;
    Ok(Badge::issue(member))
}
\`\`\`

\`\`\`gherkin
Scenario: A lapsed badge is renewed
  Given a member whose badge lapses tomorrow
  When they ask for a renewal
  Then a fresh badge is issued
\`\`\`

| Case | Outcome |
| --- | --- |
| Valid code | A badge |
| Wrong code | Refused |

The last paragraph closes the specification.
`;

/**
 * Click just after `text` where the document shows it, then wait until the editor has read the
 * caret: Lexical takes it from the `selectionchange` that follows, a task later.
 */
async function clickAfter(page: Page, text: string): Promise<void> {
	let point = await page.evaluate(wanted => {
		let root = document.querySelector(".plan-content")!;
		let walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
		for (let node = walker.nextNode(); node; node = walker.nextNode()) {
			let at = node.textContent!.indexOf(wanted);
			if (at < 0) continue;
			node.parentElement!.scrollIntoView({ block: "center" });
			let range = document.createRange();
			range.setStart(node, at + wanted.length - 1);
			range.setEnd(node, at + wanted.length);
			let rect = range.getBoundingClientRect();
			return { x: rect.right - 1, y: rect.top + rect.height / 2 };
		}
		throw new Error(`No text ${wanted}`);
	}, text);
	await page.mouse.click(point.x, point.y);
	await expect.poll(() =>
		page.evaluate(() => {
			type Point = { key: string; offset: number; type: string };
			let editor = (document.querySelector(".plan-content") as unknown as {
				__lexicalEditor?: {
					getEditorState(): { _selection: { anchor?: Point; focus?: Point } | null };
					getElementByKey(key: string): HTMLElement | null;
				};
			} | null)?.__lexicalEditor;
			let dom = getSelection();
			let anchor = editor?.getEditorState()._selection?.anchor;
			if (!editor || !anchor || !dom?.anchorNode) return false;
			return !!editor.getElementByKey(anchor.key)?.contains(dom.anchorNode)
				&& (anchor.type !== "text" || anchor.offset === dom.anchorOffset);
		})
	).toBe(true);
}

function graph(): Graph {
	return {
		versions: [{
			number: 1,
			revision: 1,
			planRevision: 0,
			state: "approved",
			definition: {
				tasks: [{
					id: "renew",
					title: "Renew a badge",
					context: "The Shape section.",
					goal: "A member can renew a badge.",
					acceptance: ["A valid code renews the badge.", "A wrong code is refused."],
					dependsOn: [],
				}],
			},
		}],
	};
}

test("a build stopped after its agent claimed the tasks leaves every block editable", async ({ context, seed, join, room }) => {
	await seed(SPECIFICATION, stoppedClaimedBuild(graph()));
	await context.grantPermissions(["clipboard-read", "clipboard-write"]);
	let page = await join("ana");
	let errors: string[] = [];
	page.on("pageerror", error => errors.push(error.message));
	let editor = content(page);
	await expect(editor).toHaveAttribute("contenteditable", "true");

	// A paragraph, a heading, a list item and a line of code.
	await clickAfter(page, "closes the specification.");
	await page.keyboard.type(" Edited prose.");
	await clickAfter(page, "Scope");
	await page.keyboard.type(" and limits");
	await clickAfter(page, "Check the code.");
	await page.keyboard.type(" twice");
	await clickAfter(page, "Then a fresh badge is issued");
	await page.keyboard.type(" today");
	// A deletion.
	await clickAfter(page, "on a member's behalf.");
	for (let index = 0; index < "'s behalf.".length; index++) await page.keyboard.press("Backspace");
	await page.keyboard.type(".");
	// A paste.
	await clickAfter(page, "When they ask for a renewal");
	await page.evaluate(() => navigator.clipboard.writeText("\n  And the old badge is retired"));
	await page.keyboard.press("ControlOrMeta+V");

	await written(page, room, /The last paragraph closes the specification\. Edited prose\./);
	await written(page, room, /^## Scope and limits$/m);
	await written(page, room, /^2\. Check the code\. twice$/m);
	await written(page, room, /Then a fresh badge is issued today/);
	await written(page, room, /^- An operator renews on a member\.$/m);
	await written(page, room, /When they ask for a renewal\n {2}And the old badge is retired\n/);

	// The document stays open after a reload.
	await page.reload();
	await ready(page);
	await expect(content(page)).toHaveAttribute("contenteditable", "true");
	await expect(content(page)).toContainText("Edited prose.");
	expect(errors).toEqual([]);
});
