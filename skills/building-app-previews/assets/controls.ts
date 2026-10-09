export type Control =
	| Readonly<{
		type: "number";
		id: string;
		label: string;
		unit: string;
		min: number;
		max: number;
		step: number;
	}>
	| Readonly<{ type: "color"; id: string; label: string }>;

export type Snapshot = Readonly<Record<string, number | string>>;
export type PreviewDefinition = Readonly<{
	controls: readonly Control[];
	baseline: Snapshot;
}>;
export type Result<T> =
	| { ok: true; value: T }
	| { ok: false; error: { code: "definition" | "snapshot" | "render"; message: string } };

export function validateDefinition(input: unknown): Result<PreviewDefinition> {
	let candidate = input as PreviewDefinition;
	if (!candidate || !Array.isArray(candidate.controls)) {
		return { ok: false, error: { code: "definition", message: "Controls must be an array." } };
	}
	let ids = new Set<string>();
	for (let control of candidate.controls) {
		if (
			!control || typeof control.id !== "string"
			|| !/^[A-Za-z][A-Za-z0-9_-]*$/.test(control.id)
			|| Object.hasOwn(Object.prototype, control.id) || control.id === "prototype"
			|| ids.has(control.id)
			|| typeof control.label !== "string" || !control.label.trim()
			|| (control.type !== "number" && control.type !== "color")
		) {
			return { ok: false, error: { code: "definition", message: "Invalid or duplicate control." } };
		}
		if (
			control.type === "number" && (
				typeof control.unit !== "string"
				|| ![control.min, control.max, control.step].every(Number.isFinite)
				|| control.min > control.max || control.step <= 0
			)
		) {
			return {
				ok: false,
				error: { code: "definition", message: `Invalid numeric bounds for ${control.id}.` },
			};
		}
		ids.add(control.id);
	}
	let controls = candidate.controls.map((control): Control =>
		Object.freeze(
			control.type === "number"
				? {
					type: control.type,
					id: control.id,
					label: control.label,
					unit: control.unit,
					min: control.min,
					max: control.max,
					step: control.step,
				}
				: { type: control.type, id: control.id, label: control.label },
		)
	);
	let definition = { controls: Object.freeze(controls), baseline: candidate.baseline };
	let baseline = validateSnapshot(definition, candidate.baseline);
	if (!baseline.ok) return { ok: false, error: { ...baseline.error, code: "definition" } };
	return { ok: true, value: Object.freeze({ ...definition, baseline: baseline.value }) };
}

export function validateSnapshot(definition: PreviewDefinition, input: unknown): Result<Snapshot> {
	if (!input || typeof input !== "object" || Array.isArray(input)) {
		return { ok: false, error: { code: "snapshot", message: "Values must be an object." } };
	}
	let values = { ...input } as Record<string, number | string>;
	let ids = new Set(definition.controls.map((control) => control.id));
	if (
		Reflect.ownKeys(input).length !== ids.size || Object.keys(values).some((id) => !ids.has(id))
	) {
		return {
			ok: false,
			error: { code: "snapshot", message: "Supply exactly one value per control." },
		};
	}
	for (let control of definition.controls) {
		let value = values[control.id];
		// Include the minimum's magnitude for cancellation when subtracting nearby decimals.
		// Cap tolerance in step units so large ranges cannot admit fractional steps.
		let valid = control.type === "color"
			? typeof value === "string" && /^#[0-9a-f]{6}$/i.test(value)
			: typeof value === "number" && Number.isFinite(value)
				&& value >= control.min && value <= control.max
				&& Math.abs(
						(value - control.min) / control.step - Math.round((value - control.min) / control.step),
					)
					<= Math.min(
						1e-7,
						Number.EPSILON * 8 * Math.max(
							1,
							Math.abs((value - control.min) / control.step),
							Math.abs(control.min / control.step),
						),
					);
		if (!Object.hasOwn(values, control.id) || !valid) {
			return {
				ok: false,
				error: { code: "snapshot", message: `Invalid value for ${control.id}.` },
			};
		}
	}
	Object.freeze(values);
	return { ok: true, value: values };
}
