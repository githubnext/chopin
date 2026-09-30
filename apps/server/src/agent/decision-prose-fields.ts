import { validateProse } from "../questions/write-prose";

export function input(raw: unknown): { revision: number; id: string; text: string } {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
		throw new Error("write_decision_prose arguments must be an object");
	}
	let value = raw as Record<string, unknown>;
	if (
		Object.keys(value).sort().join(",") !== "id,revision,text"
		|| !Number.isSafeInteger(value.revision) || (value.revision as number) < 0
		|| typeof value.id !== "string" || !value.id || value.id.length > 200
	) throw new Error("write_decision_prose needs revision, id, and text");
	let valid = validateProse(value.text);
	if (!valid.ok) throw new Error(valid.message);
	return { revision: value.revision as number, id: value.id, text: valid.text };
}
