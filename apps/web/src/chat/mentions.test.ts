import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { addressed } from "@chopin/protocol/address";

import { MentionPicker } from "./mention-picker";
import {
	chatAuthors,
	filterMentions,
	insertMention,
	mentionCandidates,
	mentionKeyAction,
	mentionTrigger,
	mentionTriggerKey,
	pointerTrigger,
} from "./mentions";

import type { MentionCandidate } from "./mentions";

function at(text: string) {
	return mentionTrigger(text, text.indexOf("|") < 0 ? text.length : text.indexOf("|"));
}

describe("mention trigger", () => {
	test("opens at a word boundary and reports the typed query", () => {
		expect(mentionTrigger("@", 1)).toEqual({ query: "", start: 0, end: 1 });
		expect(mentionTrigger("Ask @ch", 7)).toEqual({ query: "ch", start: 4, end: 7 });
		expect(mentionTrigger("(@octo", 6)).toEqual({ query: "octo", start: 1, end: 6 });
		expect(mentionTrigger("one\n@oct", 8)).toEqual({ query: "oct", start: 4, end: 8 });
		expect(mentionTrigger("@a-b", 4)).toEqual({ query: "a-b", start: 0, end: 4 });
	});

	test("never opens inside an email address or after a word character", () => {
		expect(at("a@")).toBeUndefined();
		expect(at("a@b")).toBeUndefined();
		expect(at("mail a@b.com")).toBeUndefined();
		expect(at("hi@chopin")).toBeUndefined();
		expect(at("@@chopin")).toBeUndefined();
		expect(at("_@x")).toBeUndefined();
	});

	test("agrees with addressed() about where a mention begins", () => {
		for (let text of ["@chopin", " @chopin", "(@chopin", "a@chopin", "@@chopin", "_@chopin"]) {
			expect(mentionTrigger(text, text.length) !== undefined).toBe(addressed(text));
		}
	});

	test("needs a caret at the end of the login, with no selection", () => {
		expect(mentionTrigger("@chopin", 3)).toBeUndefined();
		expect(mentionTrigger("@chopin later", 3)).toBeUndefined();
		expect(mentionTrigger("@chopin later", 7)).toEqual({ query: "chopin", start: 0, end: 7 });
		expect(mentionTrigger("@chopin", 1, 3)).toBeUndefined();
		expect(mentionTrigger("@chopin", -1)).toBeUndefined();
		expect(mentionTrigger("@chopin", 99)).toBeUndefined();
	});

	test("closes once the query stops being a login", () => {
		expect(mentionTrigger("@ch ", 4)).toBeUndefined();
		expect(mentionTrigger("@ch.", 4)).toBeUndefined();
		expect(mentionTrigger("@ch_", 4)).toBeUndefined();
		expect(mentionTrigger(`@${"a".repeat(39)}`, 40)?.query).toHaveLength(39);
		expect(mentionTrigger(`@${"a".repeat(40)}`, 41)).toBeUndefined();
	});

	test("keys change with position and query", () => {
		let first = mentionTrigger("@a", 2)!;
		expect(mentionTriggerKey(first)).not.toBe(mentionTriggerKey(mentionTrigger("@ab", 3)!));
		expect(mentionTriggerKey(first)).not.toBe(mentionTriggerKey(mentionTrigger("x @a", 4)!));
	});
});

describe("the trigger for a part of the document or a file", () => {
	test("finds what mentionTrigger finds, with the same range and query", () => {
		for (
			let [text, caret] of [["@", 1], ["Ask @ch", 7], ["(@octo", 6], ["one\n@oct", 8], [
				"@a-b",
				4,
			]] as const
		) expect(pointerTrigger(text, caret)).toEqual(mentionTrigger(text, caret));
	});

	test("goes on past a space, a dot or a slash, for the words of a heading or a path", () => {
		expect(pointerTrigger("Rewrite @Site 1: harbour", 24)).toEqual({
			query: "Site 1: harbour",
			start: 8,
			end: 24,
		});
		expect(pointerTrigger("Look at @src/chat/a.ts", 22)?.query).toBe("src/chat/a.ts");
		expect(pointerTrigger("@ch ", 4)).toEqual({ query: "ch ", start: 0, end: 4 });
	});

	test("never opens inside an address, over a line break, past the longest query, or inside a word", () => {
		expect(pointerTrigger("mail a@b.com", 12)).toBeUndefined();
		expect(pointerTrigger("hi@chopin", 9)).toBeUndefined();
		expect(pointerTrigger("see a@b and @", 13)).toEqual({ query: "", start: 12, end: 13 });
		expect(pointerTrigger("@one\ntwo", 8)).toBeUndefined();
		expect(pointerTrigger(`@${"a ".repeat(32)}`, 65)?.query).toHaveLength(64);
		expect(pointerTrigger(`@${"a ".repeat(33)}`, 67)).toBeUndefined();
		expect(pointerTrigger("@chopin", 3)).toBeUndefined();
		expect(pointerTrigger("@chopin", 1, 3)).toBeUndefined();
		expect(pointerTrigger("no at sign", 5)).toBeUndefined();
	});
});

describe("mention candidates", () => {
	let planner: MentionCandidate = { kind: "planner", login: "chopin" };

	test("lists the Planner, then people here, then Chat authors, once each", () => {
		let candidates = mentionCandidates({
			authors: ["Octocat", "mona", "LAVAMAN131", "hubot"],
			people: ["lavaman131", "Octocat", "ana"],
			planner: true,
			self: "me",
		});
		expect(candidates).toEqual([
			planner,
			{ kind: "person", login: "lavaman131" },
			{ kind: "person", login: "Octocat" },
			{ kind: "person", login: "ana" },
			{ kind: "person", login: "mona" },
			{ kind: "person", login: "hubot" },
		]);
	});

	test("excludes the current user case-insensitively", () => {
		let candidates = mentionCandidates({
			authors: ["ME", "ana"],
			people: ["Me"],
			planner: true,
			self: "me",
		});
		expect(candidates).toEqual([planner, { kind: "person", login: "ana" }]);
	});

	test("reserves the Planner's name", () => {
		let candidates = mentionCandidates({
			authors: [],
			people: ["Chopin", "ana"],
			planner: true,
			self: "me",
		});
		expect(candidates).toEqual([planner, { kind: "person", login: "ana" }]);
	});

	test("offers only the Planner when alone with no history", () => {
		expect(mentionCandidates({ authors: [], people: ["me"], planner: true, self: "me" }))
			.toEqual([planner]);
	});

	test("omits the Planner when agent work is off", () => {
		expect(mentionCandidates({ authors: [], people: ["ana"], planner: false, self: "me" }))
			.toEqual([{ kind: "person", login: "ana" }]);
		expect(mentionCandidates({ authors: [], people: [], planner: false, self: "me" })).toEqual([]);
	});

	test("takes authors from members only, most recent first", () => {
		expect(chatAuthors([
			{ author: { kind: "member", handle: "ana" } },
			{ author: { kind: "agent" } },
			{ author: { kind: "system" } },
			{ author: { kind: "member", handle: "bo" } },
			{ author: { kind: "member", handle: "ana" } },
		])).toEqual(["ana", "bo", "ana"]);
	});
});

describe("mention filtering", () => {
	let candidates = mentionCandidates({
		authors: ["Chloe"],
		people: ["octocat", "ocean"],
		planner: true,
		self: "me",
	});

	test("matches a login prefix case-insensitively, keeping order", () => {
		expect(filterMentions(candidates, "").map(item => item.login)).toEqual([
			"chopin",
			"octocat",
			"ocean",
			"Chloe",
		]);
		expect(filterMentions(candidates, "ch").map(item => item.login)).toEqual(["chopin", "Chloe"]);
		expect(filterMentions(candidates, "OC").map(item => item.login)).toEqual(["octocat", "ocean"]);
		expect(filterMentions(candidates, "chopin").map(item => item.login)).toEqual(["chopin"]);
	});

	test("does not match inside a login", () => {
		expect(filterMentions(candidates, "cat")).toEqual([]);
	});
});

describe("mention insertion", () => {
	let planner: MentionCandidate = { kind: "planner", login: "chopin" };

	test("replaces the typed query with the login and a space", () => {
		let text = "Ask @ch";
		let trigger = mentionTrigger(text, text.length)!;
		expect(insertMention(text, trigger, planner)).toEqual({ text: "Ask @chopin ", caret: 12 });
	});

	test("keeps text after the caret and does not double an existing space", () => {
		let text = "@oc later";
		let trigger = mentionTrigger(text, 3)!;
		expect(insertMention(text, trigger, { kind: "person", login: "octocat" })).toEqual({
			text: "@octocat later",
			caret: 9,
		});
		let punctuated = "@oc, later";
		expect(
			insertMention(punctuated, mentionTrigger(punctuated, 3)!, {
				kind: "person",
				login: "octocat",
			}),
		).toEqual({ text: "@octocat , later", caret: 9 });
	});

	test("an inserted Planner mention addresses the Planner", () => {
		let trigger = mentionTrigger("@c", 2)!;
		expect(addressed(insertMention("@c", trigger, planner).text)).toBe(true);
	});

	test("an inserted person mention does not", () => {
		let trigger = mentionTrigger("@o", 2)!;
		let { text } = insertMention("@o", trigger, { kind: "person", login: "octocat" });
		expect(text).toBe("@octocat ");
		expect(addressed(text)).toBe(false);
	});

	test("leaves text alone when the trigger no longer matches it", () => {
		let trigger = mentionTrigger("@ch", 3)!;
		expect(insertMention("@xy", trigger, planner)).toEqual({ text: "@xy", caret: 3 });
	});
});

describe("mention keyboard", () => {
	test("moves, selects, and dismisses", () => {
		expect(mentionKeyAction({ key: "ArrowDown" }, true)).toBe("next");
		expect(mentionKeyAction({ key: "ArrowUp" }, true)).toBe("previous");
		expect(mentionKeyAction({ key: "Enter" }, true)).toBe("select");
		expect(mentionKeyAction({ key: "Tab" }, true)).toBe("select");
		expect(mentionKeyAction({ key: "Escape" }, true)).toBe("dismiss");
	});

	test("leaves modified and unrelated keys to the composer", () => {
		expect(mentionKeyAction({ key: "Enter", shiftKey: true }, true)).toBeUndefined();
		expect(mentionKeyAction({ key: "Tab", shiftKey: true }, true)).toBeUndefined();
		expect(mentionKeyAction({ key: "Tab", ctrlKey: true }, true)).toBeUndefined();
		expect(mentionKeyAction({ key: "a" }, true)).toBeUndefined();
		expect(mentionKeyAction({ key: "Tab" }, false)).toBeUndefined();
	});

	test("composition never selects, but a stray Escape is still the composer's", () => {
		for (let key of ["Enter", "Tab", "ArrowDown", "ArrowUp"]) {
			expect(mentionKeyAction({ key, isComposing: true }, true)).toBeUndefined();
			expect(mentionKeyAction({ key, keyCode: 229 }, true)).toBeUndefined();
		}
		expect(mentionKeyAction({ key: "Escape", isComposing: true }, true)).toBeUndefined();
	});
});

describe("mention picker markup", () => {
	let options: MentionCandidate[] = [
		{ kind: "planner", login: "chopin" },
		{ kind: "person", login: "octocat" },
	];
	let html = renderToStaticMarkup(
		createElement(MentionPicker, {
			active: 1,
			id: "mentions",
			onActive: () => {},
			onSelect: () => {},
			options,
		}),
	);

	test("is a listbox of options with the active one selected", () => {
		expect(html).toContain('role="listbox"');
		expect(html).toContain('aria-label="Mentions"');
		expect(html).toContain('id="mentions-option-0"');
		expect(html).toContain('id="mentions-option-1"');
		expect(html.match(/aria-selected="true"/g)).toHaveLength(1);
		// And the one selected is that active option.
		expect(html.match(/<button[^>]*id="mentions-option-1"[^>]*>/)![0]).toContain(
			'aria-selected="true"',
		);
		// A row is not a tab stop: the draft keeps focus and points at it.
		expect(html.match(/<button[^>]*id="mentions-option-0"[^>]*>/)![0]).toContain('tabindex="-1"');
	});

	test("lists Chopin first as an agent, and the people as human", () => {
		expect(html.indexOf(">Chopin<")).toBeLessThan(html.indexOf(">octocat<"));
		expect(html).toMatch(/>Chopin<\/span><span class="[^"]*">agent</);
		expect(html).toMatch(/>octocat<\/span><span class="[^"]*">human</);
	});

	test("draws a decorative avatar for people and the Planner mark for the Planner", () => {
		expect(html).toContain('alt=""');
		expect(html).toContain("https://github.com/octocat.png?size=40");
		expect(html).not.toContain("github.com/chopin.png");
		// The badge is hidden from a screen reader, which reads the row's own words.
		expect(html).toContain('<span aria-hidden="true"><span aria-hidden="true"');
	});
});

describe("the @ menu with the document's parts", () => {
	let groups = [{
		label: "Sections",
		options: [
			{ id: "heading:a", kind: "heading" as const, anchor: "a", label: "Overview", meta: "H1" },
			{ id: "decision:d", kind: "decision" as const, decisionId: "d", label: "Pick a store" },
			{ id: "file:f", kind: "file" as const, path: "src/a.ts", label: "src/a.ts" },
		],
	}];
	let render = (options: MentionCandidate[]) =>
		renderToStaticMarkup(
			createElement(MentionPicker, {
				active: 0,
				groups,
				id: "mentions",
				onActive: () => {},
				onSelect: () => {},
				onSelectPointer: () => {},
				options,
			}),
		);

	test("lists each kind of part after the people, tagged with its level or what it is", () => {
		let html = render([{ kind: "planner", login: "chopin" }, { kind: "person", login: "octocat" }]);
		expect(html.indexOf(">octocat<")).toBeLessThan(html.indexOf(">Overview<"));
		expect(html).toMatch(/>Overview<\/span><span class="[^"]*">H1</);
		expect(html).toMatch(/>Pick a store<\/span><span class="[^"]*">decision</);
		expect(html).toMatch(/>src\/a.ts<\/span><span class="[^"]*">file</);
		// No heading divides them: the tag says what a row is.
		expect(html).not.toContain('role="group"');
	});

	test("numbers the rows after the people, so the keys and the pointer agree on which is active", () => {
		let html = render([{ kind: "planner", login: "chopin" }, { kind: "person", login: "octocat" }]);
		expect(html).toContain('id="mentions-option-2"');
		expect(html.match(/<button[^>]*id="mentions-option-0"[^>]*>/)![0]).toContain(
			'aria-selected="true"',
		);
		expect(html.match(/<button[^>]*id="mentions-option-2"[^>]*>/)![0]).toContain(
			'aria-selected="false"',
		);
		expect(html).toContain("Overview");
		expect(html).toContain(">H1<");
	});
});
