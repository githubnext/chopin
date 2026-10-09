import { createHash } from "node:crypto";
import type { VisualDecision } from "@chopin/protocol";

/** Canonical definition identity shared by publication and durable restoration. */
export function revisionDigest(
	input: Omit<VisualDecision.Definition, "definitionRevision">,
): string {
	let controls = input.controls.map(control =>
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
			: { type: control.type, id: control.id, label: control.label }
	);
	let baseline = Object.fromEntries(input.controls.map(control => {
		let value = input.baseline[control.id];
		return [
			control.id,
			control.type === "color" && typeof value === "string"
				? value.toUpperCase()
				: value,
		];
	}));
	let canonical = JSON.stringify({
		schema: input.schema,
		title: input.title,
		requestId: input.requestId,
		artifact: { ref: input.artifact.ref, digest: input.artifact.digest },
		controls,
		baseline,
	});
	return `sha256:${createHash("sha256").update(canonical).digest("hex")}`;
}
