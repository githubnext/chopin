/**
 * The composer's model pill: a small ghost button that names the model that will run and, in
 * lighter ink, its level, and opens assistant-ui's Model selector, copied unmodified and driven by
 * Chopin's catalog and choice through props (`modelSelection`). `useModelChoice` owns the choice and
 * the wire.
 */

import { useCallback, useLayoutEffect, useRef, useState } from "react";

import { ChevronIcon } from "@chopin/icons";
import {
	ModelSelectorContent,
	ModelSelectorEffort,
	ModelSelectorEmpty,
	ModelSelectorGroup,
	ModelSelectorItem,
	ModelSelectorList,
	ModelSelectorRoot,
	ModelSelectorSearch,
} from "@/components/assistant-ui/elements/model-selector";
import { PopoverTrigger } from "@/components/ui/popover";
import {
	chooseLevel,
	chooseModel,
	fallbackNotice,
	triggerLabel,
	triggerText,
	triggerTitle,
} from "../model-picker-state";
import { modelSelection } from "./model-options";

import type { ModelControl } from "../use-model-choice";

export function ModelPill({ control }: { control: ModelControl }) {
	let { catalog, choice, choose, modelName } = control;
	let [open, setOpen] = useState(false);
	// The selector is 288px wide and opens level with the pill, which a phone's row can put near the
	// right edge: it is moved along the pill's edge, as far as it needs, to stay inside the screen.
	let pill = useRef<HTMLButtonElement>(null);
	let [offset, setOffset] = useState(0);
	useLayoutEffect(() => {
		let node = pill.current;
		if (!open || !node) return;
		let edge = node.getBoundingClientRect().left;
		let width = Math.min(288, innerWidth - 16);
		setOffset(Math.max(8, Math.min(edge, innerWidth - width - 8)) - edge);
	}, [open]);
	let { groups, value, effort, modelOf, levelOf } = modelSelection(catalog, choice);
	let { name, level } = triggerText(catalog, choice);
	let notice = fallbackNotice(catalog, choice, modelName);
	let levels = useLevelLane(value, effort);
	return (
		<ModelSelectorRoot
			effort={effort ?? ""}
			models={groups.flatMap(group => group.options)}
			onEffortChange={step => choose(chooseLevel(catalog, choice, levelOf(step)))}
			onOpenChange={setOpen}
			onValueChange={option => choose(chooseModel(catalog, choice, modelOf(option)))}
			open={open}
			value={value}
		>
			<PopoverTrigger
				render={
					<button
						ref={pill}
						aria-label={triggerLabel(catalog, choice, modelName)}
						className="btn btn-sm btn-ghost composer-model-pill"
						data-press="none"
						title={triggerTitle(catalog, choice)}
						type="button"
					>
						<span className="composer-model-name">{name}</span>
						{level && <span className="composer-model-level">{level}</span>}
						<ChevronIcon aria-hidden="true" className="composer-model-chevron" size={12} />
					</button>
				}
			/>
			<ModelSelectorContent
				alignOffset={offset}
				aria-label="Model and reasoning"
				className="composer-model-selector"
				searchable
				side="top"
			>
				<ModelSelectorSearch aria-label="Search models" placeholder="Search models…" />
				{notice && <p className="px-3 py-2 text-xs text-text-tertiary" role="status">{notice}</p>}
				<ModelSelectorList>
					<ModelSelectorEmpty>No matching models.</ModelSelectorEmpty>
					{groups.map(group => (
						<ModelSelectorGroup heading={group.name} key={group.id}>
							{group.options.map(option => <ModelSelectorItem key={option.id} model={option} />)}
						</ModelSelectorGroup>
					))}
				</ModelSelectorList>
				<div className="composer-model-levels" ref={levels.ref}>
					<ModelSelectorEffort className="composer-model-effort" data-more={levels.more} />
				</div>
			</ModelSelectorContent>
		</ModelSelectorRoot>
	);
}

type More = "start" | "end" | "both";

/**
 * The Thinking row's levels as one lane that scrolls sideways when they are wider than the popover
 * (an agent can report six levels besides the model's own): a wheel turned over the row moves it,
 * touch pans it, the focus the arrow keys move brings a level into view, and the chosen level is
 * in view whenever the popover opens or the choice changes. `more` names the side that still
 * hides levels, which `composer.css` fades as a wide table's is. The lane is the element's own
 * radio group, reached from a wrapper that draws no box, so the copy keeps its bytes.
 */
function useLevelLane(model: string, effort: string | undefined) {
	let [node, setNode] = useState<HTMLDivElement | null>(null);
	let [more, setMore] = useState<More | undefined>();
	let placed = useRef(false);
	let ref = useCallback((wrapper: HTMLDivElement | null) => {
		setNode(wrapper);
		if (!wrapper) return;
		let lane = () => wrapper.querySelector<HTMLElement>("[role='radiogroup']");
		let measure = () => {
			let group = lane();
			setMore(group ? hidden(group) : undefined);
		};
		// React listens to wheels passively, so only a listener of its own may keep the page still.
		let wheel = (event: WheelEvent) => {
			let group = lane();
			if (!group || event.ctrlKey) return;
			let delta = Math.abs(event.deltaX) > Math.abs(event.deltaY) ? event.deltaX : event.deltaY;
			let room = delta < 0
				? group.scrollLeft
				: group.scrollWidth - group.clientWidth - group.scrollLeft;
			if (delta === 0 || room < 1) return;
			event.preventDefault();
			let step = event.deltaMode === WheelEvent.DOM_DELTA_LINE ? 16 : 1;
			group.scrollBy({ left: delta * step, behavior: "instant" });
		};
		let resize = new ResizeObserver(measure);
		let group = lane();
		if (group) resize.observe(group);
		wrapper.addEventListener("wheel", wheel, { passive: false });
		wrapper.addEventListener("scroll", measure, { capture: true, passive: true });
		return () => {
			resize.disconnect();
			wrapper.removeEventListener("wheel", wheel);
			wrapper.removeEventListener("scroll", measure, { capture: true });
			placed.current = false;
			setNode(null);
			setMore(undefined);
		};
	}, []);
	useLayoutEffect(() => {
		let group = node?.querySelector<HTMLElement>("[role='radiogroup']");
		let chosen = group?.querySelector<HTMLElement>("[role='radio'][aria-checked='true']");
		if (!group || !chosen) return;
		// The edge a fade covers is kept clear: `scroll-padding-inline` is the fade's width.
		let pad = parseFloat(getComputedStyle(group).scrollPaddingInlineStart) || 0;
		// The lane is positioned, so this is the level's place in it, whatever its scroll and however
		// far the popover's entrance has scaled it.
		let start = chosen.offsetLeft;
		let end = start + chosen.offsetWidth;
		let left = group.scrollLeft;
		if (start - pad < left) left = start - pad;
		else if (end + pad > left + group.clientWidth) left = end + pad - group.clientWidth;
		let still = !placed.current || matchMedia("(prefers-reduced-motion: reduce)").matches;
		placed.current = true;
		group.scrollTo({ left: Math.max(0, left), behavior: still ? "instant" : "smooth" });
		setMore(hidden(group));
	}, [node, model, effort]);
	return { ref, more };
}

function hidden(group: HTMLElement): More | undefined {
	let before = group.scrollLeft > 1;
	let after = group.scrollWidth - group.clientWidth - group.scrollLeft > 1;
	return before && after ? "both" : before ? "start" : after ? "end" : undefined;
}
