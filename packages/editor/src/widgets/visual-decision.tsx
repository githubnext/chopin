import { useCallback, useEffect, useId, useRef, useState } from "react";
import { DecisionIcon } from "@chopin/icons";

import { Provenance, SidecarCard } from "../card";
import { useVisualDecision } from "../use-visual-decision";

import type { ComponentType } from "react";
import type { VisualDecision } from "@chopin/protocol";
import type { Transport } from "@chopin/question/react";

type PreviewStatus = "loading" | "ready" | "unavailable" | "error";
type Control = VisualDecision.Definition["controls"][number];

export type VisualPreviewProps = {
	decisionId: string;
	definition: VisualDecision.Definition;
	values: VisualDecision.Values;
	onStatus: (status: PreviewStatus) => void;
};

export type VisualPreviewComponent = ComponentType<VisualPreviewProps>;

const COLOR = /^#[0-9a-fA-F]{6}$/;

function ControlInput(
	{ control, disabled, value, onChange }: {
		control: Control;
		disabled: boolean;
		value: number | string;
		onChange: (value: number | string) => void;
	},
) {
	let id = useId();
	let helpId = useId();
	if (control.type === "number") {
		let number = typeof value === "number" ? value : control.min;
		let display = `${number}${control.unit ? ` ${control.unit}` : ""}`;
		return (
			<div className="visual-decision-control">
				<label htmlFor={id}>{control.label}</label>
				<output htmlFor={id}>{display}</output>
				<input
					aria-valuetext={display}
					disabled={disabled}
					id={id}
					max={control.max}
					min={control.min}
					onChange={event => onChange(Number(event.target.value))}
					step={control.step}
					type="range"
					value={number}
				/>
			</div>
		);
	}
	let color = typeof value === "string" ? value : "";
	let invalid = color !== "" && !COLOR.test(color);
	return (
		<div className="visual-decision-control">
			<label htmlFor={id}>{control.label}</label>
			<input
				aria-describedby={helpId}
				aria-invalid={invalid || undefined}
				autoCapitalize="characters"
				autoComplete="off"
				className="visual-decision-color"
				disabled={disabled}
				id={id}
				maxLength={7}
				onChange={event => onChange(event.target.value)}
				pattern="#[0-9a-fA-F]{6}"
				spellCheck={false}
				type="text"
				value={color}
			/>
			<span className="visual-decision-control-help" id={helpId}>
				{invalid ? "Enter six hex digits, starting with #." : "#RRGGBB"}
			</span>
		</div>
	);
}

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
	let saved = state?.saved;
	let [peek, setPeek] = useState(false);
	let [local, setLocal] = useState<VisualDecision.Values>({});
	let [previewStatus, setPreviewStatus] = useState<{ key: string; status: PreviewStatus }>();
	let [readyArtifact, setReadyArtifact] = useState<string>();
	let held = useRef<"pointer" | "keyboard" | undefined>(undefined);
	let artifactKey = state
		? `${state.definition.definitionRevision}:${state.definition.artifact.digest}`
		: "";
	let renderKey = `${artifactKey}:${state?.revision ?? -1}:${peek ? "baseline" : "draft"}`;
	let onStatus = useCallback((status: PreviewStatus) => {
		setPreviewStatus(current =>
			current?.key === renderKey && current.status === status ? current : { key: renderKey, status }
		);
		if (status === "ready") setReadyArtifact(artifactKey);
		if (status === "error" || status === "unavailable") setReadyArtifact(undefined);
	}, [artifactKey, renderKey]);
	let currentStatus = previewStatus?.key === renderKey ? previewStatus.status : "loading";
	let rendered = currentStatus === "ready";
	let previewUsable = !!Preview && readyArtifact === artifactKey && currentStatus === "ready";
	let editable = canEdit && connected && !!wire && !!state && !saved && !draft.syncing
		&& !draft.saving && previewUsable;
	let invalidColor =
		state?.definition.controls.some(control =>
			control.type === "color" && !COLOR.test(String(local[control.id] ?? state.values[control.id]))
		) ?? false;

	useEffect(() => {
		if (!state || draft.pending > 0 && !saved) return;
		setLocal(current => {
			let next: VisualDecision.Values = {};
			for (let control of state.definition.controls) {
				let pending = current[control.id];
				next[control.id] = !saved && control.type === "color"
						&& typeof pending === "string" && !COLOR.test(pending)
					? pending
					: state.values[control.id];
			}
			return state.definition.controls.every(control => next[control.id] === current[control.id])
				? current
				: next;
		});
	}, [draft.pending, saved, state]);

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

	let change = (control: Control, value: number | string) => {
		setLocal(current => ({ ...current, [control.id]: value }));
		if (control.type === "color" && (typeof value !== "string" || !COLOR.test(value))) return;
		draft.change({ [control.id]: value });
	};

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
					<span>{state?.definition.title ?? "Visual decision"}</span>
				</div>
				{saved
					? <span className="text-sm text-text-secondary">Saved</span>
					: (
						<button
							className="btn btn-sm btn-primary"
							disabled={!editable || !rendered || peek || draft.pending > 0 || invalidColor}
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
							<section aria-label="Visual decision preview" className="visual-decision-preview">
								<div className="visual-decision-preview-tools">
									<span aria-live="polite" className="text-xs text-text-tertiary">
										{peek ? "Baseline" : saved ? "Saved values" : "Adjusted"}
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
										Show baseline
									</button>
								</div>
								{Preview
									? (
										<Preview
											decisionId={id}
											definition={state.definition}
											onStatus={onStatus}
											values={peek ? state.definition.baseline : state.values}
										/>
									)
									: <p className="text-sm text-text-secondary">Preview unavailable.</p>}
							</section>
							<aside aria-label="Visual decision controls" className="visual-decision-inspector">
								{state.definition.controls.map(control => (
									<ControlInput
										control={control}
										disabled={!editable}
										key={control.id}
										onChange={value => change(control, value)}
										value={local[control.id] ?? state.values[control.id]}
									/>
								))}
								{!saved && (
									<button
										className="btn btn-sm btn-ghost"
										disabled={!editable}
										onClick={() => {
											setLocal(state.definition.baseline);
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
										: currentStatus === "error" || currentStatus === "unavailable" || !Preview
										? "Preview unavailable"
										: draft.pending > 0
										? "Syncing changes…"
										: previewUsable
										? "Shared draft"
										: "Loading preview…"}
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
