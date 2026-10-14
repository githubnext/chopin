import { afterEach, expect, test } from "bun:test";
import { experimentRequest } from "./api";

let original = globalThis.fetch;
afterEach(() => {
	globalThis.fetch = original;
});

function answer(status: number, value: unknown) {
	globalThis.fetch = (async () => Response.json(value, { status })) as unknown as typeof fetch;
}

test("a refused Run says the server's sentence about the person's machine choice", async () => {
	let unreadable = "Can't read your machine choice right now. Try again.";
	answer(503, { error: "machine-choice-unavailable", message: unreadable });
	await expect(experimentRequest("/run", {})).rejects.toThrow(unreadable);
	let offline = "build-box is offline. Start chopin connect on it, or choose another machine.";
	answer(409, { error: "machine-offline", message: offline });
	await expect(experimentRequest("/run", {})).rejects.toThrow(offline);
	// Other refusals keep their code, which the card turns into copy.
	answer(409, { error: "workspace-busy" });
	await expect(experimentRequest("/run", {})).rejects.toThrow("workspace-busy");
});
