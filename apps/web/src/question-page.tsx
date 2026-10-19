/**
 * A decision opened as its own page.
 *
 * The page is an ordinary child document whose body is the decision's Notes. Everything above
 * the notes is the root's record, read through the root workspace that stays mounted behind the
 * child: its status, question, answer, control, findings and takes.
 */

import {
	ExploreMenu,
	Face,
	FindingIcon,
	findingLine,
	findingMeta,
	personName,
	QuestionnaireCard,
	runningFindings,
	useQuestionPageDraft,
	waitingNames,
	waitingOn,
} from "@chopin/editor";
import { useTransitionPresence } from "@chopin/editor/transition-presence";
import { CheckIcon, ClockIcon, CloseIcon, LoaderIcon, RestartIcon } from "@chopin/icons";
import { Badge } from "@chopin/visuals";
import { UnfoldSection } from "@chopin/visuals/unfold";
import { createContext, useContext, useRef, useState } from "react";

import type { ExploreResources, QuestionnaireEntry, Transport } from "@chopin/editor";
import type { IconProps } from "@chopin/icons";
import type { Question } from "@chopin/protocol";
import type { ReactNode } from "react";

import { motionImmediately } from "./motion-input";
import { NavigationDialog } from "./navigation-dialog";
import { settledBy } from "./question-page-format";

import "./question-page.css";

export type QuestionPageRoot = {
	entries: readonly QuestionnaireEntry[];
	metadata: ReadonlyMap<string, Question.CardMeta>;
	wire?: Transport;
	explore?: ExploreResources;
	self?: string;
	canEdit: boolean;
	connected: boolean;
};

/** Provided by a top-level document to the child open over it. */
export const QuestionPageContext = createContext<QuestionPageRoot | undefined>(undefined);

/** The decision whose page `channelId` is, read from the root behind it. */
export function useQuestionPage(channelId: string) {
	let root = useContext(QuestionPageContext);
	if (!root) return undefined;
	for (let [id, meta] of root.metadata) {
		if (meta.childId !== channelId) continue;
		let entry = root.entries.find(value => value.id === id);
		return entry ? { entry, meta, root } : undefined;
	}
	return undefined;
}

type Status = { label: string; tone: "open" | "exploring" | "waiting" | "settled" };

export function pageStatus(meta: Question.CardMeta): Status {
	if (meta.status === "decided") return { label: "Settled", tone: "settled" };
	if (runningFindings(meta.findings).some(finding => finding.kind !== "ask")) {
		return { label: "Exploring", tone: "exploring" };
	}
	let waiting = waitingOn(meta.findings);
	if (waiting.length > 0) {
		return { label: "Waiting for", tone: "waiting" };
	}
	return { label: "Open", tone: "open" };
}

function Spinner({ size }: IconProps) {
	return <LoaderIcon aria-hidden="true" className="explore-spin" size={size} />;
}

const STATUS_BADGE = {
	open: { icon: ClockIcon, tone: "neutral" },
	exploring: { icon: Spinner, tone: "neutral" },
	waiting: { icon: ClockIcon, tone: "warning" },
	settled: { icon: CheckIcon, tone: "success" },
} as const;

function answer(entry: QuestionnaireEntry): string | undefined {
	let question = entry.value.questions[0];
	if (!question) return undefined;
	let chosen = question.options.filter(option => question.choices?.includes(option.id))
		.map(option => option.label);
	return chosen.length > 0 ? chosen.join(", ") : question.answer;
}

function letter(index: number): string {
	return String.fromCharCode(65 + index);
}

/** Asks for the decision to be discarded; throws the reason when the server refuses. */
export async function discardDecision(root: QuestionPageRoot, id: string): Promise<void> {
	if (!root.wire) throw new Error("Not connected. Try again when you're back online.");
	let reply = await root.wire.ask<{ ok?: boolean }>("question:discard", { id });
	if (!reply.ok) throw new Error("Could not discard this decision.");
}

/** Confirms before a decision is discarded, which cannot be undone. */
export function DiscardDecisionDialog(
	{ onConfirm, onDismiss, open }: {
		onConfirm: () => Promise<void>;
		onDismiss: () => void;
		open: boolean;
	},
) {
	let cancel = useRef<HTMLButtonElement>(null);
	let [busy, setBusy] = useState(false);
	let [error, setError] = useState<string>();
	let presence = useTransitionPresence(open ? true : undefined, 150, motionImmediately());
	if (presence.phase === "closed") return null;
	let dismiss = () => {
		if (!busy) onDismiss();
	};
	let confirm = async () => {
		setBusy(true);
		setError(undefined);
		try {
			await onConfirm();
		} catch (failure) {
			setError(failure instanceof Error ? failure.message : "Could not discard this decision.");
		} finally {
			setBusy(false);
		}
	};
	return (
		<NavigationDialog
			initialFocus={cancel}
			motion={presence}
			onDismiss={dismiss}
			title="Discard this decision?"
		>
			<p className="mt-2 text-sm text-text-secondary">
				The question and what was found for it are dropped. This cannot be undone.
			</p>
			{error && <p className="mt-3 text-sm text-destructive-ink" role="alert">{error}</p>}
			<div className="mt-4 flex justify-end gap-2">
				<button
					className="btn btn-md btn-secondary"
					disabled={busy}
					onClick={dismiss}
					ref={cancel}
					type="button"
				>
					Keep it
				</button>
				<button
					className="btn btn-md btn-destructive"
					disabled={busy}
					onClick={() => void confirm()}
					type="button"
				>
					{busy ? "Discarding…" : "Discard"}
				</button>
			</div>
		</NavigationDialog>
	);
}

function OpenActions(
	{ entry, meta, root }: {
		entry: QuestionnaireEntry;
		meta: Question.CardMeta;
		root: QuestionPageRoot;
	},
) {
	let question = entry.value.questions[0];
	let draft = useQuestionPageDraft({
		canEdit: root.canEdit,
		connected: root.connected,
		value: entry.value,
		wire: root.wire,
	});
	let explorable = !!root.explore && !!root.wire && draft.editable && !!question
		&& entry.value.questions.length === 1;
	return (
		<>
			{explorable && (
				<ExploreMenu
					findings={meta.findings}
					id={entry.id}
					options={question!.options.map(option => option.label)}
					question={question!.prompt}
					resources={root.explore!}
					wire={root.wire!}
				/>
			)}
			{root.canEdit && (
				<button
					className="btn btn-sm btn-primary"
					disabled={!draft.editable || draft.syncing || draft.submitting || !draft.ready}
					onClick={draft.save}
					type="button"
				>
					{draft.submitting ? "Saving…" : draft.error ? "Try again" : "Save"}
				</button>
			)}
		</>
	);
}

function SettledActions({ entry, root }: { entry: QuestionnaireEntry; root: QuestionPageRoot }) {
	let [busy, setBusy] = useState(false);
	let [error, setError] = useState<string>();
	if (!root.canEdit || !root.connected || !root.wire) return null;
	let reopen = async () => {
		if (busy) return;
		setBusy(true);
		setError(undefined);
		try {
			let reply = await root.wire!.ask<{ ok?: boolean }>("question:reopen", { id: entry.id });
			if (!reply.ok) throw new Error("Could not reopen it. Try again.");
		} catch (failure) {
			setError(failure instanceof Error ? failure.message : "Could not reopen it. Try again.");
		} finally {
			setBusy(false);
		}
	};
	return (
		<>
			{error && <span className="question-page-action-error" role="alert">{error}</span>}
			<button
				className="btn btn-sm btn-outline"
				disabled={busy}
				onClick={() => void reopen()}
				type="button"
			>
				<RestartIcon aria-hidden="true" />
				Reopen
			</button>
		</>
	);
}

/** What the title bar shows at its end: who is awaited, Research and Save, or Reopen once settled. */
export function QuestionPageActions(
	{ entry, meta, root }: {
		entry: QuestionnaireEntry;
		meta: Question.CardMeta;
		root: QuestionPageRoot;
	},
) {
	return (
		<div className="question-page-actions" data-question-page-actions="">
			{meta.status === "decided"
				? <SettledActions entry={entry} root={root} />
				: <OpenActions entry={entry} meta={meta} root={root} />}
		</div>
	);
}

/** A settled decision on its page: the answer, once. */
function Settled({ entry }: { entry: QuestionnaireEntry }) {
	let question = entry.value.questions[0];
	if (!question) return null;
	if (question.options.length === 0 || question.response === "text") {
		return (
			<section aria-label="Answer" className="question-page-answer">
				<h2>Answer</h2>
				<p className="question-page-answer-body">{question.answer ?? "Decided"}</p>
			</section>
		);
	}
	let chosen = question.options.filter(option => question.choices?.includes(option.id));
	// A supporting sentence belongs to one option; several choices have none to share.
	let description = chosen.length === 1 ? chosen[0]!.description : undefined;
	return (
		<div className="question-page-answer">
			<p className="question-page-answer-text">{answer(entry) ?? "Decided"}</p>
			{description && <p className="question-page-answer-support">{description}</p>}
		</div>
	);
}

/** What was weighed, read-only, with the chosen option tinted. Written answers have no list. */
function Considered({ entry }: { entry: QuestionnaireEntry }) {
	let question = entry.value.questions[0];
	if (!question || question.options.length === 0 || question.response === "text") return null;
	return (
		<section aria-label="What we considered" className="question-page-section">
			<h2>What we considered</h2>
			<div className="question-options question-page-considered">
				{question.options.map((option, index) => {
					let chosen = question.choices?.includes(option.id);
					return (
						<div
							className="question-choice-row question-option"
							data-selected={chosen ? "" : undefined}
							key={option.id}
						>
							<span aria-hidden="true" className="question-key">
								<span>{letter(index)}</span>
							</span>
							<span className="question-text">
								<span className="question-label">
									{chosen && <span className="sr-only">Chosen:</span>}
									{option.label}
								</span>
								{option.description && <span className="question-desc">{option.description}</span>}
							</span>
						</div>
					);
				})}
			</div>
		</section>
	);
}

export function QuestionPagePanel(
	{ actions, entry, meta, root }: {
		/** The title bar's actions, when the bar has no room for them (a phone). */
		actions?: ReactNode;
		entry: QuestionnaireEntry;
		meta: Question.CardMeta;
		root: QuestionPageRoot;
	},
) {
	let question = entry.value.questions[0];
	let settled = meta.status === "decided";
	let status = pageStatus(meta);
	let badge = STATUS_BADGE[status.tone];
	let settler = settled ? settledBy(meta, personName) : undefined;
	let waiting = settled ? [] : waitingOn(meta.findings);
	let findings = (meta.findings ?? []).filter(finding => finding.kind !== "ask");
	let takes = (meta.findings ?? []).filter(finding => finding.kind === "ask");
	return (
		<div className="question-page" data-question-page={entry.id}>
			{actions && <div className="question-page-inline-actions">{actions}</div>}
			<div className="question-page-status-row">
				<Badge
					className="question-page-status"
					icon={badge.icon}
					label={status.label}
					textSize="xs"
					tone={badge.tone}
				/>
				{settler && (
					<span className="question-page-note">
						<Face decorative handle={settler.handle} size={16} />
						{settler.text}
					</span>
				)}
				{waiting.length > 0 && status.tone === "waiting" && (
					<span className="question-page-note">
						{waiting.slice(0, 3).map(login => (
							<Face decorative handle={login} key={login} size={16} />
						))}
						{waitingNames(waiting.map(personName))}
					</span>
				)}
			</div>
			<h1 className="question-page-title">{question?.prompt ?? "Decision"}</h1>
			{settled
				? <Settled entry={entry} />
				: (
					<div className="question-page-control">
						<QuestionnaireCard
							canEdit={root.canEdit}
							connected={root.connected}
							meta={meta}
							page
							presentation="list"
							self={root.self}
							value={entry.value}
							wire={root.wire}
						/>
					</div>
				)}
			{settled && <Considered entry={entry} />}
			{findings.length > 0 && (
				<section aria-label="Findings" className="question-page-section">
					<h2>Findings</h2>
					<ul className="question-page-findings">
						{findings.map(finding => (
							<li key={finding.id}>
								<FindingDetail finding={finding} />
							</li>
						))}
					</ul>
				</section>
			)}
			{takes.length > 0 && (
				<section aria-label="Takes" className="question-page-section">
					<h2>Takes</h2>
					<ul className="question-page-takes">
						{takes.map(take => (
							<li key={take.id}>
								<Take id={entry.id} root={root} take={take} />
							</li>
						))}
					</ul>
				</section>
			)}
			<h2 className="question-page-notes">Notes</h2>
		</div>
	);
}

function FindingDetail({ finding }: { finding: Question.Finding }) {
	let label = (
		<span className="question-page-finding-head">
			<span aria-hidden="true" className="question-page-finding-icon">
				<FindingIcon finding={finding} />
			</span>
			<span className="question-page-finding-title">{findingLine(finding)}</span>
			{findingMeta(finding) && (
				<span className="question-page-finding-meta">{findingMeta(finding)}</span>
			)}
		</span>
	);
	let body = finding.summary || finding.sources?.length || finding.branch;
	if (finding.status !== "ready" || !body) {
		return <div className="question-page-finding-static">{label}</div>;
	}
	return (
		<UnfoldSection className="question-page-finding" defaultOpen label={label}>
			{finding.summary && <p className="question-page-finding-summary">{finding.summary}</p>}
			{finding.branch && (
				<p className="question-page-finding-branch">
					Branch <code>{finding.branch}</code>
				</p>
			)}
			{finding.sources && finding.sources.length > 0 && (
				<ul className="question-page-sources">
					{finding.sources.map(source => (
						<li key={source.url}>
							<a href={source.url} rel="noreferrer" target="_blank">{source.title}</a>
						</li>
					))}
				</ul>
			)}
		</UnfoldSection>
	);
}

type Stance = NonNullable<Question.Finding["stance"]>;

const STANCES = [
	{ value: "supports", label: "Supports", icon: CheckIcon },
	{ value: "objects", label: "Objects", icon: CloseIcon },
] as const;

function Take(
	{ id, root, take }: { id: string; root: QuestionPageRoot; take: Question.Finding },
) {
	let [text, setText] = useState("");
	let [stance, setStance] = useState<Stance>();
	let [busy, setBusy] = useState(false);
	let [error, setError] = useState<string>();
	let mine = take.ref.toLowerCase() === root.self?.toLowerCase();
	let reply = async () => {
		if (!root.wire || !text.trim()) return;
		setBusy(true);
		setError(undefined);
		try {
			let answered = await root.wire.ask<Question.Explore.Taken>("question:take", {
				id,
				finding: take.id,
				text,
				...(stance ? { stance } : {}),
			});
			if (!answered.ok) throw new Error(answered.message);
			setText("");
		} catch (failure) {
			setError(failure instanceof Error ? failure.message : "Couldn’t send your reply");
		} finally {
			setBusy(false);
		}
	};
	return (
		<div className="question-page-take">
			<Face decorative handle={take.ref} size={24} />
			<div className="question-page-take-body">
				<span className="question-page-take-head">
					<span className="question-page-take-name">{personName(take.ref)}</span>
					{take.stance && (
						<Badge
							className="question-page-stance"
							icon={take.stance === "supports" ? CheckIcon : CloseIcon}
							label={take.stance === "supports" ? "Supports" : "Objects"}
							size="sm"
							textSize="2xs"
							tone={take.stance === "supports" ? "success" : "danger"}
						/>
					)}
				</span>
				{take.status === "ready" && take.summary
					? <p className="question-page-take-text">{take.summary}</p>
					: mine && take.status === "running"
					? (
						<form
							className="question-page-take-form"
							onSubmit={event => {
								event.preventDefault();
								void reply();
							}}
						>
							<textarea
								aria-label="Your take"
								className="question-page-take-field"
								disabled={busy}
								maxLength={4000}
								onChange={event => setText(event.target.value)}
								rows={2}
								value={text}
							/>
							<div aria-label="Your position" className="question-page-stances" role="group">
								{STANCES.map(option => (
									<button
										aria-pressed={stance === option.value}
										className="btn btn-sm btn-outline"
										disabled={busy}
										key={option.value}
										onClick={() => setStance(stance === option.value ? undefined : option.value)}
										type="button"
									>
										<option.icon aria-hidden="true" />
										{option.label}
									</button>
								))}
							</div>
							<button
								className="btn btn-sm btn-primary"
								disabled={busy || !text.trim()}
								type="submit"
							>
								Reply
							</button>
							{error && <p className="question-page-take-error" role="alert">{error}</p>}
						</form>
					)
					: (
						<p className="question-page-take-text" data-waiting="">
							{take.status === "running" ? "Waiting" : findingLine(take)}
						</p>
					)}
			</div>
		</div>
	);
}
