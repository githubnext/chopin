import { draftedWhy } from "../questions/why";
import { validateProse } from "../questions/write-prose";

export function input(
	raw: unknown,
): { revision: number; id: string; text?: string; why?: string } {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
		throw new Error("write_decision_prose arguments must be an object");
	}
	let value = raw as Record<string, unknown>;
	let keys = Object.keys(value).sort().join(",");
	if (
		keys !== "id,revision,text" && keys !== "id,revision,text,why" && keys !== "id,revision,why"
		|| !Number.isSafeInteger(value.revision) || (value.revision as number) < 0
		|| typeof value.id !== "string" || !value.id || value.id.length > 200
	) throw new Error("write_decision_prose needs revision, id, text and optionally why");
	let result: { revision: number; id: string; text?: string } = {
		revision: value.revision as number,
		id: value.id,
	};
	if (Object.hasOwn(value, "text")) {
		let valid = validateProse(value.text);
		if (!valid.ok) throw new Error(valid.message);
		result.text = valid.text;
	}
	if (!Object.hasOwn(value, "why")) return result;
	let why = draftedWhy(value.why);
	if (!why.ok) throw new Error(why.message);
	return { ...result, why: why.text };
}
