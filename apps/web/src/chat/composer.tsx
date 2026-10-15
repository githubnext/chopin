/**
 * The Chat composer's markup: notice, field, footer and Planner attachment.
 *
 * Presentational only. `Chat` owns the draft, pickers, key routing and the wire, and
 * passes what to show; the design audit renders the same component in each live state.
 */

import { useId } from "react";
import type { ReactNode, Ref } from "react";

import { ChopinMark, SendAction } from "@chopin/editor";
import { usePhone } from "@chopin/editor/pointer";
import { ArchiveIcon, CloseIcon, InfoIcon, LockIcon, PlusIcon, WarningIcon } from "@chopin/icons";
import { DraftInput } from "./draft-input";
import { ModeSwitch } from "./mode-switch";
import type { DraftInputHandle, DraftInputProps } from "./draft-input";
import plannerStop from "../assets/icons/planner-stop.svg";
import plannerResume from "../assets/icons/planner-resume.svg";
import "./composer.css";

export type ComposerNotice = {
	/** An error is a failed send: it alerts, and marks the field and draft invalid. */
	tone: "error" | "info";
	text: string;
	action?: { label: string; onClick: () => void; disabled?: boolean };
};

export type ChatComposerProps = {
	rootRef?: Ref<HTMLDivElement>;
	inputRef?: Ref<DraftInputHandle>;
	/** Whether this document's Planner is on; without it the composer is marked off. */
	agent: boolean;
	/** Whether the draft is addressed to Chopin, and the Chat/Chopin switch. */
	mode?: { chopin: boolean; disabled: boolean; onToggle: () => void };
	/** Why the draft can't be sent, above the field. */
	notice?: ComposerNotice;
	/** Archived and read-only documents show why in place of the draft. */
	unavailable?: "archived" | "readonly";
	/** Present when `#` references are on: the instructions and the Mention docs button. */
	references?: { disabled: boolean; onMentionDocs: () => void };
	/** Whether the draft accepts input at all, before a send is in flight. */
	draftable: boolean;
	sending: boolean;
	sendDisabled: boolean;
	onSubmit: () => void;
	connectionLabel?: string;
	/** Present when the composer, not the document header, offers Reconnect. */
	onReconnect?: () => void;
	run?: { action: "stop" | "resume"; disabled: boolean; onClick: () => void };
	/** Reference, command and mention pickers, open over the field. */
	pickers?: ReactNode;
	/** The remote Planner attachment line beneath the composer. */
	attachment?: ReactNode;
	input: Omit<
		DraftInputProps,
		| "role"
		| "aria-label"
		| "aria-autocomplete"
		| "aria-describedby"
		| "aria-disabled"
		| "aria-invalid"
		| "readOnly"
		| "placeholder"
		| "onSubmit"
		| "historyGroupKey"
	>;
};

export function ChatComposer(
	{
		rootRef,
		inputRef,
		agent,
		mode,
		notice,
		unavailable,
		references,
		draftable,
		sending,
		sendDisabled,
		onSubmit,
		connectionLabel,
		onReconnect,
		run,
		pickers,
		attachment,
		input,
	}: ChatComposerProps,
) {
	let instructionsId = useId();
	let cueId = useId();
	let connectionId = useId();
	let error = notice?.tone === "error";
	let phone = usePhone();
	let chopin = !!mode?.chopin;
	return (
		<div
			ref={rootRef}
			className="chat-composer relative shrink-0 px-2.5 pb-2.5"
			data-planner={agent ? undefined : "off"}
		>
			{references && (
				<p className="sr-only" id={instructionsId}>
					Type # to reference a document.
				</p>
			)}
			{!unavailable && notice && (
				<div
					className={error ? "composer-notice motion-feedback" : "composer-notice"}
					data-motion-feedback={error ? "alert" : undefined}
					role={error ? "alert" : "status"}
					data-error={error || undefined}
					id={cueId}
				>
					{error
						? <WarningIcon className="icon-danger icon-first-line" size={16} />
						: <InfoIcon className="icon-first-line" size={16} />}
					<span>{notice.text}</span>
					{notice.action && (error
						? (
							<button
								className="btn btn-sm btn-outline-danger"
								disabled={notice.action.disabled}
								onClick={notice.action.onClick}
							>
								{notice.action.label}
							</button>
						)
						: (
							<button
								className="btn btn-sm btn-ghost"
								onClick={notice.action.onClick}
								type="button"
							>
								{notice.action.label}
							</button>
						))}
				</div>
			)}
			<div
				aria-busy={sending}
				className="composer-surface field"
				data-mode={chopin ? "chopin" : "chat"}
				data-error={error || undefined}
			>
				{pickers}
				{unavailable
					? (
						<div className="composer-unavailable" role="status">
							{unavailable === "archived" ? <ArchiveIcon size={18} /> : <LockIcon size={18} />}
							<strong>
								{unavailable === "archived" ? "Document archived" : "Read-only access"}
							</strong>
							<p>
								{unavailable === "archived"
									? "Restore this document to send messages."
									: "You need write access to send messages."}
							</p>
						</div>
					)
					: (
						<>
							{/* A phone's switch shows only an icon; the chip says where the message goes. */}
							{phone && chopin && mode && (
								<span className="composer-chopin-row">
									<button
										aria-label="Remove Chopin"
										className="composer-chopin-chip"
										data-press="none"
										disabled={mode.disabled}
										onClick={mode.onToggle}
										type="button"
									>
										<ChopinMark />
										<span aria-hidden="true">Chopin</span>
										<CloseIcon aria-hidden="true" size={12} />
									</button>
								</span>
							)}
							<DraftInput
								aria-activedescendant={input["aria-activedescendant"]}
								aria-controls={input["aria-controls"]}
								aria-expanded={input["aria-expanded"]}
								historyGroupKey={chopin}
								mentions={input.mentions}
								onBlur={input.onBlur}
								onChange={input.onChange}
								onKeyDown={input.onKeyDown}
								onSelect={input.onSelect}
								references={input.references}
								resetKey={input.resetKey}
								value={input.value}
								aria-label="Message"
								aria-autocomplete="list"
								aria-describedby={[
									references ? instructionsId : undefined,
									notice ? cueId : undefined,
									connectionLabel ? connectionId : undefined,
								].filter(Boolean).join(" ") || undefined}
								aria-disabled={!draftable || sending}
								aria-invalid={error || undefined}
								readOnly={!draftable || sending}
								role="combobox"
								onSubmit={onSubmit}
								placeholder={chopin ? "Ask Chopin…" : "Message your collaborators…"}
								ref={inputRef}
							/>

							<div className="composer-footer">
								<div className="composer-left">
									{mode && (
										<ModeSwitch
											effectiveMode={chopin}
											disabled={mode.disabled}
											onToggle={mode.onToggle}
										/>
									)}
									{references && (
										<button
											type="button"
											className="btn btn-icon btn-ghost"
											aria-label="Mention docs"
											title="Mention docs"
											data-tooltip="Mention docs"
											data-tooltip-verbatim=""
											disabled={references.disabled}
											onClick={references.onMentionDocs}
										>
											<PlusIcon size={16} />
										</button>
									)}
								</div>
								<div className="composer-actions">
									{/* A row of its own on a phone; see composer.css. */}
									<span className="composer-connection-group">
										{/* Always mounted, so the live region hears its first word. */}
										<span className="composer-connection" id={connectionId} role="status">
											{connectionLabel && (
												<span
													className="composer-connection-label"
													data-offline={connectionLabel === "Offline" || undefined}
												>
													{connectionLabel}
												</span>
											)}
										</span>
										{/* Where the document header is out of view; see composer.css. */}
										{onReconnect && (
											<button
												className="composer-reconnect btn btn-sm btn-ghost"
												onClick={onReconnect}
												type="button"
											>
												Reconnect
											</button>
										)}
									</span>
									<span className="composer-run-control">
										{/* Two elements, so Stop and Resume never reuse one button. */}
										{run?.action === "stop" && (
											<button
												aria-label="Stop Chopin"
												disabled={run.disabled}
												className="btn btn-icon btn-secondary"
												onClick={run.onClick}
												title="Stop Chopin"
												type="button"
											>
												<img alt="" className="size-4" src={plannerStop} />
											</button>
										)}
										{run?.action === "resume" && (
											<button
												aria-label="Resume Chopin"
												disabled={run.disabled}
												className="btn btn-icon btn-secondary"
												onClick={run.onClick}
												title="Resume Chopin"
												type="button"
											>
												<img alt="" className="size-4" src={plannerResume} />
											</button>
										)}
									</span>
									<SendAction
										busy={sending}
										disabled={sendDisabled}
										onClick={onSubmit}
										label="Send message"
									/>
								</div>
							</div>
						</>
					)}
			</div>
			{attachment}
		</div>
	);
}
