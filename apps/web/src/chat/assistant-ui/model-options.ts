import { levelLabel, modelLevels } from "@chopin/protocol/model-choice";

import { defaultStepLabel, levelSteps, pickerGroups, reasoningLevels } from "../model-picker-state";

import type { Chat } from "@chopin/protocol";
import type { ModelOption } from "@/components/assistant-ui/utils/model-selection";

/**
 * What a copied assistant-ui model selector is given for a document's model catalogue. The element is
 * driven by props, so this is the whole seam: Chopin's own state in, the element's option list out.
 * A model's `id` is the exact string a turn names, and its levels keep the harness's own spelling
 * (`xhigh` stays `xhigh`, and `High` stays apart from `high`), so what is chosen is what is sent.
 */
export function modelOptions(catalog: Chat.ModelCatalog | undefined): ModelOption[] {
	return (catalog?.models ?? []).map(model => ({
		id: model.id,
		name: model.name,
		...(model.description ? { description: model.description } : {}),
		...(model.thinkingLevels?.length
			? { efforts: model.thinkingLevels.map(level => ({ id: level, name: level })) }
			: {}),
	}));
}

export type ModelSelection = {
	/** The models by provider, in the order each first appears; no name where none names a provider. */
	groups: { id: string; name: string | undefined; options: ModelOption[] }[];
	/** The option that will run, or none while nothing is chosen and the harness names no default. */
	value: string;
	/** The chosen level of that model: its own (`levelOf` gives none) or one of the levels it lists. */
	effort: string | undefined;
	/** The id a turn carries for an option, which a catalog that lists a model twice shares. */
	modelOf: (option: string) => string;
	/** The level an effort step stands for, or none for the model's own. */
	levelOf: (effort: string) => string | undefined;
};

/**
 * What the composer's model pill gives the copied selector for a document's catalogue and choice.
 * An option is told apart by its place (a catalogue may list an id twice) and an effort step by its
 * position among the model's levels, which begin with its own, so a level named like another, or
 * like the model's own, is still the one chosen and is sent exactly as the harness spelled it.
 */
export function modelSelection(
	catalog: Chat.ModelCatalog,
	choice: Chat.ModelChoice | undefined,
): ModelSelection {
	let ids = new Map<string, string>();
	let shown: string | undefined;
	let groups = pickerGroups(catalog, choice, "").map(group => ({
		id: group.id,
		name: group.name,
		options: group.models.map(model => {
			let levels = modelLevels(catalog, model.id);
			ids.set(model.key, model.id);
			if (model.selected) shown = model.key;
			let own = defaultStepLabel(levels);
			let description = model.isDefault
				? ["Default.", model.description].filter(Boolean).join(" ")
				: model.description;
			return {
				id: model.key,
				name: model.name,
				...(description ? { description } : {}),
				keywords: [model.id, model.provider?.name, model.provider?.id, model.description].filter(
					(term): term is string => !!term,
				),
				...(levels.length
					? {
						efforts: levelSteps(levels, undefined).map(step => ({
							id: step.key,
							name: step.level === undefined ? own : levelLabel(step.level),
						})),
					}
					: {}),
			};
		}),
	}));
	let { levels, current } = reasoningLevels(catalog, choice);
	let steps = levelSteps(levels, current);
	return {
		groups,
		value: shown ?? "",
		effort: levels.length ? steps.find(step => step.checked)?.key : undefined,
		modelOf: option => ids.get(option) ?? option,
		levelOf: effort => steps.find(step => step.key === effort)?.level,
	};
}
