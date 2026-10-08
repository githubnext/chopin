import { describe, expect, test } from "bun:test";

import { MAX_RESEARCH_BRIEF, ResearchLauncher } from "./research-launcher";

import type { ResearchLaunchResult } from "./research-launcher";

function launch(result: ResearchLaunchResult = { ok: true }) {
	let opened: string[] = [];
	return {
		opened,
		check: () => result,
		open: (brief: string) => {
			opened.push(brief);
			return result;
		},
		reveal: () => true,
	};
}

describe("research launcher", () => {
	test("is unavailable until an editor attaches", () => {
		let launcher = new ResearchLauncher();
		expect(launcher.check("brief")).toEqual({ ok: false, reason: "unavailable" });
		expect(launcher.open("brief")).toEqual({ ok: false, reason: "unavailable" });
		expect(launcher.reveal()).toBe(false);
	});

	test("opens through the attached editor", () => {
		let launcher = new ResearchLauncher();
		let editor = launch();
		launcher.attach(editor);
		expect(launcher.open("what changed?")).toEqual({ ok: true });
		expect(editor.opened).toEqual(["what changed?"]);
		expect(launcher.reveal()).toBe(true);
	});

	test("a stale detach leaves the newer editor attached", () => {
		let launcher = new ResearchLauncher();
		let detachFirst = launcher.attach(launch());
		let second = launch();
		let detachSecond = launcher.attach(second);
		detachFirst();
		expect(launcher.open("x")).toEqual({ ok: true });
		expect(second.opened).toEqual(["x"]);
		detachSecond();
		expect(launcher.open("x")).toEqual({ ok: false, reason: "unavailable" });
	});

	test("reports the editor's reason and never opens past a failed check", () => {
		let launcher = new ResearchLauncher();
		let editor = launch({ ok: false, reason: "drafting" });
		launcher.attach(editor);
		expect(launcher.check("x")).toEqual({ ok: false, reason: "drafting" });
		expect(launcher.open("x")).toEqual({ ok: false, reason: "drafting" });
		expect(editor.opened).toEqual([]);
	});

	test("refuses a brief the composer could not send", () => {
		let launcher = new ResearchLauncher();
		let editor = launch();
		launcher.attach(editor);
		let longest = "a".repeat(MAX_RESEARCH_BRIEF);
		expect(launcher.open(longest)).toEqual({ ok: true });
		expect(launcher.check(`${longest}a`)).toEqual({ ok: false, reason: "too-long" });
		expect(launcher.open(`${longest}a`)).toEqual({ ok: false, reason: "too-long" });
		expect(editor.opened).toEqual([longest]);
	});
});
