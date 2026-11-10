/**
 * The composer's model and reasoning control: a trigger in the footer and one popover over the
 * composer holding a search field, the models grouped by provider, and the reasoning levels of
 * the model that will run. Presentational: `useModelChoice` owns the choice and the wire.
 */

import { useEffect, useId, useRef, useState } from "react";
import { InfoIcon, SearchIcon } from "@chopin/icons";
import { levelLabel } from "@chopin/protocol/model-choice";

import {
	ComposerMenu,
	ComposerModelItem,
	ComposerModelTrigger,
} from "./assistant-ui/composer-model";
import {
	chooseLevel,
	chooseModel,
	fallbackNotice,
	movedIndex,
	pickerGroups,
	pickerKey,
	pickerOptions,
	reasoningLevels,
	triggerLabel,
	triggerText,
} from "./model-picker-state";
import { referenceOptionId } from "./reference-picker";

import type { KeyboardEvent, Ref } from "react";
import type { ModelControl } from "./use-model-choice";

/** The footer's trigger: the model that will run, and the level chosen for it. */
export function ModelPickerTrigger(
	{ control, open, onToggle, controls, triggerRef }: {
		control: ModelControl;
		open: boolean;
		onToggle: () => void;
		/** The popover's id while it is open. */
		controls?: string;
		triggerRef?: Ref<HTMLButtonElement>;
	},
) {
	let { name, level } = triggerText(control.catalog, control.choice);
	let label = triggerLabel(control.catalog, control.choice);
	return (
		<ComposerModelTrigger
			ref={triggerRef}
			aria-controls={open ? controls : undefined}
			aria-label={label}
			level={level}
			model={name}
			onClick={onToggle}
			open={open}
			title={label}
		/>
	);
}

/**
 * The popover. Its search field holds focus and drives the listbox through
 * `aria-activedescendant`, as the draft does for the other pickers; Escape closes it and returns
 * focus to the trigger, a pointer elsewhere or Tab out of it only closes.
 */
export function ModelPicker(
	{ control, id, onClose, trigger }: {
		control: ModelControl;
		id: string;
		/** `restore` returns focus to the trigger. */
		onClose: (restore: boolean) => void;
		trigger: () => HTMLElement | null;
	},
) {
	let { catalog, choice, choose } = control;
	let [query, setQuery] = useState("");
	let [cursor, setCursor] = useState<{ query: string; index: number }>();
	let search = useRef<HTMLInputElement>(null);
	let menu = useRef<HTMLDivElement>(null);
	let listId = useId();
	let reasoningId = useId();
	let groups = pickerGroups(catalog, choice, query);
	let options = pickerOptions(groups);
	// The row a search starts on: the model that will run, else the first.
	let start = Math.max(0, options.findIndex(option => option.selected));
	let active = Math.min(
		cursor?.query === query ? cursor.index : start,
		Math.max(0, options.length - 1),
	);
	let notice = fallbackNotice(catalog, choice);
	let { levels, current } = reasoningLevels(catalog, choice);

	useEffect(() => {
		search.current?.focus();
	}, []);

	// Outside the popover and its trigger, a pointer or the focus leaving closes it.
	useEffect(() => {
		let inside = (node: EventTarget | null) =>
			node instanceof Node && (menu.current?.contains(node) || trigger()?.contains(node));
		let away = (event: PointerEvent) => {
			if (!inside(event.target)) onClose(false);
		};
		document.addEventListener("pointerdown", away, true);
		return () => document.removeEventListener("pointerdown", away, true);
	}, [onClose, trigger]);

	useEffect(() => {
		if (options.length === 0) return;
		let frame = requestAnimationFrame(() => {
			document.getElementById(referenceOptionId(listId, active))?.scrollIntoView({
				block: "nearest",
			});
		});
		return () => cancelAnimationFrame(frame);
	}, [active, listId, options.length]);

	function pick(index: number) {
		let option = options[index];
		if (!option) return;
		choose(chooseModel(catalog, choice, option.id));
		onClose(true);
	}

	function onKeyDown(event: KeyboardEvent<HTMLInputElement>) {
		let key = pickerKey(event.nativeEvent, options.length > 0);
		// Escape is the popover's, wherever its focus is: it bubbles to `onKeyDown` below.
		if (!key || key === "close") return;
		event.preventDefault();
		if (key === "pick") pick(active);
		else setCursor({ query, index: movedIndex(key, active, options.length) });
	}

	let flat = 0;
	return (
		<ComposerMenu
			ref={menu}
			aria-label="Model and reasoning"
			id={id}
			onKeyDown={event => {
				if (event.key !== "Escape" || event.nativeEvent.isComposing) return;
				event.preventDefault();
				onClose(true);
			}}
			onBlur={event => {
				// Focus moving out of the popover, to the trigger or the page, closes it.
				let next = event.relatedTarget;
				if (
					next instanceof Node && (menu.current?.contains(next) || trigger()?.contains(next))
				) return;
				if (next) onClose(false);
			}}
			role="dialog"
			variant="models"
		>
			<div className="composer-model-search">
				<SearchIcon aria-hidden="true" size={16} />
				<input
					ref={search}
					aria-activedescendant={options.length > 0
						? referenceOptionId(listId, active)
						: undefined}
					aria-autocomplete="list"
					aria-controls={listId}
					aria-expanded="true"
					aria-label="Search models"
					autoComplete="off"
					className="composer-model-search-input"
					onChange={event => setQuery(event.currentTarget.value)}
					onKeyDown={onKeyDown}
					placeholder="Search models…"
					role="combobox"
					spellCheck={false}
					type="text"
					value={query}
				/>
			</div>
			{notice && (
				<p className="composer-picker-status" role="status">
					<InfoIcon aria-hidden="true" size={16} />
					{notice}
				</p>
			)}
			<div className="composer-model-list">
				<div aria-label="Models" id={listId} role="listbox">
					{groups.map(group => {
						let heading = `${listId}-group-${group.id || "none"}`;
						return (
							<div
								aria-labelledby={group.name ? heading : undefined}
								key={group.id}
								role="group"
							>
								{group.name && (
									<div className="composer-model-group" id={heading}>{group.name}</div>
								)}
								{group.models.map(model => {
									let index = flat++;
									return (
										<ComposerModelItem
											active={index === active}
											entry={{
												name: model.name,
												description: model.description,
												meta: model.isDefault ? "Default" : undefined,
											}}
											id={referenceOptionId(listId, index)}
											key={model.id}
											onClick={() => pick(index)}
											onMouseDown={event => event.preventDefault()}
											onMouseEnter={() => setCursor({ query, index })}
											selected={model.selected}
										/>
									);
								})}
							</div>
						);
					})}
				</div>
				{options.length === 0 && (
					<p className="composer-picker-status" role="status">
						<SearchIcon aria-hidden="true" size={16} />
						No matching models.
					</p>
				)}
			</div>
			{levels.length > 0 && (
				<ReasoningLevels
					current={current}
					labelId={reasoningId}
					levels={levels}
					onChoose={level => choose(chooseLevel(catalog, choice, level))}
				/>
			)}
		</ComposerMenu>
	);
}

/**
 * The levels of reasoning the model offers, after Default (the model's own). One radio group: the
 * arrow keys move to the next level and choose it, Tab leaves the group. A level is a setting, so
 * choosing one leaves the popover open and the trigger shows it.
 */
function ReasoningLevels(
	{ current, labelId, levels, onChoose }: {
		current: string | undefined;
		labelId: string;
		levels: readonly string[];
		onChoose: (level: string | undefined) => void;
	},
) {
	let group = useRef<HTMLDivElement>(null);
	let steps: Array<string | undefined> = [undefined, ...levels];
	function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
		let moves: Record<string, number> = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 };
		let step = moves[event.key];
		if (step === undefined) return;
		event.preventDefault();
		let at = Math.max(0, steps.indexOf(current));
		let next = (at + step + steps.length) % steps.length;
		onChoose(steps[next]);
		requestAnimationFrame(() =>
			group.current?.querySelectorAll<HTMLElement>('[role="radio"]')[next]?.focus()
		);
	}
	return (
		<div className="composer-reasoning">
			<span className="composer-reasoning-label" id={labelId}>Reasoning</span>
			<div
				ref={group}
				aria-labelledby={labelId}
				className="composer-reasoning-levels"
				onKeyDown={onKeyDown}
				role="radiogroup"
			>
				{steps.map(level => {
					let checked = level === current;
					return (
						<button
							aria-checked={checked}
							className="composer-reasoning-level"
							data-press="none"
							key={level ?? "default"}
							onClick={() => onChoose(level)}
							role="radio"
							tabIndex={checked ? 0 : -1}
							type="button"
						>
							{level === undefined ? "Default" : levelLabel(level)}
						</button>
					);
				})}
			</div>
		</div>
	);
}
