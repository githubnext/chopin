import { expect, test } from "bun:test";

import { mentionRemarkPlugin, mentionRuns } from "./message-mentions";

const KNOWN = new Set(["ana", "cy", "bo-li", "chopin"]);

/** The mentions a text is split into, in order, and the words between them. */
function split(text: string): (string | { mention: string })[] | undefined {
	return mentionRuns(text, KNOWN)?.map(run =>
		run.type === "text" ? run.value! : { mention: run.children![0]!.value! }
	);
}

test("every known login in a text is a mention, not only the first", () => {
	expect(split("@ana @cy")).toEqual([{ mention: "@ana" }, " ", { mention: "@cy" }]);
	expect(split("@ana, @cy and @bo-li.")).toEqual([
		{ mention: "@ana" },
		", ",
		{ mention: "@cy" },
		" and ",
		{ mention: "@bo-li" },
		".",
	]);
	expect(split("ask @Chopin then @CY")).toEqual([
		"ask ",
		{ mention: "@Chopin" },
		" then ",
		{ mention: "@CY" },
	]);
	expect(split("(@ana)")).toEqual(["(", { mention: "@ana" }, ")"]);
});

test("an unknown login, an address, a longer word and a doubled @ stay words", () => {
	expect(split("@zed and @ana")).toEqual(["@zed and ", { mention: "@ana" }]);
	expect(split("mail ana@cy.dev")).toBeUndefined();
	expect(split("@anagram")).toBeUndefined();
	expect(split("@@ana")).toBeUndefined();
	expect(split("no one")).toBeUndefined();
});

test("the plugin finds mentions in every paragraph, list item and emphasis, and not in code or links", () => {
	let text = (value: string) => ({ type: "text", value });
	let tree = {
		type: "root",
		children: [
			{ type: "paragraph", children: [text("@ana @cy")] },
			{
				type: "list",
				children: [{
					type: "listItem",
					children: [{
						type: "paragraph",
						children: [text("hi "), { type: "strong", children: [text("@cy")] }, text(" @ana")],
					}],
				}],
			},
			{ type: "paragraph", children: [{ type: "inlineCode", value: "@ana" }] },
			{ type: "paragraph", children: [{ type: "link", children: [text("@ana")] }] },
			{ type: "paragraph", children: [text("x"), text("@ana")] },
		],
	};
	mentionRemarkPlugin(KNOWN)(tree as never);
	let mentions: string[] = [];
	let walk = (node: { type: string; children?: unknown[]; data?: unknown }) => {
		if (node.type === "chatMention") {
			mentions.push((node.children![0] as { value: string }).value);
			expect(node.data).toEqual({
				hName: "span",
				hProperties: {
					className: ["chat-mention"],
					"data-mention": (node.children![0] as { value: string }).value.slice(1),
				},
			});
		}
		for (let child of node.children ?? []) walk(child as typeof node);
	};
	walk(tree);
	expect(mentions).toEqual(["@ana", "@cy", "@cy", "@ana"]);
});
