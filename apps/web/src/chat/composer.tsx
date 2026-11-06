/**
 * The Chat composer's markup: notice, field and footer.
 *
 * Presentational only. `Chat` owns the draft, pickers, key routing and the wire, and
 * passes what to show; the design audit renders the same component in each live state.
 */

import { useId } from "react";
import type { ReactNode, Ref } from "react";

import { ChopinMark, SendAction } from "@chopin/editor";
import { usePhone } from "@chopin/editor/pointer";
import { useTransitionPresence } from "@chopin/editor/transition-presence";
import { ArchiveIcon, CloseIcon, InfoIcon, LockIcon, PlusIcon, WarningIcon } from "@chopin/icons";
import { DraftInput } from "./draft-input";
import { motionContract } from "../motion-contract";
import { ModeSwitch } from "./mode-switch";
import type { DraftInputHandle, DraftInputProps } from "./draft-input";
import plannerStop from "../assets/icons/planner-stop.svg";
import plannerResume from "../assets/icons/planner-resume.svg";
import "./composer.css";

const MOTION = motionContract("collapse");

export type ComposerNotice = {
	/**
	 * An error is a failed send: it alerts, and marks the field and draft invalid. A warning is
	 * something to act on, such as a Planner that cannot start: it alerts once, in the warning roles.
	 */
	tone: "error" | "info" | "warning";
	text: string;
	/**
	 * More than the words say, one line each, exactly as supplied: drawn beneath them when
	 * `showDetail` is set, otherwise only for a screen reader.
	 */
	detail?: readonly string[];
	showDetail?: boolean;
	/** A link in the strip, in the accent, for where to go about it. */
	link?: { label: string; href: string };
	action?: { label: string; onClick: () => void; disabled?: boolean };
	/** Another live region announces what this strip says, so it is drawn with no live role. */
	silent?: boolean;
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
	run?: { action: "stop" | "resume"; disabled: boolean; onClick: () => void };
	/** Reference, command and mention pickers, open over the field. */
	pickers?: ReactNode;
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
		run,
		pickers,
		input,
	}: ChatComposerProps,
) {
	let instructionsId = useId();
	let cueId = useId();
	let error = notice?.tone === "error";
	let phone = usePhone();
	let chopin = !!mode?.chopin;
	// A failed send is shown at once; any other strip eases open and shut, so it does not jump
	// what is above it, and keeps its words while it fades.
	let strip = useTransitionPresence(
		notice && notice.tone !== "error" ? notice : undefined,
		MOTION.closeDuration,
		false,
	);
	let shown = error ? notice : strip.value;
	let warning = shown?.tone === "warning";
	let alerting = shown?.tone === "error" || warning;
	let closing = strip.phase === "closing";
	// Each line as supplied, on a line of its own, so nothing is joined to it or ended for it.
	let detail = shown?.detail?.map((line, index) => (
		<span className="composer-notice-line" key={index}>{line}</span>
	));
	let stripBody = shown && (
		<div
			className={shown.tone === "error" ? "composer-notice motion-feedback" : "composer-notice"}
			data-motion-feedback={shown.tone === "error" ? "alert" : undefined}
			role={shown.silent ? undefined : alerting ? "alert" : "status"}
			data-error={shown.tone === "error" || undefined}
			data-warning={warning || undefined}
			id={cueId}
		>
			{shown.tone === "error"
				? <WarningIcon className="icon-danger icon-first-line" size={16} />
				: warning
				? <WarningIcon className="composer-notice-icon icon-first-line" size={16} />
				: <InfoIcon className="icon-first-line" size={16} />}
			<span>
				{shown.text}
				{detail && (shown.showDetail ? detail : <span className="sr-only">{detail}</span>)}
				{shown.link && (
					<>
						{" "}
						<a
							className="composer-notice-link"
							href={shown.link.href}
							rel="noreferrer"
							target="_blank"
						>
							{shown.link.label}
						</a>
					</>
				)}
			</span>
			{shown.action && (shown.tone === "error"
				? (
					<button
						className="btn btn-sm btn-outline-danger"
						disabled={shown.action.disabled}
						onClick={shown.action.onClick}
					>
						{shown.action.label}
					</button>
				)
				: (
					<button
						className="btn btn-sm btn-ghost"
						onClick={shown.action.onClick}
						type="button"
					>
						{shown.action.label}
					</button>
				))}
		</div>
	);
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
			{!unavailable && stripBody && (error
				? stripBody
				: (
					<div
						aria-hidden={closing || undefined}
						className={`composer-notice-slot ${MOTION.className} ${strip.className}`}
						inert={closing}
					>
						<div className={MOTION.contentClassName}>{stripBody}</div>
					</div>
				))}
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
		</div>
	);
}
