import { useId, useRef, useState } from "react";
import { SendAction } from "@chopin/editor";
import { InfoIcon, LoaderIcon, PlusIcon, WarningIcon } from "@chopin/icons";
import { MentionPicker } from "../chat/mention-picker";
import { referenceOptionId } from "../chat/reference-picker";
import { ReferenceMenu } from "./reference-menu";
import { filterMentions, mentionTrigger } from "../chat/mentions";
import {
	addressedOutsideReferences,
	chatSendPayload,
	insertReference,
	reconcileReferenceDrafts,
	referenceTrigger,
} from "../chat/references";
import { Transcript } from "../chat/transcript";
import type { Chat } from "@chopin/protocol";
import stopIcon from "../assets/icons/planner-stop.svg";
import resumeIcon from "../assets/icons/planner-resume.svg";
import type { ReferenceDraft, ReferenceTarget } from "../chat/references";
import type { ReferencePickerState } from "../chat/reference-picker";
import type { Scenario } from "./scenarios";
import { DraftInput } from "./draft-input";
import type { DraftInputHandle } from "./draft-input";
import { ModeSwitch } from "./mode-switch";

let documents: ReferenceTarget[] = [
	{ kind: "document", channelId: "exports", title: "Export formats", slug: "export-formats" },
	{ kind: "document", channelId: "access", title: "Access and permissions", slug: "access" },
];
let initialText = (state: Scenario) => {
	if (state === "mention") return "@";
	if (state === "reference" || state.startsWith("ref-")) return "Compare this with #";
	if (state === "reference-selected") return "Compare this with #Export formats";
	if (state === "multiline") {
		return "Could you revise the export section?\n\nInclude Markdown and PDF, and explain how comments are handled.\n\nKeep the first version small enough to review.";
	}
	if (["team", "chopin", "agent-off", "readonly", "archived", "connecting"].includes(state)) {
		return "";
	}
	return "Could you outline the export options?";
};

export function ComposerPreview(
	{ scenario, stayInMode = true, onSend }: {
		scenario: Scenario;
		stayInMode?: boolean;
		onSend?: (text: string, destination: string) => void;
	},
) {
	let [text, setText] = useState(initialText(scenario));
	let [mode, setMode] = useState(
		!["team", "draft", "agent-off", "readonly", "archived"].includes(scenario),
	);
	let [phase, setPhase] = useState<string>(scenario);
	let [queued, setQueued] = useState<Chat.Waiting[]>(
		scenario === "queued"
			? [{ id: "queued-example", handle: "maggieappleton", text: "Include PDF export too." }]
			: [],
	);
	let [refs, setRefs] = useState<ReferenceDraft[]>(
		scenario === "reference-selected"
			? [{ ...documents[0]!, token: "#Export formats", start: 18, end: 33 }]
			: [],
	);
	let [caret, setCaret] = useState(text.length);
	let [dismissed, setDismissed] = useState(false);
	let [active, setActive] = useState(0);
	let field = useRef<DraftInputHandle>(null);
	let focusFrame = useRef<number | undefined>(undefined);
	let id = useId();
	let mention = !dismissed ? mentionTrigger(text, caret) : undefined;
	let reference = !dismissed ? referenceTrigger(text, caret) : undefined;
	let options = mention
		? filterMentions([
			{ kind: "planner", login: "chopin" },
			{ kind: "person", login: "maggieappleton" },
			{ kind: "person", login: "matt" },
		], mention.query)
		: [];
	let targets = documents.filter(item =>
		item.title.toLowerCase().includes(reference?.query.toLowerCase() ?? "")
	);
	let readonly = ["readonly", "archived"].includes(phase);
	let unavailable = readonly || ["offline", "connecting"].includes(phase);
	let sending = phase === "sending";
	let agentOff = scenario === "agent-off";
	let effectiveMode = !agentOff && (mode || addressedOutsideReferences(text, refs));
	let pickerState: ReferencePickerState = phase === "ref-loading"
		? { status: "loading", options: [] }
		: phase === "ref-error"
		? { status: "error", options: [], error: new Error("Document search unavailable") }
		: phase === "ref-limit"
		? { status: "limit", options: [] }
		: {
			status: "ready",
			options: phase === "ref-empty" ? [] : targets,
			truncated: phase === "ref-truncated",
		};
	let count = mention ? options.length : pickerState.options.length;
	let pickerOpen = !unavailable && !sending && !!(mention || reference);
	let cue = phase === "error"
		? "Message not sent."
		: agentOff
		? "Chopin unavailable"
		: phase === "offline"
		? "Connection lost"
		: phase === "connecting"
		? "Synchronizing…"
		: sending
		? "Sending…"
		: phase === "paused"
		? "Chopin paused"
		: ["working", "queued"].includes(phase)
		? "Chopin working"
		: "";

	let focus = (at = caret) => {
		if (focusFrame.current !== undefined) cancelAnimationFrame(focusFrame.current);
		focusFrame.current = requestAnimationFrame(() => {
			focusFrame.current = undefined;
			field.current?.focus();
			field.current?.setSelectionRange(at, at);
		});
	};
	let toggle = () => {
		if (unavailable || sending || agentOff) return;
		if (focusFrame.current !== undefined) cancelAnimationFrame(focusFrame.current);
		if (effectiveMode) {
			let next = text.replace(/(^|[^\w@])@chopin\b/gi, (match, before, offset) => {
				let start = offset + before.length;
				return refs.some(ref => start >= ref.start && start < ref.end) ? match : before;
			});
			setRefs(reconcileReferenceDrafts(text, next, refs));
			setText(next);
			setMode(false);
		} else setMode(true);
		setDismissed(true);
		field.current?.focus();
	};
	let choose = (index: number) => {
		if (mention && options[index]) {
			let option = options[index]!;
			let next = text.slice(0, mention.start) + `@${option.login} ` + text.slice(mention.end);
			setRefs(reconcileReferenceDrafts(text, next, refs, mention));
			setText(next);
			if (option.kind === "planner") setMode(true);
			setCaret(mention.start + option.login.length + 2);
			focus(mention.start + option.login.length + 2);
		} else if (reference && pickerState.options[index]) {
			let next = insertReference(text, refs, reference, pickerState.options[index]!);
			setText(next.text);
			setRefs(next.references);
			setCaret(next.caret);
			focus(next.caret);
		}
		setDismissed(true);
	};
	let submit = () => {
		if (!text.trim() || unavailable || sending || pickerOpen) return;
		let prefix = effectiveMode && !addressedOutsideReferences(text, refs) ? "@chopin " : "";
		let payload = chatSendPayload(
			prefix + text,
			refs.map(ref => ({
				...ref,
				start: ref.start + prefix.length,
				end: ref.end + prefix.length,
			})),
			!agentOff,
			crypto.randomUUID(),
		);
		if (!payload) return;
		setPhase("sending");
		window.setTimeout(() => {
			if (["working", "queued"].includes(phase) && effectiveMode) {
				setQueued(current => [...current, {
					id: crypto.randomUUID(),
					handle: "maggieappleton",
					text: payload.text,
				}]);
			} else onSend?.(payload.text, payload.to);
			setText("");
			setRefs([]);
			if (!stayInMode) setMode(false);
			setPhase(
				["working", "queued"].includes(phase)
					? effectiveMode ? "queued" : phase
					: effectiveMode
					? "working"
					: "idle",
			);
			focus(0);
		}, 650);
	};

	return (
		<div className="composer-preview" data-picker={pickerOpen || undefined}>
			{queued.length > 0 && (
				<div className="composer-queue-chat" aria-label="Queued messages">
					<Transcript
						active={false}
						canEdit
						entries={[]}
						handle="maggieappleton"
						queued={queued}
						onWithdraw={key => {
							setQueued(current => current.filter(message => message.id !== key));
						}}
					/>
				</div>
			)}
			{(phase === "error" || agentOff || ["offline", "connecting"].includes(phase)) && (
				<div
					className="composer-notice"
					data-error={phase === "error" || undefined}
					role={phase === "error" ? "alert" : "status"}
					id={`${id}-cue`}
				>
					{phase === "connecting"
						? <LoaderIcon className="chat-tool-loader" size={14} />
						: phase === "offline" || phase === "error"
						? (
							<WarningIcon
								aria-hidden="true"
								className={phase === "error" ? "text-danger-icon" : undefined}
								size={14}
							/>
						)
						: <InfoIcon aria-hidden="true" size={14} />}
					<span>{cue}</span>
					{phase === "error" && (
						<button className="btn btn-sm btn-outline-danger" onClick={submit}>Retry</button>
					)}
					{["offline", "connecting"].includes(phase) && (
						<button
							className="btn btn-sm btn-ghost"
							onClick={() => setPhase("idle")}
						>
							{phase === "offline" ? "Reconnect" : "Retry"}
						</button>
					)}
				</div>
			)}
			<div
				className="composer-surface field"
				data-mode={effectiveMode ? "chopin" : "team"}
				data-focus={scenario === "focus" || undefined}
				data-hover={scenario === "hover" || undefined}
				data-error={phase === "error" || undefined}
				aria-busy={sending}
			>
				{pickerOpen && mention && options.length > 0 && (
					<MentionPicker
						active={active % options.length}
						id={`${id}-picker`}
						options={options}
						onActive={setActive}
						onSelect={option => choose(options.indexOf(option))}
					/>
				)}
				{pickerOpen && reference && (
					<ReferenceMenu
						active={active % Math.max(1, count)}
						id={`${id}-picker`}
						state={pickerState}
						onActive={setActive}
						onSelect={option => choose(pickerState.options.indexOf(option))}
					/>
				)}
				{readonly
					? (
						<div className="composer-unavailable" role="status">
							<strong>{phase === "archived" ? "Document archived" : "Read-only access"}</strong>
							<p>
								{phase === "archived"
									? "Restore this document to send messages."
									: "You need write access to send messages."}
							</p>
						</div>
					)
					: (
						<>
							<div className="composer-draft">
								<DraftInput
									ref={field}
									references={refs}
									onBlur={() => {
										if (focusFrame.current !== undefined) cancelAnimationFrame(focusFrame.current);
									}}
									aria-label="Message"
									value={text}
									readOnly={unavailable || sending}
									aria-disabled={unavailable || sending}
									aria-invalid={phase === "error" || undefined}
									aria-describedby={cue ? `${id}-cue` : undefined}
									aria-autocomplete="list"
									role="combobox"
									aria-expanded={pickerOpen}
									aria-controls={pickerOpen ? `${id}-picker` : undefined}
									aria-activedescendant={pickerOpen && count
										? referenceOptionId(`${id}-picker`, active % count)
										: undefined}
									placeholder={readonly
										? "Conversation unavailable"
										: effectiveMode
										? "Ask Chopin…"
										: "Message your collaborators…"}
									onSelect={event => setCaret(event.currentTarget.selectionStart)}
									onChange={event => {
										let next = event.currentTarget.value;
										setRefs(
											event.currentTarget.references ?? reconcileReferenceDrafts(text, next, refs),
										);
										setText(next);
										setCaret(event.currentTarget.selectionStart);
										setDismissed(false);
										setActive(0);
										if (phase === "error" || phase.startsWith("ref-")) setPhase("idle");
									}}
									onKeyDown={event => {
										if (event.nativeEvent.isComposing || event.keyCode === 229) return;
										if (event.key === "Tab" && focusFrame.current !== undefined) {
											cancelAnimationFrame(focusFrame.current);
										}
										if (
											event.key === "Tab" && event.shiftKey && !event.metaKey && !event.ctrlKey
											&& !event.altKey && !unavailable && !sending && !agentOff
										) {
											event.preventDefault();
											if (!event.repeat) toggle();
											return;
										}
										if (pickerOpen) {
											if (event.key === "Escape") {
												event.preventDefault();
												setDismissed(true);
												return;
											}
											if (count && ["ArrowDown", "ArrowUp"].includes(event.key)) {
												event.preventDefault();
												setActive((active + (event.key === "ArrowDown" ? 1 : -1) + count) % count);
												return;
											}
											if (event.key === "Enter" && !event.shiftKey) {
												event.preventDefault();
												if (count) choose(active % count);
												return;
											}
										}
										if (event.key === "Escape" && effectiveMode) {
											event.preventDefault();
											toggle();
											return;
										}
										if (event.key === "Enter" && !event.shiftKey) {
											event.preventDefault();
											submit();
										}
									}}
								/>
							</div>
							<div className="composer-footer">
								<ModeSwitch
									effectiveMode={effectiveMode}
									disabled={unavailable || sending || agentOff}
									onToggle={toggle}
								/>
								<div className="composer-actions">
									<button
										type="button"
										className="btn btn-icon btn-ghost"
										aria-label="Mention docs"
										data-tooltip="Mention docs"
										data-tooltip-verbatim=""
										disabled={unavailable || sending}
										title="Mention docs"
										onClick={() => {
											let next = text + (text && !text.endsWith(" ") ? " #" : "#");
											setText(next);
											setCaret(next.length);
											setDismissed(false);
											focus(next.length);
										}}
									>
										<PlusIcon size={14} />
									</button>
									{["working", "queued", "paused"].includes(phase) && (
										<button
											type="button"
											className="btn btn-icon btn-secondary"
											aria-label={phase === "paused" ? "Resume Chopin" : "Stop Chopin"}
											data-tooltip={phase === "paused" ? "Resume Chopin" : "Stop Chopin"}
											onClick={() => setPhase(phase === "paused" ? "working" : "paused")}
										>
											<img
												alt=""
												width="14"
												height="14"
												src={phase === "paused" ? resumeIcon : stopIcon}
											/>
										</button>
									)}
									{sending
										? (
											<button
												className="btn btn-icon btn-primary rounded-full"
												disabled
												aria-label="Sending message"
											>
												<LoaderIcon size={14} />
											</button>
										)
										: (
											<SendAction
												label={phase === "error"
													? "Retry message"
													: effectiveMode
													? "Send to Chopin"
													: "Send to collaborators"}
												disabled={unavailable || !text.trim()}
												onClick={submit}
											/>
										)}
								</div>
							</div>
						</>
					)}
			</div>
			{cue && phase !== "error" && !agentOff && !["offline", "connecting"].includes(phase) && (
				<span className="sr-only" id={`${id}-cue`} role="status">{cue}</span>
			)}
		</div>
	);
}
