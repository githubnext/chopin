import { useEffect, useId, useRef, useState } from "react";
import { DecisionIcon } from "@chopin/icons";

import { Provenance, SidecarCard } from "../card";
import { useVisualDecision } from "../use-visual-decision";

import type { ComponentType } from "react";
import type { VisualDecision } from "@chopin/protocol";
import type { Transport } from "@chopin/question/react";

export type VisualPreviewProps = {
	definition: VisualDecision.Definition;
	values: VisualDecision.Values;
};

export type VisualPreviewComponent = ComponentType<VisualPreviewProps>;

export function VisualDecisionCard(
	{ canEdit = false, connected = false, id, preview: Preview, wire }: {
		canEdit?: boolean;
		connected?: boolean;
		id: string;
		preview?: VisualPreviewComponent;
		wire?: Transport;
	},
) {
	let draft = useVisualDecision(id, wire, connected);
	let state = draft.state;
	let [peek, setPeek] = useState(false);
	let [padding, setPadding] = useState<4 | 6 | 8>();
	let [color, setColor] = useState<string>();
	let paddingId = useId();
	let colorId = useId();
	let colorHelpId = useId();
	let held = useRef<"pointer" | "keyboard" | undefined>(undefined);
	let saved = state?.saved;
	let editable = canEdit && connected && !!wire && !!state && !saved && !draft.syncing
		&& !draft.saving;
	let displayedColor = color ?? state?.values.selectedColor ?? "";
	let validColor = /^#[0-9a-fA-F]{6}$/.test(displayedColor);

	useEffect(() => {
		// Native inputs advance locally while acknowledgements catch up; the preview stays accepted.
		if (draft.pending > 0 && !state?.saved) return;
		setPadding(state?.values.optionPadding);
	}, [draft.pending, state?.values.optionPadding, state?.saved]);
	useEffect(() => {
		if (draft.pending > 0 && !state?.saved) return;
		if (color !== undefined && !/^#[0-9a-fA-F]{6}$/.test(color) && !state?.saved) return;
		setColor(state?.values.selectedColor);
	}, [color, draft.pending, state?.values.selectedColor, state?.saved]);
	useEffect(() => {
		let release = () => {
			held.current = undefined;
			setPeek(false);
		};
		let onVisibility = () => {
			if (document.visibilityState !== "visible") release();
		};
		window.addEventListener("blur", release);
		document.addEventListener("visibilitychange", onVisibility);
		return () => {
			window.removeEventListener("blur", release);
			document.removeEventListener("visibilitychange", onVisibility);
		};
	}, []);

	return (
		<SidecarCard
			className="visual-decision"
			data-plan-sidecar-questionnaire={id}
			data-visual-decision={id}
			label="Visual decision"
			padded={false}
		>
			<header className="visual-decision-header">
				<div className="visual-decision-title">
					<DecisionIcon aria-hidden="true" size={16} />
					<span>Decision card</span>
				</div>
				{saved
					? <span className="text-sm text-text-secondary">Saved</span>
					: (
						<button
							className="btn btn-sm btn-primary"
							disabled={!editable || draft.pending > 0 || !validColor}
							onClick={() => void draft.save()}
							type="button"
						>
							{draft.saving ? "Saving…" : "Save decision"}
						</button>
					)}
			</header>
			{state
				? (
					<>
						<div className="visual-decision-body">
							<section aria-label="Decision card preview" className="visual-decision-preview">
								<div className="visual-decision-preview-tools">
									<span aria-live="polite" className="text-xs text-text-tertiary">
										{peek ? "Current" : saved ? "Saved values" : "Adjusted"}
									</span>
									<button
										aria-pressed={peek}
										className="btn btn-sm btn-ghost visual-decision-peek"
										onBlur={() => {
											held.current = undefined;
											setPeek(false);
										}}
										onClick={event => {
											if (event.detail === 0) setPeek(current => !current);
										}}
										onKeyDown={event => {
											if (event.key !== " ") return;
											event.preventDefault();
											held.current = "keyboard";
											setPeek(true);
										}}
										onKeyUp={event => {
											if (event.key !== " ") return;
											event.preventDefault();
											held.current = undefined;
											setPeek(false);
										}}
										onLostPointerCapture={() => {
											if (held.current !== "pointer") return;
											held.current = undefined;
											setPeek(false);
										}}
										onPointerCancel={() => {
											held.current = undefined;
											setPeek(false);
										}}
										onPointerDown={event => {
											if (event.button !== 0) return;
											event.currentTarget.setPointerCapture(event.pointerId);
											held.current = "pointer";
											setPeek(true);
										}}
										onPointerUp={() => {
											held.current = undefined;
											setPeek(false);
										}}
										type="button"
									>
										Show current
									</button>
								</div>
								{Preview
									? (
										<Preview
											definition={state.definition}
											values={peek ? state.definition.baseline : state.values}
										/>
									)
									: <p className="text-sm text-text-secondary">Preview unavailable.</p>}
							</section>
							<aside aria-label="Decision card controls" className="visual-decision-inspector">
								<div className="visual-decision-control">
									<label htmlFor={paddingId}>Option vertical padding</label>
									<output htmlFor={paddingId}>{padding ?? state.values.optionPadding} px</output>
									<input
										aria-valuetext={`${padding ?? state.values.optionPadding} px`}
										disabled={!editable}
										id={paddingId}
										max={8}
										min={4}
										onChange={event => {
											let value = Number(event.target.value) as 4 | 6 | 8;
											setPadding(value);
											draft.change({ optionPadding: value });
										}}
										step={2}
										type="range"
										value={padding ?? state.values.optionPadding}
									/>
								</div>
								<div className="visual-decision-control">
									<label htmlFor={colorId}>Selected-option colour</label>
									<input
										aria-describedby={colorHelpId}
										aria-invalid={displayedColor !== "" && !validColor ? true : undefined}
										autoCapitalize="characters"
										autoComplete="off"
										className="visual-decision-color"
										disabled={!editable}
										id={colorId}
										maxLength={7}
										onChange={event => {
											let value = event.target.value;
											setColor(value);
											if (/^#[0-9a-fA-F]{6}$/.test(value)) draft.change({ selectedColor: value });
										}}
										pattern="#[0-9a-fA-F]{6}"
										spellCheck={false}
										type="text"
										value={displayedColor}
									/>
									<span className="visual-decision-control-help" id={colorHelpId}>
										{displayedColor !== "" && !validColor
											? "Enter six hex digits, starting with #."
											: "#RRGGBB"}
									</span>
								</div>
								{!saved && (
									<button
										className="btn btn-sm btn-ghost"
										disabled={!editable}
										onClick={() => {
											setPadding(state.definition.baseline.optionPadding);
											setColor(state.definition.baseline.selectedColor);
											draft.reset();
										}}
										type="button"
									>
										Reset
									</button>
								)}
								<span aria-live="polite" className="text-xs text-text-tertiary" role="status">
									{saved
										? "Values recorded"
										: !canEdit
										? "Read-only"
										: !connected
										? "Reconnecting…"
										: draft.pending > 0
										? "Syncing changes…"
										: "Shared draft"}
								</span>
							</aside>
						</div>
						{saved && (
							<footer className="visual-decision-footer">
								<Provenance at={saved.at} by={saved.by} verb="Saved" />
							</footer>
						)}
					</>
				)
				: (
					<p aria-live="polite" className="visual-decision-loading text-sm text-text-secondary">
						Loading shared draft…
					</p>
				)}
			{draft.error && (
				<div className="visual-decision-error" role="alert">
					<span>{draft.error}</span>
					{(draft.pending > 0 || draft.syncing) && !saved && (
						<button
							className="btn btn-sm btn-outline"
							disabled={!connected}
							onClick={draft.retry}
							type="button"
						>
							Try again
						</button>
					)}
				</div>
			)}
		</SidecarCard>
	);
}
