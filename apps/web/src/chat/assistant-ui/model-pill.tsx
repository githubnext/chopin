/**
 * The composer's model pill: a small ghost button that names the model that will run and, in
 * lighter ink, its level, and opens assistant-ui's Model selector, copied unmodified and driven by
 * Chopin's catalog and choice through props (`modelSelection`). `useModelChoice` owns the choice and
 * the wire.
 */

import { useLayoutEffect, useRef, useState } from "react";

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
				<ModelSelectorEffort className="flex-wrap" />
			</ModelSelectorContent>
		</ModelSelectorRoot>
	);
}
