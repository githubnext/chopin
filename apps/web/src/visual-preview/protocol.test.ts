import { expect, test } from "bun:test";
import { acceptFrameMessage, controlsValid, messageValid, valuesValid } from "./protocol";

let controls = [
	{ type: "number" as const, id: "radius", label: "Radius", unit: "px", min: 2, max: 14, step: 3 },
	{ type: "color" as const, id: "accent", label: "Accent" },
];
let values = { radius: 8, accent: "#aBc123" };
let source = {} as MessageEventSource;
let current = {
	version: 1 as const,
	session: "0123456789abcdef0123456789abcdef",
	revision: 7,
	definitionRevision: "rev-a",
	values,
	controls,
	source,
};

test("complete generic snapshots use each control's bounds and min-relative grid", () => {
	expect(controlsValid(controls)).toBe(true);
	expect(valuesValid(controls, values)).toBe(true);
	for (
		let invalid of [
			{ radius: 7, accent: "#abc123" },
			{ radius: 8, accent: "red" },
			{ radius: 8 },
			{ radius: 8, accent: "#abc123", secret: "x" },
		]
	) expect(valuesValid(controls, invalid)).toBe(false);
	expect(controlsValid([{ ...controls[0], id: "__proto__" }])).toBe(false);
	expect(controlsValid([{ ...controls[0], id: "radius" }, controls[1], controls[0]])).toBe(
		false,
	);
});

test("only the current opaque frame can acknowledge its complete parameters", () => {
	let reply = {
		version: current.version,
		session: current.session,
		revision: current.revision,
		definitionRevision: current.definitionRevision,
		values,
		type: "ack" as const,
	};
	let event = { source, origin: "null", data: reply };
	expect(acceptFrameMessage(event, current)).toEqual(reply);
	for (
		let change of [
			{ source: {} as MessageEventSource },
			{ origin: "https://preview.example" },
			{ data: { ...reply, session: "old0123456789abcdef" } },
			{ data: { ...reply, revision: 6 } },
			{ data: { ...reply, definitionRevision: "rev-b" } },
			{ data: { ...reply, values: { ...values, accent: "#000000" } } },
			{ data: { ...reply, values: { ...values, extra: 1 } } },
			{ data: { ...reply, extra: "x" } },
		]
	) expect(acceptFrameMessage({ ...event, ...change }, current)).toBeUndefined();
});

test("init carries validated controls; set cannot redefine them", () => {
	let init = {
		version: 1,
		session: current.session,
		revision: 0,
		definitionRevision: current.definitionRevision,
		values,
		controls,
		baseline: { radius: 2, accent: "#FFFFFF" },
		type: "init",
	};
	expect(messageValid(init, "parent")).toBe(true);
	expect(messageValid({ ...init, baseline: { radius: 3, accent: "#FFFFFF" } }, "parent"))
		.toBe(false);
	expect(messageValid({ ...init, revision: 1 }, "parent")).toBe(false);
	let { controls: _controls, baseline: _baseline, ...set } = init;
	expect(messageValid({ ...set, revision: 1, type: "set" }, "parent", controls)).toBe(true);
	expect(messageValid({ ...init, revision: 1, type: "set" }, "parent", controls)).toBe(false);
});
