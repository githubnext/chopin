/**
 * What the composer's model picker shows and what a pick asks for, as pure functions of the
 * catalog the document's harness reports and the choice the document holds. The server decides
 * what a turn runs with the same resolver, so the browser never shows a model that will not run.
 */

import {
	catalogModel,
	levelLabel,
	levelPhrase,
	modelLevels,
	resolveChoice,
	unavailableNotice,
	UNREADABLE_NOTICE,
} from "@chopin/protocol/model-choice";

import type { Chat } from "@chopin/protocol";

type Catalog = Chat.ModelCatalog;
type Choice = Chat.ModelChoice;

export type PickerModel = Chat.ModelOption & {
	/** Tells this entry from the others, even one with the same `id`; it holds while a search runs. */
	key: string;
	/** The harness runs it when nobody has chosen. */
	isDefault: boolean;
	/** It is the model that will run: of entries sharing its `id`, the first, as the server finds it. */
	selected: boolean;
};

export type PickerGroup = {
	/** Tells the group from the others: a provider's id, or none for the models that name none. */
	id: string;
	name: string | undefined;
	models: PickerModel[];
};

/** The model that will run: the chosen one if the catalog offers it, else the harness's default. */
export function shownModel(
	catalog: Catalog,
	choice: Choice | undefined,
): Chat.ModelOption | undefined {
	let resolved = resolveChoice(catalog, choice);
	return catalogModel(catalog, resolved.model ?? catalog.default?.model);
}

/** What a person reads for a model: its name, or its id when the client reported an empty name. */
function modelName(model: Chat.ModelOption): string {
	return model.name || model.id;
}

/** Every term of the query appears in the model's name, id, provider or description. */
export function matchesQuery(model: Chat.ModelOption, query: string): boolean {
	let terms = query.toLowerCase().split(/\s+/).filter(Boolean);
	if (terms.length === 0) return true;
	let text = [model.name, model.id, model.provider?.name, model.provider?.id, model.description]
		.filter(Boolean).join("\n").toLowerCase();
	return terms.every(term => text.includes(term));
}

/**
 * The models that match, grouped by provider in the order each provider first appears and in the
 * catalog's order within it. A model with no provider is listed under no heading when none has
 * one, and under "Other" beside providers that do.
 */
export function pickerGroups(
	catalog: Catalog,
	choice: Choice | undefined,
	query: string,
): PickerGroup[] {
	let shown = shownModel(catalog, choice)?.id;
	let named = catalog.models.some(model => model.provider);
	let groups = new Map<string, PickerGroup>();
	let seen = new Map<string, number>();
	for (let model of catalog.models) {
		// A catalog may list an id twice; each entry stays, and the count is of the whole catalog.
		let occurrence = seen.get(model.id) ?? 0;
		seen.set(model.id, occurrence + 1);
		if (!matchesQuery(model, query)) continue;
		// Apart from any provider's id, an empty one included, so the two never share a group.
		let id = model.provider ? `provider:${model.provider.id}` : "none";
		let group = groups.get(id);
		if (!group) {
			group = {
				id,
				name: model.provider
					? model.provider.name || model.provider.id
					: named
					? "Other"
					: undefined,
				models: [],
			};
			groups.set(id, group);
		}
		group.models.push({
			...model,
			name: modelName(model),
			key: `${occurrence}:${model.id}`,
			isDefault: model.id === catalog.default?.model,
			selected: occurrence === 0 && model.id === shown,
		});
	}
	return [...groups.values()];
}

/** The models in the order the keyboard walks them. */
export function pickerOptions(groups: readonly PickerGroup[]): PickerModel[] {
	return groups.flatMap(group => group.models);
}

/** What the trigger says: the model that will run, and the level somebody chose for it. */
export function triggerText(
	catalog: Catalog,
	choice: Choice | undefined,
): { name: string; level?: string } {
	let resolved = resolveChoice(catalog, choice);
	let shown = shownModel(catalog, choice);
	let name = shown ? modelName(shown) : "Default";
	return { name, ...(resolved.thinkingLevel ? { level: levelLabel(resolved.thinkingLevel) } : {}) };
}

/** What the trigger's name and tooltip say of the level somebody chose, in the level's own spelling. */
function reasoningPhrase(catalog: Catalog, choice: Choice | undefined): string | undefined {
	let { thinkingLevel } = resolveChoice(catalog, choice);
	return thinkingLevel ? `reasoning ${levelPhrase(thinkingLevel)}` : undefined;
}

/** The words a person who cannot see the trigger hears: the model, its level, and what went missing. */
export function triggerLabel(catalog: Catalog, choice: Choice | undefined): string {
	let lost = resolveChoice(catalog, choice).unavailable;
	return [
		`Model: ${triggerText(catalog, choice).name}`,
		reasoningPhrase(catalog, choice),
		lost ? unavailableNotice(catalog, lost) : undefined,
	].filter(Boolean).join(", ");
}

/**
 * The trigger's tooltip: the model and level, without the sentence about a choice that has gone,
 * which the strip above the composer already says and a screen reader hears in the name.
 */
export function triggerTitle(catalog: Catalog, choice: Choice | undefined): string {
	return [`Model: ${triggerText(catalog, choice).name}`, reasoningPhrase(catalog, choice)]
		.filter(Boolean).join(", ");
}

/**
 * What to say about a stored choice the harness no longer offers, if anything. With no catalog at
 * all, such as after a client withdrew its models, every model or level somebody chose is gone,
 * and a default nobody chose is not a choice.
 */
export function fallbackNotice(
	catalog: Catalog | undefined,
	choice: Choice | undefined,
): string | undefined {
	let lost = resolveChoice(catalog, choice).unavailable;
	return lost ? unavailableNotice(catalog, lost) : undefined;
}

/**
 * What the composer's strip says about the document's model, if anything. A choice the server just
 * refused comes first, then the server's word that a turn could not read the choice and ran the
 * harness's default (which holds even where this browser has no catalog), then a stored choice
 * the catalog no longer offers. Where there is no catalog and so no control, `saved` (the choice
 * the room holds) is checked against it in the control's place: the picker is gone, but a model
 * somebody chose has not become the default, and the strip still says so.
 */
export function composerModelNotice(
	control:
		| { catalog: Catalog; choice: Choice | undefined; refusal: string | undefined }
		| undefined,
	unreadable: boolean,
	saved?: Choice,
): { tone: "warning" | "info"; text: string } | undefined {
	if (control?.refusal) return { tone: "warning", text: control.refusal };
	if (unreadable) return { tone: "info", text: UNREADABLE_NOTICE };
	let lost = control
		? fallbackNotice(control.catalog, control.choice)
		: fallbackNotice(undefined, saved);
	return lost ? { tone: "info", text: lost } : undefined;
}

/**
 * The reasoning levels offered for the model that will run, and the one chosen. None for a model
 * with no levels, and then the control is not drawn.
 */
export function reasoningLevels(
	catalog: Catalog,
	choice: Choice | undefined,
): { levels: string[]; current: string | undefined } {
	let resolved = resolveChoice(catalog, choice);
	return {
		levels: modelLevels(catalog, resolved.model),
		current: resolved.thinkingLevel,
	};
}

export type LevelStep = { key: string; level: string | undefined; checked: boolean };

/**
 * What the reasoning control draws: Default (the model's own, `level` absent) and then each level
 * as the catalog lists it. A catalog may list a level twice, or one named `default`, so a step is
 * told apart by its place, and the first step that is the choice is the one checked.
 */
export function levelSteps(levels: readonly string[], current: string | undefined): LevelStep[] {
	let steps: Array<string | undefined> = [undefined, ...levels];
	let chosen = steps.indexOf(current);
	return steps.map((level, position) => ({
		key: `${position}`,
		level,
		checked: position === chosen,
	}));
}

/**
 * The choice a pick of `id` asks for. The model is recorded as picked, the harness's own default
 * included: the document keeps the model somebody chose even when the client's default later
 * changes. The level carries over only when the new model offers it.
 */
export function chooseModel(catalog: Catalog, choice: Choice | undefined, id: string): Choice {
	let level = resolveChoice(catalog, choice).thinkingLevel;
	return {
		model: id,
		...(level !== undefined && modelLevels(catalog, id).includes(level)
			? { thinkingLevel: level }
			: {}),
	};
}

/** The choice a pick of a level asks for; no level goes back to the model's own. */
export function chooseLevel(
	catalog: Catalog,
	choice: Choice | undefined,
	level: string | undefined,
): Choice {
	let { model } = resolveChoice(catalog, choice);
	return {
		...(model !== undefined ? { model } : {}),
		...(level !== undefined ? { thinkingLevel: level } : {}),
	};
}

/** Whether two choices ask for the same thing. */
export function sameChoice(left: Choice | undefined, right: Choice | undefined): boolean {
	return left?.model === right?.model && left?.thinkingLevel === right?.thinkingLevel;
}

export type PickerKey = "close" | "next" | "previous" | "pick";

/** What a key does in the picker's search field, or nothing for a key the field keeps (Home and End move its caret). */
export function pickerKey(
	event: { key: string; keyCode?: number; isComposing?: boolean; shiftKey?: boolean },
	hasOptions: boolean,
): PickerKey | undefined {
	if (event.isComposing || event.keyCode === 229) return undefined;
	if (event.key === "Escape") return "close";
	if (!hasOptions) return undefined;
	if (event.key === "ArrowDown") return "next";
	if (event.key === "ArrowUp") return "previous";
	if (event.key === "Enter" && !event.shiftKey) return "pick";
	return undefined;
}

/** The index a key moves to, wrapping at either end. */
export function movedIndex(key: PickerKey, active: number, count: number): number {
	if (count === 0) return 0;
	if (key === "next") return (active + 1) % count;
	if (key === "previous") return (active - 1 + count) % count;
	return active;
}
