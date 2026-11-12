/**
 * The machine fix-it steps, as plain decisions: what to do when the document's machine can't be
 * connected to, is offline, or there is none. One model for every place that draws them, the
 * machine button's menu and the "How to fix" of a refused `@chopin` (`fix-steps.tsx`).
 *
 * A short title, one plain sentence of why, then numbered steps of one action each, a command
 * standing alone in its own block so it can be copied whole. What the machine reported, word for
 * word, is kept for "Show details", and how often it was tried is said quietly at the foot. Only
 * the owner's login names someone else's machine (`planner-status.ts`); the viewer's own is named
 * plainly, and only the viewer's own machine is told to run something.
 */

import { PLANNER_HOW_TO_FIX } from "./chat/planner-status";
import type { PlannerStatus } from "./chat/planner-status";

const DOCS = "https://github.com/githubnext/chopin/blob/main/docs/chopin-cli.md";
const KEEP_RUNNING = `${DOCS}#keep-it-running`;
const ADD_A_MACHINE = `${DOCS}#add-a-machine`;

/** Where the Machines page's Add machine flow starts: Add your computer, opened at once. */
export const ADD_MACHINE_PATH = "/machines?add";

export type FixStep = {
	/** The one action, in a sentence; it ends with a colon where a command follows. */
	text: string;
	/** A command to run, alone in its block, copied whole. */
	command?: string;
	/** A place in Chopin that does it. */
	link?: { label: string; href: string };
	/** The machine button's choice does it, opened from here. */
	choose?: true;
	/** A quiet line under the action, where it needs one. */
	hint?: string;
};

export type MachineFix = {
	kind: "cant-start" | "offline" | "none";
	title: string;
	/** One plain sentence of why. */
	why: string;
	steps: FixStep[];
	/** What the machine reported, word for word, and when it was last tried, under "Show details". */
	details?: string[];
	/** How often it was tried, said quietly at the foot ("Tried 3 times"). */
	tried?: string;
	learnMore: string;
};

/** Where the person is reading the steps, which decides how another machine is chosen. */
export type FixPlace = "menu" | "note";

/**
 * Why a machine's Planner keeps stopping, in a sentence, from the line it reported. The line itself
 * is the machine's (a path, a command, an exit code) and is never tidied; it stays in the details.
 */
export function startWhy(reason: string): string {
	if (/chopin update/.test(reason)) return "It runs an older chopin that can't say why it stops.";
	if (/hasn't answered yet/.test(reason)) return "It hasn't answered yet.";
	if (/No such file or directory|command not found|not found|ENOENT|exit 127/i.test(reason)) {
		return "A program it needs can't be found on it.";
	}
	if (/permission denied|EACCES|EPERM/i.test(reason)) {
		return "It isn't allowed to run something it needs.";
	}
	return "It stops each time before it connects.";
}

/**
 * The steps for the Planner's status, or nothing where there is nothing to fix: it is attached,
 * connecting, or stepped away and coming back by itself. `mine` is the viewer's own machine, the
 * only one they can run a command on; `choose` is whether they may choose another for the document.
 */
export function machineFix(
	status: PlannerStatus | undefined,
	{ mine, choose, place }: { mine: boolean; choose: boolean; place: FixPlace },
): MachineFix | undefined {
	if (!status) return undefined;
	let another: FixStep[] = !choose
		? []
		: place === "menu"
		? [{ text: "Or choose another machine below." }]
		: [{ text: "Or use another machine for this document.", choose: true }];
	if (status.kind === "cant-start") {
		let older = /chopin update/.test(status.reason);
		let silent = status.attempts === 0;
		let steps: FixStep[] = !mine
			? [{ text: `Ask @${status.login} to run this on their machine:`, command: "chopin status" }]
			: older
			? [{ text: `On ${status.where}, update chopin:`, command: "chopin update" }]
			: silent
			? [
				{ text: `Check that ${status.where} is on and online.` },
				{ text: "On it, check that chopin is connected:", command: "chopin status" },
			]
			: [
				{ text: `On ${status.where}, see why it stops:`, command: "chopin status" },
				{ text: "Fix what it names, such as a program that isn't installed." },
			];
		// Chopin keeps trying, so the last thing to do is nothing: it connects by itself.
		let wait: FixStep[] = mine
			? [{ text: "Wait a moment.", hint: "It connects again by itself once it's fixed." }]
			: [];
		return {
			kind: "cant-start",
			title: status.title,
			why: startWhy(status.reason),
			steps: [...steps, ...wait, ...another],
			details: [status.reason, status.detail],
			tried: silent
				? "Not answered yet"
				: status.attempts === 1
				? "Tried once"
				: `Tried ${status.attempts} times`,
			learnMore: PLANNER_HOW_TO_FIX,
		};
	}
	if (status.kind === "disconnected") {
		let steps: FixStep[] = mine
			? [
				{ text: `Check that ${status.where} is awake and online.` },
				{ text: "Start chopin on it again:", command: "chopin connect" },
			]
			: [{ text: `Ask @${status.login} to bring their machine back online.` }];
		return {
			kind: "offline",
			title: `${status.where} is offline`,
			why: status.seen
				? `It was last seen at ${status.seen}. Your work is kept.`
				: "Your work is kept until it's back.",
			steps: [...steps, ...another],
			learnMore: KEEP_RUNNING,
		};
	}
	if (status.kind === "none") {
		return {
			kind: "none",
			title: "No machine is connected",
			why: "Replies come from a machine connected to this document.",
			steps: [
				{
					text: "Add your computer or a cloud machine.",
					link: { label: "Add machine", href: ADD_MACHINE_PATH },
				},
				...another,
			],
			learnMore: ADD_A_MACHINE,
		};
	}
	return undefined;
}
