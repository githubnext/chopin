import { expect, test } from "bun:test";
import { validateDefinition, validateSnapshot } from "./controls";

let definition = {
	controls: [
		{ type: "number", id: "spacing", label: "Spacing", unit: "px", min: 0, max: 20, step: 2 },
		{ type: "color", id: "ink", label: "Ink" },
	],
	baseline: { spacing: 4, ink: "#123ABC" },
};

test("accepts a complete baseline and detaches retained definitions", () => {
	let input = structuredClone(definition);
	let result = validateDefinition(input);
	expect(result.ok).toBe(true);
	if (!result.ok) throw new Error(result.error.message);
	input.controls[0].id = "changed";
	input.baseline.spacing = 18;
	expect(result.value.controls[0].id).toBe("spacing");
	expect(result.value.baseline.spacing).toBe(4);
	expect(() => Object.assign(result.value.controls[0], { id: "changed" })).toThrow();
	expect(() => Object.assign(result.value.baseline, { spacing: 18 })).toThrow();
	expect(() => Object.assign(result.value.controls, { 0: { id: "changed" } })).toThrow();
});

test("rejects unsafe or duplicate IDs and malformed numeric definitions", () => {
	for (let id of ["__proto__", "constructor", "prototype", "hasOwnProperty", "a.b", "", "a b"]) {
		let input = structuredClone(definition);
		input.controls[0].id = id;
		expect(validateDefinition(input).ok).toBe(false);
	}
	let duplicate = structuredClone(definition);
	duplicate.controls[1].id = "spacing";
	expect(validateDefinition(duplicate).ok).toBe(false);
	for (let patch of [{ min: NaN }, { max: Infinity }, { step: 0 }, { step: -1 }, { min: 21 }]) {
		let input = structuredClone(definition);
		Object.assign(input.controls[0], patch);
		expect(validateDefinition(input).ok).toBe(false);
	}
});

test("requires exact complete values, finite aligned numbers and six-digit colours", () => {
	let result = validateDefinition(definition);
	if (!result.ok) throw new Error(result.error.message);
	for (
		let input of [
			{},
			{ spacing: 4 },
			{ ...definition.baseline, extra: 1 },
			...[-2, 22, 3, NaN, Infinity, "4"].map((spacing) => ({ spacing, ink: "#123ABC" })),
			...["red", "#fff", "#12345678", "#GGGGGG", 5].map((ink) => ({ spacing: 4, ink })),
		]
	) {
		expect(validateSnapshot(result.value, input).ok).toBe(false);
		expect(validateDefinition({ ...definition, baseline: input }).ok).toBe(false);
	}
	let other = validateDefinition({
		controls: [{
			type: "number",
			id: "opacity",
			label: "Opacity",
			unit: "",
			min: 0.1,
			max: 1,
			step: 0.1,
		}],
		baseline: { opacity: 0.3 },
	});
	expect(other.ok).toBe(true);
	if (!other.ok) throw new Error(other.error.message);
	let snapshot = validateSnapshot(other.value, { opacity: 0.7 });
	expect(snapshot.ok).toBe(true);
	if (!snapshot.ok) throw new Error(snapshot.error.message);
	expect(() => Object.assign(snapshot.value, { opacity: 0.2 })).toThrow();
});

test("rejects reserved IDs even when their baseline values exist", () => {
	for (let id of ["__proto__", "constructor", "prototype"]) {
		expect(
			validateDefinition({
				controls: [{ type: "color", id, label: "Colour" }],
				baseline: { [id]: "#123456" },
			}).ok,
		).toBe(false);
	}
});

test("rejects half-step values when the step count is large", () => {
	let result = validateDefinition({
		controls: [{
			type: "number",
			id: "distance",
			label: "Distance",
			unit: "m",
			min: 0,
			max: 1e9,
			step: 1e-6,
		}],
		baseline: { distance: 0 },
	});
	if (!result.ok) throw new Error(result.error.message);
	expect(validateSnapshot(result.value, { distance: 500000000.0000005 }).ok).toBe(false);
	expect(validateSnapshot(result.value, { distance: 500000000 }).ok).toBe(true);
});
