import type { Session } from "@chopin/protocol";

/** Where a machine that cannot be connected to is explained, and what to do about it. */
export const PLANNER_HOW_TO_FIX =
	"https://github.com/githubnext/chopin/blob/main/docs/chopin-cli.md#cant-connect-to-a-machine";

/**
 * What the document says about its remote Planner when it is not simply attached and healthy,
 * which says nothing at all. It is one status told in several places: the machine button's name
 * and its menu, a live region for a screen reader, and, where the person has no machine button,
 * the strip on the composer's top edge (see `plannerPlacement`).
 *
 * Plain words, with none of Chopin's own terms (no Planner, attach, hold or Decisions, and no
 * mention of Chopin) and a machine, not a Planner, as the subject: `starting` is connecting to it,
 * `cant-start` is not being able to, with why as the machine reported it and what has been tried;
 * `disconnected` and `held` say the work is kept; `none` says a machine is needed. Only the GitHub
 * login is ever named, never someone else's machine, so another person's machine is "@mona's
 * machine"; the viewer's own machine is named plainly. `status-copy.test.tsx` keeps it so.
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

/** When a machine was last seen: the time of day today, with its date on any other day. */
function seenAt(iso: string): string {
	let at = new Date(iso);
	return at.toDateString() === new Date().toDateString()
		? clockTime(iso)
		: at.toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

export const NO_MACHINE = "No machine is connected.";

/**
 * Whether the status of `planner` is only withheld: it is starting or has dropped, and `machine`
 * is `null`, so which machine is not known yet and nothing is said until it is.
 */
export function plannerWithheld(
	planner: Session.PlannerAttachment | undefined,
	machine: string | null | undefined,
): boolean {
	return machine === null && (planner?.state === "starting" || planner?.state === "disconnected");
}

/**
 * `machine` names the document's own machine where the Planner is on it; without one the status
 * says whose machine it is by login. `null` says the machine a starting or disconnected Planner
 * is on is not known yet, and nothing is said until it is.
 */
export function plannerStatus(
	planner: Session.PlannerAttachment | undefined,
	machine?: string | null,
	lastSeen?: string,
): PlannerStatus | undefined {
	if (!planner || planner.state === "attached") return undefined;
	if (planner.state === "none") return { kind: "none", text: NO_MACHINE };
	if (plannerWithheld(planner, machine)) return undefined;
	let where = machine ?? `@${planner.login}'s machine`;
	if (planner.state === "held") {
		return {
			kind: "held",
			text: `${where} stepped away. Your work is kept until ${clockTime(planner.until)}.`,
		};
	}
	if (planner.state === "disconnected") {
		return {
			kind: "disconnected",
			text: `${where} is offline. ${
				lastSeen ? `Last seen ${seenAt(lastSeen)}.` : "Your work is kept."
			}`,
		};
	}
	let failure = planner.failure;
	if (!failure) return { kind: "starting", text: `Connecting to ${where}` };
	return {
		kind: "cant-start",
		title: `Can't connect to ${where}`,
		// Exactly as the machine reported it: a path, a command or a code is not ours to tidy.
		reason: failure.reason,
		detail: `${
			failure.attempts === 1 ? "Tried once" : `Tried ${failure.attempts} times`
		}, last at ${clockTime(failure.at)}. Still trying.`,
	};
}

/** The status as one sentence a name, a tooltip, a strip or a screen reader can carry. */
export function plannerSentence(status: PlannerStatus): string {
	return status.kind === "cant-start" ? `${status.title}.` : status.text;
}

/**
 * What the machine button's status dot becomes: a spinner while the Planner starts, a warning
 * where it cannot, and a muted grey while it is away. With no machine connected there is no dot
 * at all, the bare icon of a button that has no machine; the machine's own green is never lent to
 * it. Only a healthy Planner leaves the machine's own dot as it is.
 */
export type PlannerGlyph = "starting" | "failing" | "away" | "none";

export function plannerGlyph(status: PlannerStatus | undefined): PlannerGlyph | undefined {
	if (!status) return undefined;
	return status.kind === "starting"
		? "starting"
		: status.kind === "cant-start"
		? "failing"
		: status.kind === "none"
		? "none"
		: "away";
}

/** The machine button's accessible name and tooltip, with what is happening to its Planner. */
export function plannerButtonLabel(label: string, status: PlannerStatus | undefined): string {
	return status ? `${label}. ${plannerSentence(status)}` : label;
}

/**
 * What a screen reader is told as the Planner's state changes: the sentence of a problem state it
 * has just entered, once. Nothing for a healthy Planner, nothing while the same state carries on
 * (its attempt count, or its machine's name catching up), and nothing as a state clears, since a
 * live region that falls silent says all a healthy state needs.
 */
export function plannerAnnouncement(
	previous: PlannerStatus["kind"] | undefined,
	next: PlannerStatus | undefined,
): string {
	return next && next.kind !== previous ? plannerSentence(next) : "";
}

/**
 * What a live region does as the status changes, or nothing (undefined): the sentence of a problem
 * state it has just entered, or silence as a state clears (`said` is empty), and the state it has
 * now said, which is what the next change is compared with.
 *
 * A status that is only withheld (`withheld`: the Planner's word is of a state whose machine is
 * not known yet) is a gap, not a clearing: the region falls silent, holding nothing stale, but
 * remembers the state last said, so the same state entered again once the machine is named is
 * not said twice, as a word that repeats it with one more attempt is while the list of machines
 * is read again.
 */
export function plannerSpeech(
	previous: PlannerStatus["kind"] | undefined,
	status: PlannerStatus | undefined,
	withheld: boolean,
): { kind: PlannerStatus["kind"] | undefined; said: string } | undefined {
	if (withheld && !status) return previous ? { kind: previous, said: "" } : undefined;
	let kind = status?.kind;
	return kind === previous ? undefined : { kind, said: plannerAnnouncement(previous, status) };
}

/** What the strip on the composer's top edge says. */
export type PlannerNotice = {
	tone: "warning" | "info";
	text: string;
	/** The reason as the machine reported it, then what has been tried, one line each. */
	detail?: readonly string[];
	link?: { label: string; href: string };
	/** The room's one live region announces the state, so the strip says nothing of its own. */
	silent: true;
};

/** Where the Planner's state is told, for a viewer who has the machine button or has not. */
export type PlannerPlacement = {
	/** For the machine button, its name and the top of its menu. */
	button: PlannerStatus | undefined;
	/** For the composer's top edge. */
	strip: PlannerNotice | undefined;
};

/**
 * The one decision about where a state is told, so the button, its menu and the strip cannot
 * disagree.
 *
 * Machine state lives in one place, as a contact's does in a chat: the machine button. With it, the
 * button carries every state, a machine that cannot be connected to included (its reason and where
 * to fix it are on the button's menu), and the composer is left alone. Without the button (no
 * machine paired or shared, a title bar that does not show one, a phone whose top bar an open child
 * has taken) the strip is the only place left to see the state, so for that person alone it
 * carries all of them, and the reason for a machine that cannot be connected to is drawn, in full,
 * beneath its sentence.
 *
 * While the page's offline notice shows, that notice is the one thing said about the connection and
 * the page cannot hear the machine anyway, so the strip says nothing, as the composer's other
 * strip about availability says nothing then. It returns by itself, with whatever state is then
 * known, as the notice goes. The button, which is in the title bar and not beside the notice, is
 * unaffected.
 */
export function plannerPlacement(
	status: PlannerStatus | undefined,
	hasButton: boolean,
	offline = false,
): PlannerPlacement {
	if (!status) return { button: undefined, strip: undefined };
	if (hasButton) return { button: status, strip: undefined };
	if (offline) return { button: undefined, strip: undefined };
	if (status.kind === "cant-start") {
		return {
			button: undefined,
			strip: {
				tone: "warning",
				text: plannerSentence(status),
				detail: [status.reason, status.detail],
				link: { label: "How to fix", href: PLANNER_HOW_TO_FIX },
				silent: true,
			},
		};
	}
	return {
		button: undefined,
		strip: { tone: "info", text: plannerSentence(status), silent: true },
	};
}
