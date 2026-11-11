/**
 * The Chat composer's markup: notice, field and footer.
 *
 * Presentational only. `Chat` owns the draft, pickers, key routing and the wire, and
 * passes what to show; the design audit renders the same component in each live state.
 */

import { lazy, Suspense, useId, useRef, useState } from "react";
import type { ReactNode, Ref } from "react";

import { useTransitionPresence } from "@chopin/editor/transition-presence";
import {
	ArchiveIcon,
	AtSignIcon,
	InfoIcon,
	LockIcon,
	PaperclipIcon,
	PlusIcon,
	SparkleIcon,
	TextStyleIcon,
	WarningIcon,
} from "@chopin/icons";
import { DraftInput } from "./draft-input";
import { FormatBar } from "./format-bar";
import { sendStop } from "./assistant-ui/send-stop";
import { SendStopButton } from "./assistant-ui/send-stop-button";
import { motionContract } from "../motion-contract";
import { currentShortcutPlatform, shortcutLabel } from "../shortcuts";
import { ChopinChip } from "./assistant-ui/chopin-chip";
import { draftPlaceholder } from "./chopin-chip";
import { ModelPill } from "./assistant-ui/model-pill";
import type { Format } from "./format-markdown";
import type { FileView } from "./attachments/files";
import type { ModelControl } from "./use-model-choice";
import type { DraftInputHandle, DraftInputProps } from "./draft-input";
import plannerResume from "../assets/icons/planner-resume.svg";
import "./composer.css";

const MOTION = motionContract("collapse");

/** The files of the message, drawn by code that loads when the first one is added. */
let FileStrip = lazy(() => import("./attachments/composer-files"));

/** What the composer needs to take, show and send files; absent where the server takes none. */
export type ComposerFiles = {
	files: readonly FileView[];
	/** The browser's own copy of a file, for its thumbnail. */
	source: (id: string) => File | undefined;
	/** Why images cannot be added, in words, when the model the message is for cannot read them. */
	imagesReason?: string;
	/** Adding and removing are off while a message is being sent. */
	disabled: boolean;
	/** The message is waiting for its files to finish uploading before it goes. */
	waiting: boolean;
	onAdd: (files: File[]) => void;
	onRemove: (id: string) => void;
	onRetry: (id: string) => void;
};

/** What a file picker offers when images cannot be read: text, which is what can be sent. */
const TEXT_ONLY =
	"text/*,.md,.markdown,.json,.csv,.log,.yaml,.yml,.toml,.xml,.html,.css,.js,.ts,.tsx,.py";

function dragsFiles(event: DragEvent | React.DragEvent): boolean {
	return [...(event.dataTransfer?.types ?? [])].includes("Files");
}

export type ComposerNotice = {
	/**
	 * An error is a failed send: it alerts, and marks the field and draft invalid. A warning is
	 * something to act on, such as a Planner that cannot start: it alerts once, in the warning roles.
	 */
	tone: "error" | "info" | "warning";
	text: string;
	/** More than the words say, one line each, exactly as supplied: drawn beneath them. */
	detail?: readonly string[];
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
	/**
	 * Present where Chopin can be asked: whether the chip at the start of the draft is on, and the
	 * ways to put it on (the sparkle button) and take it off (the chip's own cross).
	 */
	chopin?: { chip: boolean; disabled: boolean; onAdd: () => void; onRemove: () => void };
	/** Why the draft can't be sent, above the field. */
	notice?: ComposerNotice;
	/**
	 * The page's banners (a connection, a failure, a refused send), above the field. `id` lists the
	 * ids of every banner in `node`, which the draft is described by. A notice is drawn beneath them
	 * when it is given: the banner is a cause of its own and does not stand in for it. `invalid`
	 * marks the field and draft invalid, as a refused send does.
	 */
	banner?: { id: string; node: ReactNode; invalid?: boolean };
	/** Archived and read-only documents show why in place of the draft. */
	unavailable?: "archived" | "readonly";
	/** Present where the document's agent offers a choice of model: the trigger and its popover. */
	model?: ModelControl;
	/** Present when `#` references are on: the instructions and the Mention docs button. */
	references?: { disabled: boolean; onMentionDocs: () => void };
	/** The formatting toolbar above the draft, which `shown` says is on, and the Aa button that turns it off. */
	format?: {
		shown: boolean;
		disabled: boolean;
		onToggle: () => void;
		onFormat: (kind: Format) => void;
	};
	/** The `@` button, which starts a mention at the caret. */
	mention?: { disabled: boolean; onMention: () => void };
	/** Present where the server takes images and files with a message. */
	files?: ComposerFiles;
	/** Whether the draft accepts input at all, before a send is in flight. */
	draftable: boolean;
	sending: boolean;
	sendDisabled: boolean;
	onSubmit: () => void;
	/**
	 * What the Planner's run offers. Stop shares the round button with Send, which stops only while
	 * the draft is empty and `disabled` is false; Resume is a button of its own.
	 */
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
		chopin,
		model,
		notice,
		banner,
		unavailable,
		references,
		format,
		mention,
		files,
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
	let filePicker = useRef<HTMLInputElement>(null);
	let filesReasonId = useId();
	// Files dragged over the surface; entering a child fires before leaving the last, so it is counted.
	let [dragging, setDragging] = useState(0);
	let droppable = !!files && !files.disabled && !unavailable;
	let error = notice?.tone === "error" || !!banner?.invalid;
	let chip = !!chopin?.chip;
	let hasDraft = input.value.trim() !== "";
	let button = sendStop({
		running: run?.action === "stop",
		hasDraft,
		canSend: !sendDisabled,
		canStop: !!run && !run.disabled,
	});
	// A failed send is shown at once; any other strip eases open and shut, so it does not jump
	// what is above it, and keeps its words while it fades.
	let strip = useTransitionPresence(
		notice && notice.tone !== "error" ? notice : undefined,
		MOTION.closeDuration,
		false,
	);
	let shown = notice?.tone === "error" ? notice : strip.value;
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
				{detail}
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
			{!unavailable && banner?.node}
			{!unavailable && stripBody && (notice?.tone === "error"
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
			{/* The box: a rounded rectangle with a hairline, the formatting toolbar above the draft and a row of controls under it; the menus open over it. */}
			<div
				aria-busy={sending}
				className="composer-surface"
				data-error={error || undefined}
				data-dropping={dragging > 0 || undefined}
				onDragEnter={droppable
					? event => {
						if (!dragsFiles(event)) return;
						event.preventDefault();
						setDragging(count => count + 1);
					}
					: undefined}
				onDragOver={droppable
					? event => {
						if (!dragsFiles(event)) return;
						event.preventDefault();
						event.dataTransfer.dropEffect = "copy";
					}
					: undefined}
				onDragLeave={droppable
					? event => {
						if (dragsFiles(event)) setDragging(count => Math.max(0, count - 1));
					}
					: undefined}
				onDrop={droppable
					? event => {
						if (!dragsFiles(event)) return;
						event.preventDefault();
						setDragging(0);
						files!.onAdd([...event.dataTransfer.files]);
					}
					: undefined}
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
							{format?.shown && <FormatBar disabled={format.disabled} onFormat={format.onFormat} />}
							{files && files.files.length > 0 && (
								<Suspense fallback={null}>
									<FileStrip
										files={files.files}
										onRemove={files.onRemove}
										onRetry={files.onRetry}
										source={files.source}
									/>
								</Suspense>
							)}
							{files?.waiting && (
								<p className="composer-files-status" role="status">
									Sending once your files have uploaded
								</p>
							)}
							{/* The chip floats at the start of the field, so the first line begins after it and the rest run under it. */}
							<div className="composer-field">
								{chip && chopin && (
									<ChopinChip
										disabled={chopin.disabled || !draftable || sending}
										onRemove={chopin.onRemove}
									/>
								)}
								<DraftInput
									aria-activedescendant={input["aria-activedescendant"]}
									aria-controls={input["aria-controls"]}
									aria-expanded={input["aria-expanded"]}
									historyGroupKey={chip}
									mentions={input.mentions}
									onBlur={input.onBlur}
									onChange={input.onChange}
									onFiles={files && !files.disabled ? files.onAdd : undefined}
									onKeyDown={input.onKeyDown}
									onSelect={input.onSelect}
									references={input.references}
									resetKey={input.resetKey}
									value={input.value}
									aria-label="Message"
									aria-autocomplete="list"
									aria-describedby={[
										references ? instructionsId : undefined,
										banner?.id,
										notice ? cueId : undefined,
									].filter(Boolean).join(" ") || undefined}
									aria-disabled={!draftable || sending}
									aria-invalid={error || undefined}
									readOnly={!draftable || sending}
									role="combobox"
									onSubmit={onSubmit}
									placeholder={draftPlaceholder({ agent, chip })}
									ref={inputRef}
								/>
							</div>

							<div className="composer-row">
								<div className="composer-left">
									{files && (
										<>
											<input
												accept={files.imagesReason ? TEXT_ONLY : undefined}
												aria-hidden="true"
												data-chat-file-input=""
												hidden
												multiple
												onChange={event => {
													let chosen = [...event.currentTarget.files ?? []];
													// The same file may be chosen again after it was removed.
													event.currentTarget.value = "";
													if (chosen.length) files.onAdd(chosen);
												}}
												ref={filePicker}
												tabIndex={-1}
												type="file"
											/>
											<button
												type="button"
												className="btn btn-icon btn-ghost"
												aria-label="Add files"
												aria-describedby={files.imagesReason ? filesReasonId : undefined}
												title={files.imagesReason
													? `Add files. ${files.imagesReason}`
													: "Add files"}
												data-tooltip={files.imagesReason
													? `Add files. ${files.imagesReason}`
													: "Add files"}
												data-tooltip-verbatim=""
												disabled={files.disabled}
												onClick={() => filePicker.current?.click()}
											>
												<PaperclipIcon size={16} />
											</button>
											{files.imagesReason && (
												<span className="sr-only" id={filesReasonId}>{files.imagesReason}</span>
											)}
										</>
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
									{format && (
										<button
											type="button"
											className="btn btn-icon btn-ghost composer-format-toggle"
											aria-label="Formatting"
											aria-pressed={format.shown}
											title="Formatting"
											data-tooltip="Formatting"
											data-tooltip-verbatim=""
											onClick={format.onToggle}
										>
											<TextStyleIcon size={16} />
										</button>
									)}
									{mention && (
										<button
											type="button"
											className="btn btn-icon btn-ghost"
											aria-label="Mention someone"
											title="Mention someone"
											data-tooltip="Mention someone"
											data-tooltip-verbatim=""
											disabled={mention.disabled}
											onClick={mention.onMention}
										>
											<AtSignIcon size={16} />
										</button>
									)}
									{chopin && (
										<button
											type="button"
											className="btn btn-icon btn-ghost"
											aria-keyshortcuts="Control+J Meta+J"
											aria-label="Ask Chopin"
											title="Ask Chopin"
											data-tooltip="Ask Chopin"
											data-tooltip-shortcut={shortcutLabel("ask-chopin", currentShortcutPlatform())}
											data-tooltip-verbatim=""
											disabled={chopin.disabled || chip}
											onClick={chopin.onAdd}
										>
											<SparkleIcon size={16} />
										</button>
									)}
									{model && <ModelPill control={model} />}
								</div>
								<div className="composer-actions">
									{run?.action === "resume" && (
										<button
											aria-label="Resume Chopin"
											disabled={run.disabled}
											className="btn btn-icon btn-ghost"
											onClick={run.onClick}
											title="Resume Chopin"
											type="button"
										>
											<img alt="" className="size-4" src={plannerResume} />
										</button>
									)}
									<SendStopButton
										busy={sending}
										onClick={button.action === "stop" ? run!.onClick : onSubmit}
										state={button}
									/>
								</div>
							</div>
						</>
					)}
			</div>
		</div>
	);
}
