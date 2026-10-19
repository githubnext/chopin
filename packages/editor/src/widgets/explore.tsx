/**
 * Exploring an open decision: one Explore menu that researches the web, investigates the codebase, or asks
 * someone, and the compact row that shows what came back.
 */

import { Popover } from "@base-ui/react/popover";
import {
	ChevronIcon,
	CircleCloseIcon,
	CommentIcon,
	GlobeSearchIcon,
	InvestigationIcon,
	LoaderIcon,
	MagnifierIcon,
} from "@chopin/icons";
import { InlineNotice } from "@chopin/visuals/inline-notice";
import { useEffect, useId, useRef, useState, useSyncExternalStore } from "react";

import type { ReactNode } from "react";

import { Face } from "../face";

import type { Question } from "@chopin/protocol";
import type { Transport } from "../transport";
import type { ExploreResources } from "../widget-options";

type Finding = Question.Finding;

const NOTHING = () => () => {};

/** The research brief for a decision: its question, the options on the table, and the focus. */
export function exploreBrief(question: string, options: readonly string[], focus: string): string {
	let lines = [question.trim()];
	if (options.length > 0) {
		lines.push("", "Options under consideration:", ...options.map(option => `- ${option}`));
	}
	if (focus.trim()) lines.push("", `Find out: ${focus.trim()}`);
	return lines.join("\n");
}

export function runningFindings(findings: readonly Finding[] | undefined): Finding[] {
	return (findings ?? []).filter(finding => finding.status === "running");
}

/** People still asked about a decision, who have not replied. */
export function waitingOn(findings: readonly Finding[] | undefined): string[] {
	return [
		...new Set(
			runningFindings(findings).filter(finding => finding.kind === "ask").map(finding =>
				finding.ref
			),
		),
	];
}

/** Explorations that take time and can be stopped: research and investigations. */
function working(findings: readonly Finding[] | undefined): Finding[] {
	return runningFindings(findings).filter(finding => finding.kind !== "ask");
}

/** What a finding says in one line, whether or not it has finished. */
export function findingLine(finding: Finding): string {
	if (finding.status === "ready" && finding.kind === "ask") {
		return finding.summary ?? `@${finding.ref} replied`;
	}
	if (finding.status === "ready") return finding.title ?? "Finished";
	if (finding.status === "failed") {
		return finding.kind === "spike" ? "The investigation didn’t finish" : "Research didn’t finish";
	}
	if (finding.status === "stopped") return "Stopped";
	if (finding.kind === "ask") return `Waiting for @${finding.ref}`;
	if (finding.kind === "spike") return finding.focus || "Investigating…";
	return finding.focus || "Researching…";
}

/** The quiet detail at the end of a finding's row. */
export function findingMeta(finding: Finding): string | undefined {
	if (finding.status !== "ready") return undefined;
	if (finding.kind === "research") {
		let count = finding.sourceCount ?? finding.sources?.length ?? 0;
		return count === 1 ? "1 source" : `${count} sources`;
	}
	if (finding.kind === "spike" && finding.branch) return "1 branch";
	return undefined;
}

export function FindingIcon({ finding }: { finding: Finding }) {
	if (finding.kind === "ask") return <Face decorative handle={finding.ref} size={16} />;
	if (finding.status === "running") {
		return <LoaderIcon aria-hidden="true" className="explore-spin" />;
	}
	return finding.kind === "spike"
		? <InvestigationIcon aria-hidden="true" />
		: <GlobeSearchIcon aria-hidden="true" />;
}

/** "Sam", "Sam and Lily", "Sam and 2 others". */
export function waitingNames(logins: readonly string[]): string {
	if (logins.length <= 2) return logins.join(" and ");
	let rest = logins.length - 1;
	return `${logins[0]} and ${rest} others`;
}

/** Who a decision is waiting on: an amber capsule, the first face then the words. */
export function WaitingStatus(
	{ logins, onOpen }: { logins: readonly string[]; onOpen?: () => void },
) {
	if (logins.length === 0) return null;
	let content = (
		<>
			<Face decorative handle={logins[0]!} size={16} />
			<span className="explore-waiting-names">Waiting for {waitingNames(logins)}</span>
		</>
	);
	return onOpen
		? (
			<button className="explore-waiting" data-decision-waiting="" onClick={onOpen} type="button">
				{content}
			</button>
		)
		: <span className="explore-waiting" data-decision-waiting="">{content}</span>;
}

/** Findings that count toward the card's quiet "N findings" button: all but unanswered asks. */
export function shownFindings(findings: readonly Finding[] | undefined): Finding[] {
	return (findings ?? []).filter(finding => finding.kind !== "ask" || finding.status === "ready");
}

/**
 * The card footer's count of what exploring found. It opens the decision's page, where every
 * finding is listed; nothing shows while research runs, since the trigger says so.
 */
export function FindingsCount(
	{ findings, onOpen }: { findings: readonly Finding[] | undefined; onOpen?: () => void },
) {
	let count = shownFindings(findings).length;
	if (count === 0 || !onOpen || working(findings).length > 0) return null;
	return (
		<button className="explore-count" data-decision-findings="" onClick={onOpen} type="button">
			<MagnifierIcon aria-hidden="true" size={14} />
			<span className="explore-count-text">{count === 1 ? "1 finding" : `${count} findings`}</span>
		</button>
	);
}

type Section = "research" | "spike" | "ask";

/** Folds open inside the popover; collapsed content is inert so focus never lands in it. */
function Fold({ children, id, open }: { children: ReactNode; id: string; open: boolean }) {
	return (
		<div className="explore-fold" data-open={open ? "" : undefined} id={id}>
			<div className="explore-fold-inner" inert={!open}>{children}</div>
		</div>
	);
}

/**
 * The single Research action. It opens as a list: research the web or investigate the codebase
 * (each folds open for optional details and a start button), or ask someone. While one runs, the
 * button reads Researching and the menu offers Stop instead.
 */
export function ExploreMenu(
	{ disabled, findings, id, options, question, resources, wire }: {
		disabled?: boolean;
		findings: readonly Finding[] | undefined;
		id: string;
		options: readonly string[];
		question: string;
		resources: ExploreResources;
		wire: Transport;
	},
) {
	let [open, setOpen] = useState(false);
	let [section, setSection] = useState<Section>();
	let [focus, setFocus] = useState("");
	let [busy, setBusy] = useState(false);
	let [error, setError] = useState<string>();
	let first = useRef<HTMLButtonElement>(null);
	let details = useRef<Partial<Record<Section, HTMLTextAreaElement | null>>>({});
	let peopleList = useRef<HTMLDivElement>(null);
	let baseId = useId();
	useSyncExternalStore(resources.subscribe ?? NOTHING, resources.spikeUnavailable);
	let spikeReason = resources.spikeUnavailable();
	let active = working(findings);
	let exploring = active.length > 0;
	// Taken when the list expands, so asking someone does not empty it while the menu closes.
	let [people, setPeople] = useState<readonly string[]>([]);

	useEffect(() => {
		if (!section) return;
		if (section === "ask") {
			peopleList.current?.querySelector<HTMLElement>("button:not(:disabled)")?.focus();
		} else {
			details.current[section]?.focus();
		}
	}, [section]);

	let record = async (body: Record<string, unknown>) => {
		let reply = await wire.ask<Question.Explore.Reply>("question:explore", { id, ...body });
		if (!reply.ok) throw new Error(reply.message);
	};
	let run = async (action: () => Promise<void>) => {
		if (busy) return;
		setBusy(true);
		setError(undefined);
		try {
			await action();
			setOpen(false);
			setFocus("");
		} catch (failure) {
			setError(failure instanceof Error ? failure.message : "Couldn’t start that");
		} finally {
			setBusy(false);
		}
	};
	let brief = () => exploreBrief(question, options, focus);
	let research = () =>
		run(async () => {
			let key = crypto.randomUUID();
			let ref = await resources.research(brief(), key);
			await record({ key, action: "research", ref, focus });
		});
	let spike = () =>
		run(async () => {
			let key = crypto.randomUUID();
			await resources.spike(brief(), key);
			await record({ key, action: "spike", focus });
		});
	let ask = (login: string) =>
		run(() => record({ key: crypto.randomUUID(), action: "ask", login, focus }));
	let stop = () =>
		run(async () => {
			for (let finding of active) {
				let reply = await wire.ask<Question.Explore.Stopped>("question:explore-stop", {
					id,
					finding: finding.id,
				});
				if (!reply.ok) throw new Error(reply.message);
			}
		});
	let toggle = (next: Section) => {
		if (next === "ask" && section !== "ask") {
			setPeople(resources.people().filter(person => !waitingOn(findings).includes(person)));
		}
		setSection(section === next ? undefined : next);
	};

	let form = (kind: "research" | "spike") => {
		let start = kind === "research" ? research : spike;
		return (
			<Fold id={`${baseId}-${kind}`} open={section === kind}>
				<div className="explore-form">
					<textarea
						aria-label="Details (optional)"
						className="explore-details"
						disabled={busy}
						maxLength={500}
						onChange={event => setFocus(event.target.value)}
						onKeyDown={event => {
							if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
								event.preventDefault();
								void start();
							}
						}}
						placeholder="What should it focus on?"
						ref={node => {
							details.current[kind] = node;
						}}
						rows={3}
						value={focus}
					/>
					<button
						className="btn btn-sm btn-primary explore-start"
						disabled={busy}
						onClick={() => void start()}
						type="button"
					>
						{kind === "research" ? "Start research" : "Start investigation"}
					</button>
				</div>
			</Fold>
		);
	};

	return (
		<Popover.Root
			onOpenChange={next => {
				setOpen(next);
				if (next) {
					setSection(undefined);
					setError(undefined);
				}
			}}
			open={open}
		>
			<Popover.Trigger
				aria-busy={exploring || undefined}
				className={exploring ? "explore-capsule" : "btn btn-sm btn-outline explore-trigger"}
				disabled={disabled}
				data-exploring={exploring ? "" : undefined}
			>
				{exploring
					? <LoaderIcon aria-hidden="true" className="explore-spin" />
					: <MagnifierIcon aria-hidden="true" />}
				{exploring
					? active.some(finding => finding.kind === "spike") ? "Investigating" : "Researching"
					: "Research"}
				{!exploring && <ChevronIcon aria-hidden="true" className="explore-trigger-chevron" />}
			</Popover.Trigger>
			<Popover.Portal>
				<Popover.Positioner align="end" className="explore-positioner" sideOffset={4}>
					<Popover.Popup aria-label="Research" className="explore-menu" initialFocus={first}>
						{exploring
							? (
								<>
									{active[0]?.focus && <p className="explore-running">{active[0].focus}</p>}
									<button
										className="app-menu-item"
										disabled={busy}
										onClick={() => void stop()}
										ref={first}
										type="button"
									>
										<CircleCloseIcon aria-hidden="true" />
										Stop
									</button>
								</>
							)
							: (
								<>
									<button
										aria-controls={`${baseId}-research`}
										aria-expanded={section === "research"}
										className="app-menu-item"
										onClick={() => toggle("research")}
										ref={first}
										type="button"
									>
										<GlobeSearchIcon aria-hidden="true" />
										Research the web
									</button>
									{form("research")}
									<button
										aria-controls={`${baseId}-spike`}
										aria-disabled={spikeReason ? "true" : undefined}
										aria-expanded={spikeReason ? undefined : section === "spike"}
										className="app-menu-item"
										onClick={() => {
											if (!spikeReason) toggle("spike");
										}}
										title={spikeReason}
										type="button"
									>
										<InvestigationIcon aria-hidden="true" />
										Investigate the codebase
										{spikeReason && <span className="sr-only">: {spikeReason}</span>}
									</button>
									{form("spike")}
								</>
							)}
						<button
							aria-controls={`${baseId}-ask`}
							aria-expanded={section === "ask"}
							className="app-menu-item"
							onClick={() => toggle("ask")}
							type="button"
						>
							<CommentIcon aria-hidden="true" />
							Ask someone
						</button>
						<Fold id={`${baseId}-ask`} open={section === "ask"}>
							<div className="explore-people" ref={peopleList}>
								{people.length === 0
									? <p className="explore-empty">Nobody else is here yet</p>
									: people.map(person => (
										<button
											className="app-menu-item"
											disabled={busy}
											key={person}
											onClick={() => void ask(person)}
											type="button"
										>
											<Face decorative handle={person} size={16} />
											<span className="truncate">@{person}</span>
										</button>
									))}
							</div>
						</Fold>
						{error && (
							<div className="explore-notice">
								<InlineNotice message={error} tone="danger" />
							</div>
						)}
					</Popover.Popup>
				</Popover.Positioner>
			</Popover.Portal>
		</Popover.Root>
	);
}
