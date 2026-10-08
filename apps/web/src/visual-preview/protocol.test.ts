import { expect, test } from "bun:test";
import { acceptFrameMessage, messageValid } from "./protocol";

let source = {} as MessageEventSource;
let current = {
	version: 1 as const,
	session: "0123456789abcdef0123456789abcdef",
	revision: 7,
	values: { optionPadding: 8 as const, selectedColor: "#123456" },
	source,
};
let reply = {
	version: current.version,
	session: current.session,
	revision: current.revision,
	values: current.values,
	type: "size" as const,
	height: 501,
};

test("only the current opaque frame can acknowledge its current parameters", () => {
	let event = { source, origin: "null", data: reply };
	expect(acceptFrameMessage(event, current)).toEqual(reply);
	for (let change of [
		{ source: {} as MessageEventSource },
		{ origin: "http://localhost:8793" },
		{ data: { ...reply, session: "old0123456789abcdef" } },
		{ data: { ...reply, revision: 6 } },
		{ data: { ...reply, values: { ...reply.values, optionPadding: 6 } } },
		{ data: { ...reply, height: 4097 } },
		{ data: { ...reply, extra: "ignored?" } },
		{ data: "x".repeat(1_000_000) },
	]) expect(acceptFrameMessage({ ...event, ...change }, current)).toBeUndefined();
});

test("parent messages accept only bounded known control values", () => {
	let { height: _height, ...message } = reply;
	let input = { ...message, type: "init" };
	expect(messageValid(input, "parent")).toBe(true);
	for (let values of [
		{ optionPadding: 5, selectedColor: "#123456" },
		{ optionPadding: 6, selectedColor: "red" },
		{ optionPadding: 6, selectedColor: "#123456", secret: "token" },
	]) expect(messageValid({ ...input, values }, "parent")).toBe(false);
	expect(messageValid({ ...input, revision: -1 }, "parent")).toBe(false);
});
