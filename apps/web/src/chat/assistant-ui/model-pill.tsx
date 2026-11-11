/**
 * The composer's model pill: assistant-ui's own `ComposerModelTrigger`, which opens its Model
 * selector, both copied unmodified and driven by Chopin's catalog and choice through props
 * (`modelSelection`). `useModelChoice` owns the choice and the wire.
 */

import { useState } from "react";

import { ComposerModelTrigger } from "@/components/assistant-ui/elements/composer";
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

import type { ReactNode } from "react";
import type { ModelControl } from "../use-model-choice";

export function ModelPill({ control }: { control: ModelControl }) {
	let { catalog, choice, choose, modelName } = control;
	let [open, setOpen] = useState(false);
	let { groups, value, effort, modelOf, levelOf } = modelSelection(catalog, choice);
	let { name, level } = triggerText(catalog, choice);
	let notice = fallbackNotice(catalog, choice, modelName);
	// The element types `model` as a string and draws it as a child, so a node is drawn as it is:
	// the name, which gives way to an ellipsis, and the level in lighter ink.
	let shown: ReactNode = (
		<>
			<span className="min-w-0 truncate">{name}</span>
			{level && <span className="shrink-0 text-text-tertiary">{level}</span>}
		</>
	);
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
					<ComposerModelTrigger
						aria-label={triggerLabel(catalog, choice, modelName)}
						className="min-w-0"
						model={shown as unknown as string}
						open={open}
						title={triggerTitle(catalog, choice)}
					/>
				}
			/>
			<ModelSelectorContent
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
				<ModelSelectorEffort />
			</ModelSelectorContent>
		</ModelSelectorRoot>
	);
}
