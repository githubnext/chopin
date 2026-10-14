import { expect, it } from "bun:test";
import { agendaModelCall } from "./model-call";
import type { AgendaCredential } from "./assessor";

function credential(authorize: () => Promise<boolean>): AgendaCredential {
	return {
		owner: {
			userId: "member",
			userHandle: "member",
			sessionId: "session",
			generation: 1,
			credentialRevision: 1,
		},
		token: () => "token",
		signal: new AbortController().signal,
		authorize,
		release: () => {},
	};
}

it("abort interrupts the initial authorization without opening a model session or an unhandled rejection", async () => {
	let controller = new AbortController();
	let authorization = Promise.withResolvers<boolean>();
	let opened = false;
	let result = agendaModelCall(
		credential(() => authorization.promise),
		controller.signal,
		async () => {
			opened = true;
		},
	);
	let settled = result.then(value => ({ value }), error => ({ error }));
	controller.abort();
	expect((await settled as { error: Error }).error.message).toBe("agenda model interrupted");
	expect(opened).toBe(false);
	authorization.resolve(true);
});

it("abort interrupts final revalidation and prevents acceptance of the model output", async () => {
	let controller = new AbortController();
	let finalCheck = Promise.withResolvers<void>();
	let authorization = Promise.withResolvers<boolean>();
	let calls = 0;
	let owner = credential(async () => {
		if (++calls === 1) return true;
		finalCheck.resolve();
		return authorization.promise;
	});
	let result = agendaModelCall(owner, controller.signal, async () => "model output");
	let settled = result.then(value => ({ value }), error => ({ error }));
	await finalCheck.promise;
	controller.abort();
	expect((await settled as { error: Error }).error.message).toBe("agenda model interrupted");
	authorization.resolve(true);
});
