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

	test("is a listbox of options named by login with the active one selected", () => {
		expect(html).toContain('role="listbox"');
		expect(html).toContain('id="mentions-option-0"');
		expect(html).toContain('aria-label="chopin"');
		expect(html).toContain('aria-label="octocat"');
		expect(html.match(/aria-selected="true"/g)).toHaveLength(1);
		expect(html).toContain('id="mentions-option-1" role="option" tabindex="-1" type="button"');
	});

	test("draws a decorative avatar for people and the Planner mark for the Planner", () => {
		expect(html).toContain('alt=""');
		expect(html).toContain("https://github.com/octocat.png?size=40");
		expect(html).not.toContain("github.com/chopin.png");
		expect(html).toContain(
			'class="chat-agent-mark" data-circle="true" role="img" aria-label="Chopin"',
		);
		expect(html).toContain('fill="currentColor"');
		expect(html).toContain('<svg aria-hidden="true"');
	});

	test("shows nothing but the login in a row", () => {
		let text = html.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
		expect(text).toBe("chopin octocat");
	});
});
