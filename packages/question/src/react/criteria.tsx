/**
 * The criteria matrix of a choice decision.
 *
 * Options are rows and criteria are columns; each cell is marked yes, partly or no. Transport-free
 * like the rest of the view: marks arrive as props and a change leaves through a callback. Below
 * 30rem the columns give way to chips under each option.
 */

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { CheckIcon, CloseIcon, PendingIcon, PlusIcon, ProgressHalfIcon } from "@chopin/icons";
import { Badge } from "@chopin/visuals";

import { markKey } from "../draft";
import { MAX_CRITERIA, MAX_CRITERION_LABEL } from "../limits";
import { plainInlineText } from "./inline-segments";
import { Key } from "./option-key";

import type { ComponentType, KeyboardEvent, ReactNode } from "react";
import type { IconProps } from "@chopin/icons";
import type { Criterion, Mark, Option } from "../index";
import type { AddCriterionResult } from "./question-view";

export const MARKS: readonly Mark[] = ["yes", "partly", "no"];

const WORD: Record<Mark, string> = { yes: "Yes", partly: "Partly", no: "No" };
const TONE = { yes: "success", partly: "warning", no: "danger" } as const;

/** Where the columns give way to chips, in rem. */
const CHIPS_BELOW = 30;

/** "Stored with the account, New device: partly": what a cell's control is called. */
export function markName(option: string, criterion: string, mark?: Mark | null): string {
	return `${option}, ${criterion}: ${mark ? WORD[mark].toLowerCase() : "not set"}`;
}

function MarkIcon({ mark, size }: { mark: Mark; size: 12 | 14 | 16 }) {
	if (mark === "yes") return <CheckIcon aria-hidden="true" size={size} />;
	if (mark === "no") return <CloseIcon aria-hidden="true" size={size} />;
	return <ProgressHalfIcon aria-hidden="true" size={size} />;
}

/** A tinted disc: the mark as a shape, so colour is never the only signal. Empty is a ring. */
export function MarkGlyph({ mark }: { mark?: Mark | null }) {
	return (
		<span aria-hidden="true" className="crit-glyph" data-mark={mark ?? "none"}>
			{mark && <MarkIcon mark={mark} size={12} />}
		</span>
	);
}

/** A mark that cannot be changed, named for assistive technology. */
export function ReadOnlyMark({ label, mark }: { label: string; mark?: Mark | null }) {
	return (
		<span aria-label={`${label}: ${mark ? WORD[mark].toLowerCase() : "not set"}`} role="img">
			<MarkGlyph mark={mark} />
		</span>
	);
}

function chipIcon(mark?: Mark | null): ComponentType<IconProps> {
	if (mark === "yes") return CheckIcon;
	if (mark === "no") return CloseIcon;
	if (mark === "partly") return ProgressHalfIcon;
	return PendingIcon;
}

type CellProps = {
	/** "Option, Criterion": the control's name before its value. */
	name: string;
	mark?: Mark | null;
	onMark: (mark: Mark | null) => void;
	/** The criterion's label, when the cell is a chip that carries it. */
	chip?: string;
};

/**
 * One mark that can be set. At rest it is the mark's glyph; a tap or click opens it in place to the
 * three glyphs, and choosing one closes it. Arrows move between them, Enter or Space chooses,
 * Backspace or Delete clears and Escape closes.
 */
function MarkCell({ chip, mark, name, onMark }: CellProps) {
	let [open, setOpen] = useState(false);
	let trigger = useRef<HTMLButtonElement>(null);
	let group = useRef<HTMLSpanElement>(null);
	let refocus = useRef(false);

	useEffect(() => {
		if (open) {
			let radios = [...group.current?.querySelectorAll<HTMLButtonElement>("button") ?? []];
			(radios.find(radio => radio.getAttribute("aria-checked") === "true") ?? radios[0])
				?.focus({ preventScroll: true });
		} else if (refocus.current) {
			refocus.current = false;
			trigger.current?.focus({ preventScroll: true });
		}
	}, [open]);

	useEffect(() => {
		if (!open) return;
		let away = (event: PointerEvent) => {
			if (!group.current?.contains(event.target as Node)) setOpen(false);
		};
		document.addEventListener("pointerdown", away);
		return () => document.removeEventListener("pointerdown", away);
	}, [open]);

	let close = (back: boolean) => {
		refocus.current = back;
		setOpen(false);
	};
	let choose = (value: Mark | null) => {
		onMark(value);
		close(true);
	};
	let keys = (event: KeyboardEvent<HTMLSpanElement>) => {
		let radios = [...group.current!.querySelectorAll<HTMLButtonElement>("button")];
		let at = radios.indexOf(document.activeElement as HTMLButtonElement);
		if (event.key === "ArrowRight" || event.key === "ArrowDown") {
			radios[(at + 1) % radios.length]?.focus();
		} else if (event.key === "ArrowLeft" || event.key === "ArrowUp") {
			radios[(at - 1 + radios.length) % radios.length]?.focus();
		} else if (event.key === "Backspace" || event.key === "Delete") {
			choose(null);
		} else if (event.key === "Escape") {
			close(true);
		} else return;
		event.preventDefault();
		event.stopPropagation();
	};

	if (!open) {
		return (
			<button
				aria-expanded={false}
				aria-label={`${name}: ${mark ? WORD[mark].toLowerCase() : "not set"}`}
				className="crit-cell"
				data-chip={chip === undefined ? undefined : ""}
				onClick={() => setOpen(true)}
				onKeyDown={event => {
					if (mark && (event.key === "Backspace" || event.key === "Delete")) {
						event.preventDefault();
						onMark(null);
					}
				}}
				ref={trigger}
				type="button"
			>
				{chip === undefined
					? <MarkGlyph mark={mark} />
					: (
						<Badge
							icon={chipIcon(mark)}
							label={chip}
							size="sm"
							tone={mark ? TONE[mark] : "neutral"}
						/>
					)}
			</button>
		);
	}

	let focusable = mark ? MARKS.indexOf(mark) : 0;
	return (
		<span
			aria-label={name}
			className="crit-seg"
			data-chip={chip === undefined ? undefined : ""}
			onBlur={event => {
				if (!group.current?.contains(event.relatedTarget as Node | null)) setOpen(false);
			}}
			onKeyDown={keys}
			ref={group}
			role="radiogroup"
		>
			{chip !== undefined && <span className="crit-seg-label">{chip}</span>}
			{MARKS.map((value, index) => (
				<button
					aria-checked={mark === value}
					aria-label={WORD[value]}
					className="crit-seg-btn"
					data-mark={value}
					key={value}
					onClick={() => choose(mark === value ? null : value)}
					role="radio"
					tabIndex={index === focusable ? 0 : -1}
					type="button"
				>
					<MarkGlyph mark={value} />
				</button>
			))}
		</span>
	);
}

/* Adding a criterion --------------------------------------------------------------------------- */

function useAdd(
	{ criteria, onAdd }: {
		criteria: readonly Criterion[];
		onAdd: (label: string) => Promise<AddCriterionResult>;
	},
) {
	let [text, setText] = useState<string | null>(null);
	let [pending, setPending] = useState(false);
	let [failure, setFailure] = useState<string>();
	let label = text?.trim() ?? "";
	let duplicate = label
		? criteria.find(criterion => criterion.label.trim().toLowerCase() === label.toLowerCase())
		: undefined;
	let ready = !!label && !duplicate;
	let hint = duplicate ? `Already a criterion: ${duplicate.label}` : failure ?? "";
	return {
		text,
		pending,
		duplicate,
		ready,
		hint,
		open: () => {
			setFailure(undefined);
			setText("");
		},
		cancel: () => {
			setFailure(undefined);
			setText(null);
		},
		change: (value: string) => {
			setFailure(undefined);
			setText(value.replace(/\s*[\r\n]+\s*/g, " "));
		},
		async commit(): Promise<boolean> {
			if (!ready || pending) return false;
			setPending(true);
			setFailure(undefined);
			let result: AddCriterionResult;
			try {
				result = await onAdd(label);
			} catch {
				result = { ok: false, message: "Could not add this criterion." };
			}
			setPending(false);
			if (result.ok) setText(null);
			else setFailure(result.message);
			return result.ok;
		},
	};
}

type Add = ReturnType<typeof useAdd>;

function onFieldKeys(add: Add, event: KeyboardEvent<HTMLElement>, done: () => void) {
	if (event.key === "Escape") {
		event.preventDefault();
		event.stopPropagation();
		add.cancel();
		done();
	} else if (event.key === "Enter" && !event.nativeEvent.isComposing) {
		event.preventDefault();
		void add.commit().then(ok => ok && done());
	}
}

/** The header cell a new column is typed into: Enter adds it and Escape cancels. */
function AddField({ add, done }: { add: Add; done: () => void }) {
	let input = useRef<HTMLInputElement>(null);
	useEffect(() => input.current?.focus({ preventScroll: true }), []);
	return (
		<span className="crit-add-field">
			<button
				aria-label="Add criterion"
				className="question-add-confirm"
				data-ready={add.ready ? "" : undefined}
				disabled={!add.ready || add.pending}
				onClick={() => void add.commit().then(ok => ok && done())}
				type="button"
			>
				<PlusIcon aria-hidden="true" />
				<CheckIcon aria-hidden="true" />
			</button>
			<input
				aria-invalid={add.duplicate ? true : undefined}
				aria-label="New criterion"
				autoComplete="off"
				className="question-field crit-input"
				maxLength={MAX_CRITERION_LABEL}
				onBlur={event => {
					if (
						event.relatedTarget && event.currentTarget.parentElement?.contains(event.relatedTarget)
					) {
						return;
					}
					if (!add.text?.trim() && !add.pending) add.cancel();
				}}
				onChange={event => add.change(event.currentTarget.value)}
				onKeyDown={event => onFieldKeys(add, event, done)}
				placeholder="Criterion"
				readOnly={add.pending}
				ref={input}
				value={add.text ?? ""}
			/>
		</span>
	);
}

/** Chips have no header to hold a "+", so a row in the option style appends the criterion. */
function AddRow({ add }: { add: Add }) {
	let input = useRef<HTMLTextAreaElement>(null);
	let trigger = useRef<HTMLButtonElement>(null);
	let focus = useRef<"field" | "trigger">(undefined);
	useEffect(() => {
		let target = focus.current;
		focus.current = undefined;
		if (target === "field") input.current?.focus({ preventScroll: true });
		else if (target === "trigger") trigger.current?.focus({ preventScroll: true });
	});
	if (add.text === null) {
		return (
			<button
				className="question-choice-row question-option question-add"
				data-press="wide"
				onClick={() => {
					focus.current = "field";
					add.open();
				}}
				ref={trigger}
				type="button"
			>
				<Key>
					<PlusIcon />
				</Key>
				<span className="question-text">Add a criterion</span>
			</button>
		);
	}
	return (
		<div className="question-adding-group">
			<div
				aria-busy={add.pending || undefined}
				className="question-choice-row question-option question-adding"
			>
				<span className="question-key">
					<button
						aria-label="Add criterion"
						className="question-add-confirm"
						data-ready={add.ready ? "" : undefined}
						disabled={!add.ready || add.pending}
						onClick={() => void add.commit()}
						type="button"
					>
						<PlusIcon aria-hidden="true" />
						<CheckIcon aria-hidden="true" />
					</button>
				</span>
				<textarea
					aria-invalid={add.duplicate ? true : undefined}
					aria-label="New criterion"
					autoComplete="off"
					className="question-field"
					enterKeyHint="done"
					maxLength={MAX_CRITERION_LABEL}
					onBlur={() => {
						if (!add.text?.trim() && !add.pending) add.cancel();
					}}
					onChange={event => add.change(event.currentTarget.value)}
					onKeyDown={event => {
						onFieldKeys(add, event, () => {
							focus.current = "trigger";
						});
					}}
					placeholder="Add a criterion"
					readOnly={add.pending}
					ref={input}
					rows={1}
					value={add.text}
				/>
			</div>
			<p className="question-add-hint" role="status">{add.hint}</p>
		</div>
	);
}

/* The matrix ----------------------------------------------------------------------------------- */

export type CriteriaGridProps = {
	options: readonly Option[];
	criteria: readonly Criterion[];
	marks: { [cell: string]: Mark | null } | undefined;
	/** Whether a person can change marks; without it the cells only show them. */
	onMark?: (option: string, criterion: string, mark: Mark | null) => void;
	/** Append a criterion for everyone. Absent where the viewer may not write. */
	onAddCriterion?: (label: string) => Promise<AddCriterionResult>;
	/** The option's own label row: its radio, letter and text. */
	renderPick: (option: Option, index: number) => ReactNode;
};

const noAdd = async (): Promise<AddCriterionResult> => ({ ok: false, message: "" });

export function CriteriaGrid(
	{ options, criteria, marks, onMark, onAddCriterion, renderPick }: CriteriaGridProps,
) {
	let wrap = useRef<HTMLDivElement>(null);
	let [chips, setChips] = useState(false);
	let add = useAdd({ criteria, onAdd: onAddCriterion ?? noAdd });
	let plus = useRef<HTMLButtonElement>(null);
	let back = useRef(false);

	useLayoutEffect(() => {
		let node = wrap.current;
		if (!node) return;
		let measure = () => {
			let rem = parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
			setChips(node.clientWidth < CHIPS_BELOW * rem);
		};
		measure();
		let observer = new ResizeObserver(measure);
		observer.observe(node);
		return () => observer.disconnect();
	}, []);

	useEffect(() => {
		if (!back.current || add.text !== null) return;
		back.current = false;
		plus.current?.focus({ preventScroll: true });
	});

	let room = !!onAddCriterion && criteria.length < MAX_CRITERIA;
	let adding = !chips && add.text !== null;
	let cell = (option: Option, criterion: Criterion) => {
		let mark = marks?.[markKey(option.id, criterion.id)] ?? null;
		let name = `${plainInlineText(option.label)}, ${criterion.label}`;
		return onMark
			? (
				<MarkCell
					chip={chips ? criterion.label : undefined}
					mark={mark}
					name={name}
					onMark={value => onMark(option.id, criterion.id, value)}
				/>
			)
			: chips
			? (
				<span
					aria-label={markName(plainInlineText(option.label), criterion.label, mark)}
					role="img"
				>
					<Badge
						icon={chipIcon(mark)}
						label={criterion.label}
						size="sm"
						tone={mark ? TONE[mark] : "neutral"}
					/>
				</span>
			)
			: <ReadOnlyMark label={name} mark={mark} />;
	};

	if (chips) {
		return (
			<div className="crit-wrap" ref={wrap}>
				<div className="crit" data-layout="chips">
					{options.map((option, index) => (
						<div className="crit-row question-option" key={option.id}>
							{renderPick(option, index)}
							<div className="crit-chips">
								{criteria.map(criterion => (
									<span className="crit-chip" key={criterion.id}>{cell(option, criterion)}</span>
								))}
							</div>
						</div>
					))}
				</div>
				{room && <AddRow add={add} />}
			</div>
		);
	}

	return (
		<div className="crit-wrap" ref={wrap}>
			<div className="crit-scroll">
				<div
					className="crit"
					data-adding={adding ? "" : undefined}
					data-count={criteria.length}
					data-layout="columns"
					data-plus={room ? "" : undefined}
				>
					<div className="crit-head">
						{criteria.map(criterion => (
							<span className="crit-head-label" key={criterion.id} title={criterion.label}>
								{criterion.label}
							</span>
						))}
						{adding
							? (
								<AddField
									add={add}
									done={() => {
										back.current = true;
									}}
								/>
							)
							: room && (
								<button
									aria-label="Add a criterion"
									className="btn btn-icon-xs btn-ghost crit-plus"
									onClick={add.open}
									ref={plus}
									type="button"
								>
									<PlusIcon aria-hidden="true" />
								</button>
							)}
					</div>
					<div className="crit-body">
						{options.map((option, index) => (
							<div className="crit-row question-option" key={option.id}>
								{renderPick(option, index)}
								{criteria.map(criterion => (
									<span className="crit-slot" key={criterion.id}>{cell(option, criterion)}</span>
								))}
								{(adding || room) && (
									<span className="crit-slot" data-ghost={adding ? "" : undefined}>
										{adding && <MarkGlyph />}
									</span>
								)}
							</div>
						))}
					</div>
				</div>
			</div>
			{adding && <p className="question-add-hint crit-hint" role="status">{add.hint}</p>}
		</div>
	);
}
