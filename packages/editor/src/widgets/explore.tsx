/**
 * Exploring an open decision: one Explore menu that researches the web, builds a spike, or asks
 * someone, and the compact row that shows what came back.
 */

import { Popover } from "@base-ui/react/popover";
import {
	ArrowLeftIcon,
	ChevronIcon,
	CircleCloseIcon,
	CommentIcon,
	GlobeSearchIcon,
	InvestigationIcon,
	LoaderIcon,
	MagnifierIcon,
} from "@chopin/icons";
import { useId, useRef, useState, useSyncExternalStore } from "react";

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

/** Explorations that take time and can be stopped: research and spikes. */
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
		return finding.kind === "spike" ? "The spike didn’t finish" : "Research didn’t finish";
	}
	if (finding.status === "stopped") return "Stopped";
	if (finding.kind === "ask") return `Waiting for @${finding.ref}`;
	if (finding.kind === "spike") return finding.focus || "Building a spike…";
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

/**
 * The newest finding under the card's control, or a count when there are several. The row opens
 * the decision's page, where every finding is listed.
 */
export function FindingRow(
	{ findings, onOpen }: { findings: readonly Finding[] | undefined; onOpen?: () => void },
) {
	let shown = (findings ?? []).filter(finding =>
		finding.kind !== "ask" || finding.status === "ready"
	);
	if (shown.length === 0) return null;
	let latest = shown.at(-1)!;
	let content = shown.length > 1
		? (
			<>
				<span aria-hidden="true" className="explore-finding-icon">
					<MagnifierIcon />
				</span>
				<span className="explore-finding-line">{shown.length} findings</span>
			</>
		)
		: (
			<>
				<span aria-hidden="true" className="explore-finding-icon">
					<FindingIcon finding={latest} />
				</span>
				<span className="explore-finding-line">{findingLine(latest)}</span>
				{findingMeta(latest) && <span className="explore-finding-meta">{findingMeta(latest)}</span>}
			</>
		);
	if (!onOpen) {
		return <div className="explore-finding" data-decision-finding="">{content}</div>;
	}
	return (
		<button
			className="explore-finding"
			data-decision-finding=""
			onClick={onOpen}
			type="button"
		>
			{content}
			<ChevronIcon aria-hidden="true" className="explore-finding-chevron" />
		</button>
	);
}

type Step = "menu" | "ask";

/**
 * The single Explore action. Its field says what to find out; Enter researches the web. While
 * research or a spike runs, the button reads Exploring and the menu offers Stop instead.
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
	let [step, setStep] = useState<Step>("menu");
	let [focus, setFocus] = useState("");
	let [busy, setBusy] = useState(false);
	let [error, setError] = useState<string>();
	let field = useRef<HTMLInputElement>(null);
	let fieldId = useId();
	useSyncExternalStore(resources.subscribe ?? NOTHING, resources.spikeUnavailable);
	let spikeReason = resources.spikeUnavailable();
	let active = working(findings);
	let exploring = active.length > 0;
	let people = resources.people().filter(person => !waitingOn(findings).includes(person));

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

	return (
		<Popover.Root
			onOpenChange={next => {
				setOpen(next);
				if (next) {
					setStep("menu");
					setError(undefined);
				}
			}}
			open={open}
		>
			<Popover.Trigger
				aria-busy={exploring || undefined}
				className="btn btn-sm btn-outline explore-trigger"
				disabled={disabled}
				data-exploring={exploring ? "" : undefined}
			>
				{exploring
					? <LoaderIcon aria-hidden="true" className="explore-spin" />
					: <MagnifierIcon aria-hidden="true" />}
				{exploring ? "Exploring" : "Explore"}
				<ChevronIcon aria-hidden="true" className="explore-trigger-chevron" />
			</Popover.Trigger>
			<Popover.Portal>
				<Popover.Positioner align="end" className="explore-positioner" sideOffset={4}>
					<Popover.Popup
						aria-label="Explore"
						className="explore-menu"
						initialFocus={exploring ? undefined : field}
					>
						{step === "ask"
							? (
								<>
									<button
										className="app-menu-item"
										onClick={() => setStep("menu")}
										type="button"
									>
										<ArrowLeftIcon aria-hidden="true" />
										Ask someone
									</button>
									<div className="app-menu-separator" role="separator" />
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
								</>
							)
							: (
								<>
									<form
										className="explore-focus"
										onSubmit={event => {
											event.preventDefault();
											if (!exploring) void research();
										}}
									>
										<label className="sr-only" htmlFor={fieldId}>What should it find out?</label>
										<input
											autoComplete="off"
											className="explore-focus-field"
											disabled={exploring || busy}
											id={fieldId}
											maxLength={500}
											onChange={event => setFocus(event.target.value)}
											placeholder="What should it find out?"
											ref={field}
											value={exploring ? (active[0]?.focus ?? "") : focus}
										/>
									</form>
									{exploring
										? (
											<button
												className="app-menu-item"
												disabled={busy}
												onClick={() => void stop()}
												type="button"
											>
												<CircleCloseIcon aria-hidden="true" />
												Stop
											</button>
										)
										: (
											<>
												<button
													className="app-menu-item"
													disabled={busy}
													onClick={() => void research()}
													type="button"
												>
													<GlobeSearchIcon aria-hidden="true" />
													Research the web
												</button>
												<button
													aria-disabled={spikeReason ? "true" : undefined}
													className="app-menu-item"
													disabled={busy}
													onClick={() => {
														if (!spikeReason) void spike();
													}}
													title={spikeReason}
													type="button"
												>
													<InvestigationIcon aria-hidden="true" />
													Build a spike
													{spikeReason && <span className="sr-only">: {spikeReason}</span>}
												</button>
											</>
										)}
									<button
										className="app-menu-item"
										disabled={busy}
										onClick={() => setStep("ask")}
										type="button"
									>
										<CommentIcon aria-hidden="true" />
										Ask someone
									</button>
								</>
							)}
						{error && <p className="explore-error" role="alert">{error}</p>}
					</Popover.Popup>
				</Popover.Positioner>
			</Popover.Portal>
		</Popover.Root>
	);
}
