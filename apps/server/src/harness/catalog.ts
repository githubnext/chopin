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

/** The most models one catalog lists, as the agent connection's own limit. */
export const MAX_MODELS = 512;

/**
 * The catalog an attached client reported, for the browser. `MODEL`, when the operator set it,
 * is the default in the client's place; otherwise the client's own default stands. No models
 * reported means no catalog: a client that offers only commands offers no choice of model.
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
			...(model.provider ? { provider: model.provider } : {}),
			...(model.description ? { description: model.description } : {}),
			...(model.thinkingLevels?.length ? { thinkingLevels: model.thinkingLevels } : {}),
		})),
		...(chosen
			? {
				default: {
					model: chosen,
					...(!operatorModel && fallback?.thinkingLevel
						? { thinkingLevel: fallback.thinkingLevel }
						: {}),
				},
			}
			: {}),
	};
}
