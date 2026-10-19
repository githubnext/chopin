/**
 * A decision opened as its own page.
 *
 * The page is an ordinary child document whose body is the decision's Notes. Everything above
 * the notes is the root's record, read through the root workspace that stays mounted behind the
 * child: its status, question, answer, control, findings and takes.
 */

import {
	Face,
	FindingIcon,
	findingLine,
	findingMeta,
	PresenceFaces,
	QuestionnaireCard,
	runningFindings,
	waitingOn,
} from "@chopin/editor";
import { UnfoldSection } from "@chopin/visuals/unfold";
import { createContext, useContext, useState } from "react";

import type { ExploreResources, QuestionnaireEntry, Transport } from "@chopin/editor";
import type { Question } from "@chopin/protocol";

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
		return { label: `Waiting for @${waiting.join(", @")}`, tone: "waiting" };
	}
	return { label: "Open", tone: "open" };
}

function withoutSelf(handles: readonly string[], self?: string): string[] {
	let seen = new Set<string>();
	return handles.filter(handle => {
		let key = handle.toLowerCase();
		if (key === self?.toLowerCase() || seen.has(key)) return false;
		seen.add(key);
		return true;
	});
}

function settledOn(at: number): string {
	return new Date(at * 1_000).toLocaleDateString(undefined, { day: "numeric", month: "short" });
}

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

/** A settled decision on its page: the answer once, who settled it, and the way to reopen it. */
function Settled(
	{ entry, meta, root }: {
		entry: QuestionnaireEntry;
		meta: Question.CardMeta;
		root: QuestionPageRoot;
	},
) {
	let question = entry.value.questions[0];
	let [busy, setBusy] = useState(false);
	let [error, setError] = useState<string>();
	let reopen = async () => {
		if (!root.wire || busy) return;
		setBusy(true);
		setError(undefined);
		try {
			let reply = await root.wire.ask<{ ok?: boolean }>("question:reopen", { id: entry.id });
			if (!reply.ok) throw new Error("Could not reopen it. Try again.");
		} catch (failure) {
			setError(failure instanceof Error ? failure.message : "Could not reopen it. Try again.");
		} finally {
			setBusy(false);
		}
	};
	let written = !!question && question.options.length === 0 || question?.response === "text";
	return (
		<>
			<div className="question-page-answer">
				<p className="question-page-answer-text">{answer(entry) ?? "Decided"}</p>
				<div className="question-page-answer-foot">
					{meta.owner && meta.decidedAt !== undefined && (
						<p className="question-page-answer-meta">
							Settled by @{meta.owner}, {settledOn(meta.decidedAt)}
						</p>
					)}
					{root.canEdit && root.connected && root.wire && (
						<button
							className="btn btn-sm btn-outline"
							disabled={busy}
							onClick={() => void reopen()}
							type="button"
						>
							Reopen
						</button>
					)}
				</div>
				{error && <p className="question-page-take-error" role="alert">{error}</p>}
			</div>
			{!written && question && (
				<>
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
										{option.description && (
											<span className="question-desc">{option.description}</span>
										)}
									</span>
								</div>
							);
						})}
					</div>
				</>
			)}
		</>
	);
}

export function QuestionPagePanel(
	{ entry, meta, root }: {
		entry: QuestionnaireEntry;
		meta: Question.CardMeta;
		root: QuestionPageRoot;
	},
) {
	let question = entry.value.questions[0];
	let settled = meta.status === "decided";
	let status = pageStatus(meta);
	let findings = (meta.findings ?? []).filter(finding => finding.kind !== "ask");
	let takes = (meta.findings ?? []).filter(finding => finding.kind === "ask");
	// The page is already open; its control offers no way back to itself.
	let explore = root.explore && { ...root.explore, openPage: undefined };
	return (
		<div className="question-page" data-question-page={entry.id}>
			<div className="question-page-top">
				<span className="question-page-status" data-tone={status.tone}>{status.label}</span>
				<PresenceFaces
					handles={withoutSelf(meta.involved, root.self)}
					label="In this decision"
				/>
			</div>
			<h1 className="question-page-title">{question?.prompt ?? "Decision"}</h1>
			{settled
				? <Settled entry={entry} meta={meta} root={root} />
				: (
					<div className="question-page-control">
						<QuestionnaireCard
							canEdit={root.canEdit}
							connected={root.connected}
							explore={explore}
							meta={meta}
							page
							presentation="list"
							self={root.self}
							value={entry.value}
							wire={root.wire}
						/>
					</div>
				)}
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
		<UnfoldSection className="question-page-finding" label={label}>
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

function Take(
	{ id, root, take }: { id: string; root: QuestionPageRoot; take: Question.Finding },
) {
	let [text, setText] = useState("");
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
				<span className="question-page-take-name">@{take.ref}</span>
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
