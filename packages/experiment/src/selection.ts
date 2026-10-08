import { z } from "zod";
import { canonical, ExperimentError, scalarSchema } from "./index";
import type { Dataset, SelectionPatch, ViewState } from "./index";

export const selectionPatchSchema = z.object({
	mutationId: z.string().uuid(),
	expected: z.record(z.string().max(100), z.number().int().nonnegative()),
	set: z.record(z.string().max(100), z.array(scalarSchema).max(50)),
}).strict();

export function applySelection(state: ViewState, dataset: Dataset, raw: SelectionPatch): ViewState {
	let patch = selectionPatchSchema.parse(raw);
	let keys = Object.keys(patch.set);
	if (!keys.length || keys.length > 9 || keys.length !== Object.keys(patch.expected).length) {
		throw new ExperimentError(
			"invalid-selection",
			"Expected revisions are required for each changed field.",
		);
	}
	let result = structuredClone(state);
	let changed = false;
	for (let key of keys) {
		if (!Object.hasOwn(state.fields, key) || !Object.hasOwn(patch.expected, key)) {
			throw new ExperimentError("invalid-selection", "Unknown selection field.");
		}
		if (state.fields[key].revision !== patch.expected[key]) {
			throw new ExperimentError(
				"selection-conflict",
				"A collaborator changed this selection. Review the current value.",
			);
		}
		let values = patch.set[key];
		let allowed = key === "selection"
			? dataset.rows.map(row => row.key)
			: dataset.rows.map(row => row.values[key.slice(7)]);
		if (
			key === "selection" && values.length > 1 || values.some(value => !allowed.includes(value))
			|| new Set(values.map(value => canonical(value))).size !== values.length
		) {
			throw new ExperimentError(
				"invalid-selection",
				"Selection must refer to captured observations.",
			);
		}
		if (canonical(values) !== canonical(state.fields[key].values)) {
			result.fields[key] = { revision: state.fields[key].revision + 1, values };
			changed = true;
		}
	}
	if (changed) result.revision++;
	return result;
}
