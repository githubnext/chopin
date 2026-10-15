import { PauseIcon, SparkleIcon } from "@chopin/icons";
import { InlineNotice } from "@chopin/visuals/inline-notice";
import { UnfoldSection } from "@chopin/visuals/unfold";
import { useId, useRef, useState } from "react";

import { NavigationDialog } from "../navigation-dialog";
import { draftFrom, stopReasons, validDraft } from "./copy";
import { AgendaQuestions } from "./questions";
import { useAgenda } from "./use-agenda";

import type { Research } from "@chopin/protocol";
import type { NavigationDialogMotion } from "../navigation-dialog";
import type { Draft } from "./copy";

export function ResearchAgendaDialog(
	{ active, channelId, motion, onDismiss, onOpenChild }: {
		active: boolean;
		channelId: string;
		motion: NavigationDialogMotion;
		onDismiss: () => void;
		onOpenChild?: (child: Research.ReadyChild) => Promise<boolean>;
	},
) {
	let state = useAgenda(channelId, active);
	let [draft, setDraft] = useState<Draft>();
	let [navigationError, setNavigationError] = useState(false);
	let scopeInput = useRef<HTMLTextAreaElement>(null);
	let id = useId();
	let snapshot = state.snapshot;
	let agenda = snapshot?.agenda;
	let editing = !!draft || snapshot?.agenda === null;
	let fields = draft ?? draftFrom(agenda ?? null);
	let canEdit = !!snapshot?.canEdit;
	let allowed = !!snapshot?.available && canEdit;
	let conflict = state.error?.status === 409;
	let valid = validDraft(fields);

	async function save(activate = false, overwrite = false) {
		let input = {
			expectedRevision: overwrite ? agenda?.revision ?? 0 : fields.revision,
			scope: fields.scope.trim(),
			questions: fields.questions.map(({ key: _key, ...question }) => question),
		};
		let next = await state.mutate("save", input);
		if (!next) return;
		setDraft(undefined);
		if (activate && next.agenda) {
			await state.mutate("activate", { expectedRevision: next.agenda.revision });
		}
	}

	async function open(child: Research.ReadyChild) {
		setNavigationError(false);
		try {
			if (onOpenChild && await onOpenChild(child)) onDismiss();
			else setNavigationError(true);
		} catch {
			setNavigationError(true);
		}
	}

	async function pause() {
		if (!agenda) return;
		let next = await state.mutate("pause", { expectedGeneration: agenda.generation });
		if (next?.agenda) {
			let revision = next.agenda.revision;
			setDraft(current => current ? { ...current, revision } : undefined);
		}
	}

	return (
		<NavigationDialog
			className="research-agenda-dialog"
			initialFocus={scopeInput}
			motion={motion}
			onDismiss={onDismiss}
			title="Research agenda"
		>
			<div className="agenda-meta agenda-experimental">
				<SparkleIcon aria-hidden="true" />Experimental
			</div>
			<div className="agenda-body" aria-busy={state.busy || !snapshot}>
				{!snapshot && !state.error && <p className="agenda-meta" role="status">Loading agenda…</p>}
				{state.error && (
					<InlineNotice
						tone="danger"
						message={state.error.message}
						actions={conflict
							? (
								<>
									<button
										className="btn btn-sm btn-outline-danger"
										disabled={state.busy}
										onClick={() => {
											setDraft(undefined);
											state.reload();
										}}
										type="button"
									>
										Use latest
									</button>
									{draft && (
										<button
											className="btn btn-sm btn-outline-danger"
											disabled={!valid || state.busy}
											onClick={() => void save(false, true)}
											type="button"
										>
											Save my edits
										</button>
									)}
								</>
							)
							: (
								<button
									className="btn btn-sm btn-outline-danger"
									onClick={state.reload}
									type="button"
								>
									Try again
								</button>
							)}
					/>
				)}
				{snapshot && (
					<>
						<p className="agenda-bounds">
							Up to {snapshot.limits.maxInvestigations} investigations ·{" "}
							{snapshot.limits.durationMs / 3600000} hours
						</p>
						{!snapshot.available && (
							<p className="agenda-meta" role="status">
								{snapshot.unavailableReason
									|| "Bounded public research is unavailable for this document."}
							</p>
						)}
						{!canEdit && (
							<p className="agenda-meta">Only document writers can change or allow research.</p>
						)}
						{agenda && (
							<p className="agenda-meta" role="status">
								{agenda.state === "active"
									? `${agenda.investigations} of ${snapshot.limits.maxInvestigations} investigations started${
										agenda.expiresAt
											? ` · Allowed until ${
												new Date(agenda.expiresAt).toLocaleString([], {
													month: "short",
													day: "numeric",
													hour: "numeric",
													minute: "2-digit",
												})
											}`
											: ""
									}`
									: agenda.stopReason
									? stopReasons[agenda.stopReason]
									: "Paused"}
							</p>
						)}
						<fieldset className="agenda-content" disabled={state.busy}>
							{editing && canEdit
								? (
									<div className="agenda-fields">
										<label htmlFor={`${id}-scope`}>Public research scope</label>
										<textarea
											className="field agenda-field agenda-scope"
											id={`${id}-scope`}
											maxLength={2000}
											onChange={event => setDraft({ ...fields, scope: event.target.value })}
											placeholder="Explore how collaborative writing tools help people discover and use open decisions."
											ref={scopeInput}
											rows={3}
											value={fields.scope}
										/>
										<p className="agenda-meta">
											20–2,000 characters. Saving changes pauses running research.
										</p>
									</div>
								)
								: (
									<div className="agenda-saved-scope">
										<span className="agenda-meta">Public research scope</span>
										<p>{agenda?.scope || "No research scope has been allowed."}</p>
										{canEdit && (
											<button
												className="btn btn-sm btn-ghost"
												onClick={() => setDraft(draftFrom(agenda ?? null))}
												type="button"
											>
												Edit scope and questions
											</button>
										)}
									</div>
								)}
							<AgendaQuestions
								editable={editing && canEdit}
								maxQuestions={snapshot.limits.maxQuestions}
								onChange={questions => setDraft({ ...fields, questions })}
								onOpen={child => void open(child)}
								questions={fields.questions}
								saved={agenda?.questions ?? []}
							/>
							{fields.questions.length === 0 && (
								<p className="agenda-meta">
									{canEdit
										? "Chopin will choose useful questions within this scope after you allow research."
										: "No questions yet."}
								</p>
							)}
						</fieldset>
						<UnfoldSection label="What is allowed">
							<p>
								Your approved scope, questions and evidence needs are sent to the public research
								worker.
							</p>
							<p>Document text and repository files stay outside that worker.</p>
							<p>
								At least {snapshot.limits.minIntervalMs / 60000}{" "}
								minutes between investigations. You can pause at any time.
							</p>
							<p>
								Up to {snapshot.limits.maxSessions}{" "}
								AI sessions, including planning and retries. AI usage and costs vary by provider.
							</p>
							{agenda && <p>{agenda.reservedSessions} sessions reserved. Failed attempts count.</p>}
						</UnfoldSection>
						{canEdit && (
							<div className="agenda-actions">
								{agenda?.state === "active" && (
									<button
										className="btn btn-md btn-secondary"
										disabled={state.busy}
										onClick={() => void pause()}
										type="button"
									>
										<PauseIcon aria-hidden="true" />Pause research
									</button>
								)}
								{editing && (
									<button
										className="btn btn-md btn-outline"
										disabled={!valid || state.busy || conflict}
										onClick={() => void save()}
										type="button"
									>
										Save paused
									</button>
								)}
								{agenda?.state !== "active" && (
									<button
										className="btn btn-md btn-primary"
										disabled={!allowed || !valid || state.busy || conflict || (!!draft && !!agenda)}
										onClick={() =>
											agenda
												? void state.mutate("activate", { expectedRevision: agenda.revision })
												: void save(true)}
										type="button"
									>
										Allow public research
									</button>
								)}
								{draft && agenda && (
									<button
										className="btn btn-md btn-ghost"
										disabled={state.busy}
										onClick={() => setDraft(undefined)}
										type="button"
									>
										Cancel edits
									</button>
								)}
							</div>
						)}
					</>
				)}
				{navigationError && (
					<InlineNotice tone="danger" message="Could not open the report. Try its title again." />
				)}
			</div>
			<div className="agenda-footer">
				<button className="btn btn-sm btn-ghost" onClick={onDismiss} type="button">Done</button>
			</div>
		</NavigationDialog>
	);
}
