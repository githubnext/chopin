/**
 * Resolving a document's stored model choice against what its agent offers now. The server
 * resolves at every turn and when it accepts a choice; the browser resolves the same way to show
 * what will run, so the two can never disagree about a model that has gone.
 */

import type { Chat } from "./chat";

type Catalog = Chat.ModelCatalog;
type Choice = Chat.ModelChoice;

/** What a turn runs, and the parts of the stored choice the catalog could not honour. */
export type ResolvedChoice = {
	/** The chosen model's id when the catalog offers it; absent runs the agent's default. */
	model?: string;
	/** The chosen thinking level when the model offers it; absent runs the agent's default. */
	thinkingLevel?: string;
	/** What was stored but is not in force; absent when everything stored is. */
	unavailable?: Choice;
};

/** The model entry for an id, as the catalog reports it. */
export function catalogModel(
	catalog: Catalog | undefined,
	id: string | undefined,
): Chat.ModelOption | undefined {
	return id === undefined ? undefined : catalog?.models.find(model => model.id === id);
}

/**
 * The thinking levels a choice of `model` can use: that model's, or the agent's default model's
 * when none is chosen. Empty when the model has none or the catalog does not list it.
 */
export function modelLevels(catalog: Catalog | undefined, model: string | undefined): string[] {
	return catalogModel(catalog, model ?? catalog?.default?.model)?.thinkingLevels ?? [];
}

/**
 * Whether the model a turn would run reads images: the chosen model, or the agent's default when
 * none is chosen, and only when its catalog entry says `image`. A catalog that names no input
 * types, or none at all, reads as text only, so an image is never sent to a model that has not
 * said it can read one.
 */
export function modelReadsImages(
	catalog: Catalog | undefined,
	choice: Choice | undefined,
): boolean {
	let model = resolveChoice(catalog, choice).model ?? catalog?.default?.model;
	return catalogModel(catalog, model)?.inputTypes?.includes("image") === true;
}

/**
 * Checks a stored choice against the catalog. A model the catalog does not list is not chosen, and
 * neither is a thinking level its model does not list; each is reported in `unavailable` and the
 * agent's default runs in its place. The stored choice itself is never changed here.
 */
export function resolveChoice(
	catalog: Catalog | undefined,
	choice: Choice | undefined,
): ResolvedChoice {
	if (!choice || choice.model === undefined && choice.thinkingLevel === undefined) return {};
	if (!catalog) return { unavailable: { ...choice } };
	let resolved: ResolvedChoice = {};
	let unavailable: Choice = {};
	if (choice.model !== undefined) {
		if (catalogModel(catalog, choice.model)) resolved.model = choice.model;
		else {
			// Its thinking level belonged to the model that has gone.
			unavailable.model = choice.model;
			if (choice.thinkingLevel !== undefined) unavailable.thinkingLevel = choice.thinkingLevel;
			return { unavailable };
		}
	}
	if (choice.thinkingLevel !== undefined) {
		if (modelLevels(catalog, resolved.model).includes(choice.thinkingLevel)) {
			resolved.thinkingLevel = choice.thinkingLevel;
		} else unavailable.thinkingLevel = choice.thinkingLevel;
	}
	if (unavailable.model !== undefined || unavailable.thinkingLevel !== undefined) {
		resolved.unavailable = unavailable;
	}
	return resolved;
}

/**
 * Why the catalog does not offer a choice, for refusing it: the first thing it asks for that the
 * catalog lacks. Undefined when the whole choice is offered, an empty choice (back to the agent's
 * default) always is.
 */
export function refusedChoice(catalog: Catalog | undefined, choice: Choice): string | undefined {
	if (choice.model === undefined && choice.thinkingLevel === undefined) return undefined;
	if (!catalog) return "This document's model can't be chosen.";
	if (choice.model !== undefined && !catalogModel(catalog, choice.model)) {
		return "That model isn't available.";
	}
	if (
		choice.thinkingLevel !== undefined
		&& !modelLevels(catalog, choice.model).includes(choice.thinkingLevel)
	) return "That model doesn't offer that level of reasoning.";
	return undefined;
}

/**
 * A thinking level in words: the string its client reported, Atomic's own (`xhigh`) included, with
 * its spelling and case as written. A level is any string and every level a client lists is a
 * choice of its own, so nothing is capitalised, spelled out or quoted: `xhigh` and `extra high`,
 * `ß-fast` and `SS-fast` (a capital ß is SS), and `high` and `High` each stay two, in the list of
 * levels, the trigger and its name, and the turn carries the same string the person saw.
 */
export function levelLabel(level: string): string {
	return level;
}

/**
 * The words for a turn that could not read the document's model choice, or the catalog to check it
 * against, and so ran the harness's default. The server says them in Chat and tells the room, and
 * the composer shows them, so a choice is never dropped without a word.
 */
export const UNREADABLE_NOTICE =
	"This document's model choice couldn't be read, so Chopin used its default model.";

/** The words a person reads for what could not be honoured, without Chopin's own terms. */
export function unavailableNotice(
	catalog: Catalog | undefined,
	unavailable: Choice,
	modelName?: string,
): string {
	// A catalog may give a model an empty name: it is then called by its id.
	let name = (id: string) => modelName || catalogModel(catalog, id)?.name || id;
	if (unavailable.model !== undefined) {
		return `${name(unavailable.model)} is no longer available, so Chopin used its default model.`;
	}
	return `${
		levelLabel(unavailable.thinkingLevel ?? "")
	} reasoning is no longer available for this model, `
		+ "so Chopin used its default.";
}
