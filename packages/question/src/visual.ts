import type { VisualDecision } from "@chopin/protocol";

function object(raw: unknown): Record<string, unknown> {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
		throw new Error("Invalid visual decision");
	}
	return raw as Record<string, unknown>;
}

function keys(raw: Record<string, unknown>, allowed: string[], required = allowed): void {
	if (
		Object.keys(raw).some(key => !allowed.includes(key))
		|| required.some(key => !Object.hasOwn(raw, key))
	) {
		throw new Error("Invalid visual decision fields");
	}
}

export function patch(raw: unknown): Partial<VisualDecision.Values> {
	let candidate = object(raw);
	keys(candidate, ["optionPadding", "selectedColor"], []);
	if (!Object.keys(candidate).length) throw new Error("Choose a visual control");
	let result: Partial<VisualDecision.Values> = {};
	if (Object.hasOwn(candidate, "optionPadding")) {
		if (![4, 6, 8].includes(candidate.optionPadding as number)) {
			throw new Error("Choose 4, 6, or 8 px padding");
		}
		result.optionPadding = candidate.optionPadding as VisualDecision.Values["optionPadding"];
	}
	if (Object.hasOwn(candidate, "selectedColor")) {
		if (
			typeof candidate.selectedColor !== "string"
			|| !/^#[0-9a-fA-F]{6}$/.test(candidate.selectedColor)
		) {
			throw new Error("Choose a colour in #RRGGBB format");
		}
		result.selectedColor = candidate.selectedColor.toUpperCase();
	}
	return result;
}

export function values(raw: unknown): VisualDecision.Values {
	let candidate = object(raw);
	keys(candidate, ["optionPadding", "selectedColor"]);
	return patch(candidate) as VisualDecision.Values;
}

export function apply(current: VisualDecision.Values, raw: unknown): VisualDecision.Values {
	return { ...current, ...patch(raw) };
}

export function definition(raw: unknown): VisualDecision.Definition {
	let candidate = object(raw);
	keys(candidate, ["specimen", "bundleDigest", "baseline", "controls"]);
	let controls: VisualDecision.Definition["controls"] = [
		{ id: "optionPadding", type: "number", min: 4, max: 8, step: 2 },
		{ id: "selectedColor", type: "color", format: "#RRGGBB" },
	];
	if (
		candidate.specimen !== "decision-card-v1" || typeof candidate.bundleDigest !== "string"
		|| !/^sha256:[0-9a-f]{64}$/.test(candidate.bundleDigest)
		|| !Array.isArray(candidate.controls) || candidate.controls.length !== controls.length
	) throw new Error("Invalid visual specimen");
	for (let [index, expected] of controls.entries()) {
		let actual = object(candidate.controls[index]);
		keys(actual, Object.keys(expected));
		if (Object.entries(expected).some(([key, value]) => actual[key] !== value)) {
			throw new Error("Invalid visual control definition");
		}
	}
	return {
		specimen: "decision-card-v1",
		bundleDigest: candidate.bundleDigest,
		baseline: values(candidate.baseline),
		controls,
	};
}

export function revision(raw: unknown): number {
	if (typeof raw !== "number" || !Number.isSafeInteger(raw) || raw < 0) {
		throw new Error("Invalid visual revision");
	}
	return raw;
}

export function id(raw: unknown): string {
	if (typeof raw !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(raw)) {
		throw new Error("Invalid visual decision id");
	}
	return raw;
}

export function state(raw: unknown): VisualDecision.State {
	let candidate = object(raw);
	keys(candidate, ["id", "definition", "revision", "values", "saved"], [
		"id",
		"definition",
		"revision",
		"values",
	]);
	let result: VisualDecision.State = {
		id: id(candidate.id),
		definition: definition(candidate.definition),
		revision: revision(candidate.revision),
		values: values(candidate.values),
	};
	if (Object.hasOwn(candidate, "saved")) {
		let saved = object(candidate.saved);
		keys(saved, ["revision", "values", "by", "at"]);
		if (
			revision(saved.revision) !== result.revision
			|| JSON.stringify(values(saved.values)) !== JSON.stringify(result.values)
			|| typeof saved.by !== "string" || !/^[A-Za-z0-9_-]{1,100}$/.test(saved.by)
			|| typeof saved.at !== "string" || !Number.isFinite(Date.parse(saved.at))
		) throw new Error("Invalid saved visual decision");
		result.saved = {
			revision: result.revision,
			values: { ...result.values },
			by: saved.by,
			at: saved.at,
		};
	}
	return result;
}

export function summary(chosen: VisualDecision.Values): string {
	return `Option vertical padding: ${chosen.optionPadding} px; selected-option colour: ${chosen.selectedColor}`;
}
