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
	) throw new Error("Invalid visual decision fields");
}

function text(raw: unknown, name: string, max: number): string {
	if (typeof raw !== "string" || !raw.trim() || raw.length > max) {
		throw new Error(`Invalid visual ${name}`);
	}
	return raw;
}

export function id(raw: unknown): string {
	if (typeof raw !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(raw)) {
		throw new Error("Invalid visual decision id");
	}
	return raw;
}

export function revision(raw: unknown): number {
	if (typeof raw !== "number" || !Number.isSafeInteger(raw) || raw < 0) {
		throw new Error("Invalid visual revision");
	}
	return raw;
}

export function digest(raw: unknown): string {
	if (typeof raw !== "string" || !/^sha256:[0-9a-f]{64}$/.test(raw)) {
		throw new Error("Invalid visual digest");
	}
	return raw;
}

export function definition(raw: unknown): VisualDecision.Definition {
	let candidate = object(raw);
	keys(candidate, [
		"schema",
		"title",
		"requestId",
		"artifact",
		"definitionRevision",
		"controls",
		"baseline",
	]);
	if (candidate.schema !== "visual-decision@1") throw new Error("Invalid visual schema");
	let artifact = object(candidate.artifact);
	keys(artifact, ["ref", "digest"]);
	if (typeof artifact.ref !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(artifact.ref)) {
		throw new Error("Invalid visual artifact reference");
	}
	if (
		!Array.isArray(candidate.controls) || candidate.controls.length < 1
		|| candidate.controls.length > 8
	) throw new Error("Choose 1–8 visual controls");
	let controls: VisualDecision.Control[] = [];
	let ids = new Set<string>();
	for (let input of candidate.controls) {
		let control = object(input);
		let common = ["type", "id", "label"];
		if (
			typeof control.id !== "string" || !/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(control.id)
			|| Object.hasOwn(Object.prototype, control.id) || control.id === "prototype"
			|| ids.has(control.id)
		) throw new Error("Invalid or duplicate visual control id");
		ids.add(control.id);
		let label = text(control.label, "control label", 100);
		if (control.type === "number") {
			keys(control, [...common, "unit", "min", "max", "step"]);
			if (
				typeof control.unit !== "string" || control.unit.length > 24
				|| ![control.min, control.max, control.step].every(Number.isFinite)
				|| (control.min as number) > (control.max as number)
				|| (control.step as number) <= 0
			) throw new Error(`Invalid numeric control ${control.id}`);
			controls.push({
				type: "number",
				id: control.id,
				label,
				unit: control.unit,
				min: control.min as number,
				max: control.max as number,
				step: control.step as number,
			});
		} else if (control.type === "color") {
			keys(control, common);
			controls.push({ type: "color", id: control.id, label });
		} else throw new Error("Invalid visual control type");
	}
	let result: VisualDecision.Definition = {
		schema: "visual-decision@1",
		title: text(candidate.title, "title", 160),
		requestId: id(candidate.requestId),
		artifact: { ref: artifact.ref, digest: digest(artifact.digest) },
		definitionRevision: digest(candidate.definitionRevision),
		controls,
		baseline: {},
	};
	result.baseline = values(result, candidate.baseline);
	return result;
}

function checked(control: VisualDecision.Control, value: unknown): number | string {
	if (control.type === "color") {
		if (typeof value !== "string" || !/^#[0-9a-f]{6}$/i.test(value)) {
			throw new Error(`Invalid value for ${control.id}`);
		}
		return value.toUpperCase();
	}
	let steps = (value as number - control.min) / control.step;
	let tolerance = Math.min(
		1e-7,
		Number.EPSILON * 8 * Math.max(1, Math.abs(steps)),
	);
	if (
		typeof value !== "number" || !Number.isFinite(value)
		|| value < control.min || value > control.max
		|| Math.abs(steps - Math.round(steps)) > tolerance
	) throw new Error(`Invalid value for ${control.id}`);
	return value;
}

export function patch(definition: VisualDecision.Definition, raw: unknown): VisualDecision.Values {
	let candidate = object(raw);
	let controls = new Map(definition.controls.map(control => [control.id, control]));
	if (!Object.keys(candidate).length || Object.keys(candidate).some(key => !controls.has(key))) {
		throw new Error("Invalid visual control patch");
	}
	let result: VisualDecision.Values = {};
	for (let [key, value] of Object.entries(candidate)) {
		result[key] = checked(controls.get(key)!, value);
	}
	return result;
}

export function values(definition: VisualDecision.Definition, raw: unknown): VisualDecision.Values {
	let candidate = object(raw);
	if (
		Object.keys(candidate).length !== definition.controls.length
		|| definition.controls.some(control => !Object.hasOwn(candidate, control.id))
	) throw new Error("Supply exactly one value per visual control");
	let result: VisualDecision.Values = {};
	for (let control of definition.controls) {
		result[control.id] = checked(control, candidate[control.id]);
	}
	return result;
}

export function apply(
	definition: VisualDecision.Definition,
	current: VisualDecision.Values,
	raw: unknown,
): VisualDecision.Values {
	return values(definition, { ...current, ...patch(definition, raw) });
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
		values: {},
	};
	result.values = values(result.definition, candidate.values);
	if (Object.hasOwn(candidate, "saved")) {
		let saved = object(candidate.saved);
		keys(saved, [
			"decisionId",
			"requestId",
			"definitionRevision",
			"artifactDigest",
			"revision",
			"values",
			"by",
			"at",
		]);
		let savedValues = values(result.definition, saved.values);
		if (
			saved.decisionId !== result.id
			|| saved.requestId !== result.definition.requestId
			|| saved.definitionRevision !== result.definition.definitionRevision
			|| saved.artifactDigest !== result.definition.artifact.digest
			|| revision(saved.revision) !== result.revision
			|| JSON.stringify(savedValues) !== JSON.stringify(result.values)
			|| typeof saved.by !== "string" || !/^[A-Za-z0-9_-]{1,100}$/.test(saved.by)
			|| typeof saved.at !== "string" || !Number.isFinite(Date.parse(saved.at))
		) throw new Error("Invalid saved visual decision");
		result.saved = {
			decisionId: result.id,
			requestId: result.definition.requestId,
			definitionRevision: result.definition.definitionRevision,
			artifactDigest: result.definition.artifact.digest,
			revision: result.revision,
			values: savedValues,
			by: saved.by,
			at: saved.at,
		};
	}
	return result;
}

export function summary(
	definition: VisualDecision.Definition,
	chosen: VisualDecision.Values,
): string {
	let values = definition.controls.map(control => {
		let unit = control.type === "number" ? control.unit : "";
		return `${control.label}: ${chosen[control.id]}${unit}`;
	});
	return values.join("; ");
}
