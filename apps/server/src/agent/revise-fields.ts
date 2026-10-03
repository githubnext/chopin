export type Option = { label: string; rationale: string };

export type Input = { revision: number; id: string; title?: string; add_options: Option[] };

export function input(raw: unknown): Input {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
		throw new Error("revise_open_decision arguments must be an object");
	}
	let value = raw as Record<string, unknown>;
	if (
		!Object.hasOwn(value, "revision") || !Object.hasOwn(value, "id")
		|| Object.keys(value).some(key => !["revision", "id", "title", "add_options"].includes(key))
	) throw new Error("revise_open_decision arguments are invalid");
	if (!Number.isSafeInteger(value.revision) || (value.revision as number) < 0) {
		throw new Error("revision must be a nonnegative integer");
	}
	if (typeof value.id !== "string" || !value.id) throw new Error("decision id is required");
	let title: string | undefined;
	if (Object.hasOwn(value, "title")) {
		title = typeof value.title === "string" ? value.title.trim() : "";
		if (!title || title.length > 80 || /[\r\n\u2028\u2029]/.test(value.title as string)) {
			throw new Error("title must be 1–80 characters on one line");
		}
	}
	let add_options: Option[] = [];
	if (Object.hasOwn(value, "add_options")) {
		if (!Array.isArray(value.add_options) || value.add_options.length > 10) {
			throw new Error("add_options must contain at most ten options");
		}
		for (let rawOption of value.add_options) {
			if (
				!rawOption || typeof rawOption !== "object" || Array.isArray(rawOption)
				|| Object.keys(rawOption).sort().join(",") !== "label,rationale"
			) throw new Error("each option needs a label and rationale");
			let option = rawOption as Record<string, unknown>;
			let label = typeof option.label === "string" ? option.label.trim() : "";
			let rationale = typeof option.rationale === "string" ? option.rationale.trim() : "";
			if (!label || label.length > 200 || /[\r\n\u2028\u2029]/.test(label)) {
				throw new Error("option label must be 1–200 characters on one line");
			}
			if (!rationale || rationale.length > 300) {
				throw new Error("option rationale must be 1–300 characters");
			}
			add_options.push({ label, rationale });
		}
	}
	if (!title && add_options.length === 0) throw new Error("title or add_options is required");
	if (title && Object.hasOwn(value, "add_options")) {
		throw new Error("revise_open_decision accepts one action per call; use separate calls");
	}
	return {
		revision: value.revision as number,
		id: value.id,
		...(title ? { title } : {}),
		add_options,
	};
}
