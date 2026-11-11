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
