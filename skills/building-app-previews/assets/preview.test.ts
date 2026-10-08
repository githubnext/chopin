import { expect, test } from "bun:test";
import { createPreview } from "./preview";
import type { Snapshot } from "./controls";

let definition = {
	controls: [{
		type: "number" as const,
		id: "radius",
		label: "Radius",
		unit: "px",
		min: 0,
		max: 10,
		step: 1,
	}],
	baseline: { radius: 2 },
};

test("renders validated detached snapshots and resets to the retained baseline", async () => {
	let rendered: Snapshot[] = [];
	let input = structuredClone(definition);
	let result = createPreview(input, (values) => {
		rendered.push(values);
	});
	if (!result.ok) throw new Error(result.error.message);
	expect(rendered).toEqual([]);
	input.baseline.radius = 9;
	input.controls[0].max = 1;
	expect((await result.value.apply({ radius: 20 })).ok).toBe(false);
	expect(rendered).toEqual([]);
	let snapshot = { radius: 5 };
	let applied = result.value.apply(snapshot);
	snapshot.radius = 9;
	expect(await applied).toEqual({ ok: true, value: { radius: 5 } });
	expect(await result.value.reset()).toEqual({ ok: true, value: { radius: 2 } });
	expect(rendered).toEqual([{ radius: 5 }, { radius: 2 }]);
	expect(() => Object.assign(rendered[0], { radius: 7 })).toThrow();
	expect(createPreview({ ...definition, baseline: {} }, () => {}).ok).toBe(false);
});

test("reports renderer failures and permits retry", async () => {
	let fail = true;
	let result = createPreview(definition, async () => {
		if (fail) throw new Error("Renderer unavailable");
	});
	if (!result.ok) throw new Error(result.error.message);
	expect(await result.value.apply({ radius: 4 })).toEqual({
		ok: false,
		error: { code: "render", message: "Renderer unavailable" },
	});
	fail = false;
	expect((await result.value.apply({ radius: 4 })).ok).toBe(true);
});

test("serializes overlapping renders so the newer request finishes last", async () => {
	let release!: () => void;
	let gate = new Promise<void>((resolve) => {
		release = resolve;
	});
	let rendered: number[] = [];
	let started!: () => void;
	let ready = new Promise<void>((resolve) => {
		started = resolve;
	});
	let result = createPreview(definition, async (values) => {
		if (values.radius === 3) {
			started();
			await gate;
		}
		rendered.push(values.radius as number);
	});
	if (!result.ok) throw new Error(result.error.message);
	let first = result.value.apply({ radius: 3 });
	let second = result.value.apply({ radius: 7 });
	await ready;
	expect(rendered).toEqual([]);
	release();
	await Promise.all([first, second]);
	expect(rendered).toEqual([3, 7]);
});

test("reports synchronous non-Error failures without poisoning reset", async () => {
	let fail = true;
	let result = createPreview(definition, () => {
		if (fail) throw "failed";
	});
	if (!result.ok) throw new Error(result.error.message);
	expect(await result.value.apply({ radius: 1 })).toEqual({
		ok: false,
		error: { code: "render", message: "Renderer failed." },
	});
	fail = false;
	expect(await result.value.reset()).toEqual({ ok: true, value: { radius: 2 } });
});
