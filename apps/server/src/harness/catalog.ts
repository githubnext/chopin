/**
 * What a Planner's harness offers a person to choose from, as the browser sees it: the models a
 * document's agent can run and each model's thinking levels. Only a harness that can honor a
 * chosen model reports one; every other harness reports none and the composer offers no choice.
 */

import type { CapabilityCatalog } from "@chopin/agent-link";
import type { Chat as Wire } from "@chopin/protocol";

/** The levels Atomic knows, in the order it lists them. */
const ATOMIC_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

/**
 * The thinking levels an Atomic model supports, as Atomic's own `getSupportedThinkingLevels` reads
 * them from the model: a level mapped to `null` is unsupported, `xhigh` and `max` only when mapped.
 * A model with no reasoning has no control to offer, where Atomic itself says `off`.
 */
export function atomicThinkingLevels(
	model: { reasoning: boolean; thinkingLevelMap?: Partial<Record<string, string | null>> },
): string[] {
	if (!model.reasoning) return [];
	return ATOMIC_LEVELS.filter(level => {
		let mapped = model.thinkingLevelMap?.[level];
		if (mapped === null) return false;
		if (level === "xhigh" || level === "max") return mapped !== undefined;
		return true;
	});
}

/**
 * The catalog an attached client reported, for the browser. `MODEL`, when the operator set it,
 * is the default in the client's place; otherwise the client's own default stands. No models
 * reported means no catalog: a client that offers only commands offers no choice of model. Every
 * field of a model is passed as the client gave it, an empty description or list of levels
 * included: the composer reads an empty list as no reasoning control and an empty description as
 * none.
 */
export function remoteCatalog(
	reported: CapabilityCatalog | undefined,
	operatorModel: string | undefined,
): Wire.ModelCatalog | undefined {
	let models = reported?.models?.available;
	if (!models?.length) return undefined;
	let fallback = reported?.models?.default;
	let chosen = operatorModel || fallback?.id;
	return {
		models: models.map(model => ({
			id: model.id,
			name: model.name,
			...(model.provider
				? {
					provider: {
						id: model.provider.id,
						...(model.provider.name !== undefined ? { name: model.provider.name } : {}),
					},
				}
				: {}),
			...(model.description !== undefined ? { description: model.description } : {}),
			...(model.thinkingLevels !== undefined ? { thinkingLevels: model.thinkingLevels } : {}),
			...(model.inputTypes !== undefined ? { inputTypes: model.inputTypes } : {}),
		})),
		...(chosen !== undefined
			? {
				default: {
					model: chosen,
					...(!operatorModel && fallback?.thinkingLevel !== undefined
						? { thinkingLevel: fallback.thinkingLevel }
						: {}),
				},
			}
			: {}),
	};
}

/**
 * The commands an attached client reported, for the browser, in the order, spelling and with the
 * duplicates it gave them. None reported, or none left in the list, is no commands: `/` then offers
 * only Chopin's own.
 */
export function remoteCommands(
	reported: CapabilityCatalog | undefined,
): Wire.CommandOption[] | undefined {
	let commands = reported?.commands;
	if (!commands?.length) return undefined;
	return commands.map(command => ({
		name: command.name,
		kind: command.kind,
		...(command.description !== undefined ? { description: command.description } : {}),
	}));
}
