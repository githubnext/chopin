import { expect, test } from "bun:test";
import { implementationResponse } from "./build-start";

function refused(error: string, status: number, message?: string) {
	return implementationResponse(
		new Response(JSON.stringify({ error, ...(message ? { message } : {}) }), { status }),
	);
}

test("a refused Build says the server's sentence about the person's machine choice", async () => {
	await expect(refused("machine-offline", 409, "build-box is offline. Start chopin connect on it."))
		.rejects.toThrow("build-box is offline. Start chopin connect on it.");
	let unreadable = "Can't read your machine choice right now. Try again.";
	await expect(refused("machine-choice-unavailable", 503, unreadable)).rejects.toThrow(unreadable);
	// Other refusals keep their code, which the Build plan button turns into copy.
	await expect(refused("no-workspace", 409)).rejects.toThrow("no-workspace");
});
