import { expect, test } from "bun:test";

import { PLANNER_HOW_TO_FIX, plannerStatus } from "./chat/planner-status";
import { ADD_MACHINE_PATH, machineFix, refusedSentence, startWhy } from "./machine-fix";
import { INTERNAL_IN_STATUS } from "@chopin/protocol/plain-words";

import type { MachineFix } from "./machine-fix";

const AT = "2026-11-04T18:29:00.000Z";

function failing(
	attempts = 3,
	reason = "exit 127: /usr/bin/env: 'node': No such file or directory",
) {
	return { state: "starting", login: "mona", failure: { attempts, reason, at: AT } } as const;
}

const MINE = { mine: true, choose: true, place: "menu" } as const;

test("nothing to fix while the machine is attached, connecting, or stepped away", () => {
	expect(machineFix(undefined, MINE)).toBeUndefined();
	expect(machineFix(plannerStatus({ state: "starting", login: "mona" }, "studio"), MINE))
		.toBeUndefined();
	expect(
		machineFix(plannerStatus({ state: "held", login: "mona", until: AT }, "studio"), MINE),
	).toBeUndefined();
});

test("a machine of the viewer's own that can't start: why in words, then numbered single actions with the command alone", () => {
	let fix = machineFix(plannerStatus(failing(), "studio"), MINE)!;
	expect(fix).toEqual({
		kind: "cant-start",
		title: "Can't connect to studio",
		why: "A program it needs can't be found on it.",
		steps: [
			{ text: "On studio, see why it stops:", command: "chopin status" },
			{ text: "Fix what it names, such as a program that isn't installed." },
			{ text: "Wait a moment.", hint: "It connects again by itself once it's fixed." },
			{ text: "Or choose another machine below." },
		],
		// The machine's own line, word for word, and when it was last tried, for Show details; how
		// often is never said.
		details: [
			"exit 127: /usr/bin/env: 'node': No such file or directory",
			expect.stringMatching(/^Last tried at .+\.$/),
		],
		learnMore: PLANNER_HOW_TO_FIX,
	});
});

test("someone else's machine asks its owner, by login, and never tells the viewer to run anything on it", () => {
	let fix = machineFix(plannerStatus(failing()), { mine: false, choose: false, place: "note" })!;
	expect(fix.title).toBe("Can't connect to @mona's machine");
	expect(fix.steps).toEqual([
		{ text: "Ask @mona to run this on their machine:", command: "chopin status" },
	]);
	let away = machineFix(plannerStatus({ state: "disconnected", login: "mona" }), {
		mine: false,
		choose: false,
		place: "note",
	})!;
	expect(away.steps).toEqual([{ text: "Ask @mona to bring their machine back online." }]);
});

test("a release that can't say why is told to update, and one that hasn't answered to check it is on", () => {
	let older = machineFix(
		plannerStatus(
			failing(
				2,
				"It started and stopped again before it connected. It runs chopin 0.0.20, which can't say why: run `chopin update` on it",
			),
			"studio",
		),
		{ ...MINE, choose: false },
	)!;
	expect(older.why).toBe("It runs an older chopin that can't say why it stops.");
	expect(older.steps.slice(0, 1)).toEqual([
		{ text: "On studio, update chopin:", command: "chopin update" },
	]);
	let silent = machineFix(plannerStatus(failing(0, "It hasn't answered yet"), "studio"), {
		...MINE,
		choose: false,
	})!;
	expect(silent.why).toBe("It hasn't answered yet.");
	expect(silent.steps.map(step => step.command)).toEqual([undefined, "chopin status", undefined]);
	expect(silent.details![1]).toMatch(/^Waiting since [^.]+\.$/);
});

test("an offline machine says when it was last seen and that the work is kept, then how to start it again", () => {
	let seen = new Date().toISOString();
	let fix = machineFix(
		plannerStatus({ state: "disconnected", login: "mona" }, "studio", seen),
		MINE,
	)!;
	expect(fix.kind).toBe("offline");
	expect(fix.title).toBe("studio is offline");
	expect(fix.why).toMatch(/^It was last seen at .+\. Your work is kept\.$/);
	expect(fix.steps).toEqual([
		{ text: "Check that studio is awake and online." },
		{ text: "Start chopin on it again:", command: "chopin connect" },
		{ text: "Or choose another machine below." },
	]);
	expect(fix.details).toBeUndefined();
});

test("no machine at all is fixed by adding one, from Chopin's own Machines page", () => {
	let fix = machineFix(plannerStatus({ state: "none" }), {
		mine: false,
		choose: true,
		place: "note",
	})!;
	expect(fix.title).toBe("No machine is connected");
	expect(fix.steps[0]).toEqual({
		text: "Add your computer or a cloud machine.",
		link: { label: "Add machine", href: ADD_MACHINE_PATH },
	});
	// Outside the menu, choosing another machine is an action of its own.
	expect(fix.steps[1]).toEqual({ text: "Or use another machine for this document.", choose: true });
});

test("the why is a plain sentence however the machine put it, and unknown causes stay general", () => {
	expect(startWhy("bash: claude: command not found")).toBe(
		"A program it needs can't be found on it.",
	);
	expect(startWhy("EACCES: permission denied, open '~/.config'")).toBe(
		"It isn't allowed to run something it needs.",
	);
	expect(startWhy("unsafe-checkout: ~/src/score's own git configuration")).toBe(
		"It stops each time before it connects.",
	);
});

test("every word of the steps is plain: none of Chopin's own terms, one action per step, commands never in a sentence", () => {
	let fixes: MachineFix[] = [
		machineFix(plannerStatus(failing(), "studio"), MINE)!,
		machineFix(plannerStatus(failing(), "studio"), { ...MINE, place: "note" })!,
		machineFix(plannerStatus(failing()), { mine: false, choose: true, place: "note" })!,
		machineFix(plannerStatus({ state: "disconnected", login: "mona" }, "studio"), MINE)!,
		machineFix(plannerStatus({ state: "none" }), MINE)!,
	];
	for (let fix of fixes) {
		for (let words of [fix.title, fix.why, ...fix.steps.map(step => step.text)]) {
			expect(INTERNAL_IN_STATUS.test(words), words).toBe(false);
			expect(words, words).not.toMatch(/`|chopin (status|update|connect)/);
		}
		for (let step of fix.steps) expect(step.text.split(/[.:] /).length, step.text).toBe(1);
	}
});

test("chopin's row says a refused message's cause in one sentence, the steps' own title, never the machine's raw line", () => {
	let fix = machineFix(plannerStatus(failing()), { mine: false, choose: false, place: "note" })!;
	expect(refusedSentence(fix)).toBe(
		"Can't connect to @mona's machine, so this message wasn't sent.",
	);
	let away = machineFix(plannerStatus({ state: "disconnected", login: "mona" }), {
		mine: false,
		choose: false,
		place: "note",
	})!;
	expect(refusedSentence(away)).toBe("@mona's machine is offline, so this message wasn't sent.");
	expect(refusedSentence(machineFix(plannerStatus({ state: "none" }), MINE)!)).toBe(
		"No machine is connected, so this message wasn't sent.",
	);
});
