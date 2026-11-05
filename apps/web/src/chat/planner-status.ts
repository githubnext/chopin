import type { Session } from "@chopin/protocol";

/** Where a machine that cannot be connected to is explained, and what to do about it. */
export const PLANNER_HOW_TO_FIX =
	"https://github.com/githubnext/chopin/blob/main/docs/chopin-cli.md#cant-connect-to-a-machine";

/**
 * What the document says about its remote Planner when it is not simply attached and healthy,
 * which says nothing at all. It is one status told in several places: the machine button's name
 * and its menu, and, for the one state a person can act on, the strip on the composer's top edge.
 *
 * It speaks of the machine, not the Planner: `starting` is connecting to it, `cant-start` is not
 * being able to, with why in full and what has been tried; `disconnected` and `held` say what is
 * kept; `none` says what `@chopin` needs. Only the GitHub login is ever named, never its machine,
 * so another person's machine is "@mona’s machine" and an attached client is "@mona’s Planner";
 * the viewer's own machine is named plainly.
 */
export type PlannerStatus =
	| { kind: "starting"; text: string }
	| { kind: "cant-start"; title: string; reason: string; detail: string }
	| { kind: "disconnected"; text: string }
	| { kind: "held"; text: string }
	| { kind: "none"; text: string };

/** A time of day in the viewer's own clock, as the rest of Chat writes it. */
export function clockTime(iso: string): string {
	return new Date(iso).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

/** A reason as the sentence it ends, without doubling a stop it already carries. */
function sentence(reason: string): string {
	let text = reason.trim();
	return /[.!?]$/.test(text) ? text : `${text}.`;
}

export const NO_PLANNER = "No Planner is attached. @chopin needs one to reply.";

export function plannerStatus(
	planner: Session.PlannerAttachment | undefined,
	machine?: string,
): PlannerStatus | undefined {
	if (!planner || planner.state === "attached") return undefined;
	if (planner.state === "none") return { kind: "none", text: NO_PLANNER };
	let who = `@${planner.login}’s Planner`;
	if (planner.state === "held") {
		return {
			kind: "held",
			text: `${who} detached. The document and its Decisions are kept, and @${planner.login} `
				+ `can reattach until ${clockTime(planner.until)}.`,
		};
	}
	if (planner.state === "disconnected") {
		return {
			kind: "disconnected",
			text: `${machine ?? who} is offline. Its work is kept and picks up when it’s back.`,
		};
	}
	let where = machine ?? `@${planner.login}’s machine`;
	let failure = planner.failure;
	if (!failure) return { kind: "starting", text: `Connecting to ${where}` };
	return {
		kind: "cant-start",
		title: `Can’t connect to ${where}`,
		reason: sentence(failure.reason),
		detail: `${
			failure.attempts === 1 ? "Tried once" : `Tried ${failure.attempts} times`
		}, last at ${clockTime(failure.at)}. Still trying.`,
	};
}

/** The status as one sentence a name, a tooltip or a strip can carry. */
export function plannerSentence(status: PlannerStatus): string {
	return status.kind === "cant-start" ? `${status.title}.` : status.text;
}

/**
 * What the machine button's status dot becomes: a spinner while the Planner starts, a warning
 * where it cannot, and a muted grey while it is away. A healthy Planner, or none at all, leaves
 * the machine's own dot as it is.
 */
export type PlannerGlyph = "starting" | "failing" | "away";

export function plannerGlyph(status: PlannerStatus | undefined): PlannerGlyph | undefined {
	if (!status) return undefined;
	return status.kind === "starting"
		? "starting"
		: status.kind === "cant-start"
		? "failing"
		: status.kind === "none"
		? undefined
		: "away";
}

/** The machine button's accessible name and tooltip, with what is happening to its Planner. */
export function plannerButtonLabel(label: string, status: PlannerStatus | undefined): string {
	return status ? `${label}. ${plannerSentence(status)}` : label;
}

/** What the strip on the composer's top edge says, if anything. */
export type PlannerNotice = {
	tone: "warning" | "info";
	text: string;
	/** For a screen reader only: the reason and what has been tried. */
	detail?: string;
	link?: { label: string; href: string };
};

/**
 * The strip on the composer's top edge: a warning, always, for a Planner that cannot start, with
 * where to fix it; and, only while the draft is addressed to Chopin, the plain sentence for any
 * other state that means @chopin cannot reply yet, so the person is told when it matters and the
 * composer is otherwise left alone.
 */
export function plannerNotice(
	status: PlannerStatus | undefined,
	addressed: boolean,
): PlannerNotice | undefined {
	if (!status) return undefined;
	if (status.kind === "cant-start") {
		return {
			tone: "warning",
			text: plannerSentence(status),
			detail: `${status.reason} ${status.detail}`,
			link: { label: "How to fix", href: PLANNER_HOW_TO_FIX },
		};
	}
	return addressed ? { tone: "info", text: plannerSentence(status) } : undefined;
}
