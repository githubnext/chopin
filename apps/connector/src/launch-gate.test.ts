import { expect, test } from "bun:test";
import { launchGate, startCap } from "./launch-gate";

/** Resolves once the promises queued so far have run. */
let settle = () => new Promise(resolve => setTimeout(resolve, 0));

test("as many launches boot at once as the cap, the rest wait in the order they asked, and a slot goes on the moment it frees", async () => {
	let gate = launchGate(2);
	let order: string[] = [];
	let take = (name: string) =>
		gate.acquire("document").then(release => {
			order.push(name);
			return release;
		});
	let [a, b] = await Promise.all([take("a"), take("b")]);
	let c = take("c");
	let d = take("d");
	let e = take("e");
	await settle();
	expect(order).toEqual(["a", "b"]);
	expect(gate.counts()).toEqual({ held: 2, documents: 3, spares: 0 });
	b!();
	// Released twice, a slot is still one slot.
	b!();
	await settle();
	expect(order).toEqual(["a", "b", "c"]);
	a!();
	await settle();
	expect(order).toEqual(["a", "b", "c", "d"]);
	(await c)();
	(await d)();
	(await e)();
	expect(gate.counts()).toEqual({ held: 0, documents: 0, spares: 0 });
});

test("a spare boots only while no document waits, and a waiter that gives up leaves its place", async () => {
	let gate = launchGate(1);
	let order: string[] = [];
	let held = await gate.acquire("document");
	let spare = gate.acquire("spare").then(release => {
		order.push("spare");
		return release;
	});
	let quitting = new AbortController();
	let quit = gate.acquire("document", quitting.signal);
	let document = gate.acquire("document").then(release => {
		order.push("document");
		return release;
	});
	quitting.abort(new Error("stopped"));
	await expect(quit).rejects.toThrow("stopped");
	held();
	await settle();
	// The document asked after the spare, and still boots first.
	expect(order).toEqual(["document"]);
	(await document)();
	await settle();
	expect(order).toEqual(["document", "spare"]);
	(await spare)();
	expect(gate.counts()).toEqual({ held: 0, documents: 0, spares: 0 });
	// One asked for after its signal ended never gets a slot.
	let ended = new AbortController();
	ended.abort(new Error("gone"));
	await expect(gate.acquire("spare", ended.signal)).rejects.toThrow("gone");
	expect(gate.counts().held).toBe(0);
});

test("the cap is half the machine's processors, at least 2 and at most 8", () => {
	expect(startCap(1)).toBe(2);
	expect(startCap(4)).toBe(2);
	expect(startCap(12)).toBe(6);
	expect(startCap(80)).toBe(8);
});

test("a spare boots only once no document is on its way to boot, even with slots free, so a burst's cold starts never share the machine with its refill", async () => {
	let gate = launchGate(4);
	let order: string[] = [];
	let coming = gate.coming();
	let spare = gate.acquire("spare").then(release => {
		order.push("spare");
		return release;
	});
	await settle();
	// A document is fetching its checkout: the spare waits though every slot is free.
	expect(order).toEqual([]);
	expect(gate.counts()).toEqual({ held: 0, documents: 0, spares: 1 });
	let document = await gate.acquire("document");
	await settle();
	expect(order).toEqual([]);
	// It booted: nothing is on its way any more.
	document();
	coming();
	coming();
	await settle();
	expect(order).toEqual(["spare"]);
	(await spare)();
	expect(gate.counts()).toEqual({ held: 0, documents: 0, spares: 0 });
});
