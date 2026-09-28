import { describe, expect, it } from "bun:test";

import { registerCredential } from "../harness/harnesses";
import { openWorkerSession, type WorkerSandbox } from "./worker-session";

function fixture() {
	let events: string[] = [];
	let sessionIds: string[] = [];
	let sandbox = {
		destroy: async () => void events.push("sandbox destroyed"),
	} as unknown as WorkerSandbox;
	let session = { destroy: async () => void events.push("session destroyed") };
	let released = (id: string) => {
		try {
			registerCredential(id, () => undefined)();
			return true;
		} catch {
			return false;
		}
	};
	return { events, sessionIds, sandbox, session, released };
}

function never(): Promise<never> {
	return new Promise<never>(() => {});
}

function abortable() {
	let { promise, reject } = Promise.withResolvers<never>();
	promise.catch(() => {});
	return { aborted: promise, abort: (reason: Error) => reject(reason) };
}

describe("openWorkerSession", () => {
	it("registers a credential for the session and closes session, sandbox, then credential", async () => {
		let { events, sessionIds, sandbox, session, released } = fixture();
		let worker = await openWorkerSession({
			async createSession(options) {
				sessionIds.push(options.sessionId);
				expect(options.sandboxSession).toBe(sandbox);
				return session;
			},
		}, {
			token: () => "token",
			maxAiCredits: 4,
			aborted: never(),
			openSandbox: async () => sandbox,
		});

		expect(worker.session).toBe(session);
		expect(released(sessionIds[0]!)).toBe(false);
		await worker.close();
		expect(events).toEqual(["session destroyed", "sandbox destroyed"]);
		expect(released(sessionIds[0]!)).toBe(true);
	});

	it("keeps closing after the session fails to destroy", async () => {
		let { events, sessionIds, sandbox, released } = fixture();
		let worker = await openWorkerSession({
			async createSession(options) {
				sessionIds.push(options.sessionId);
				return { destroy: async () => Promise.reject(new Error("session stuck")) };
			},
		}, {
			token: () => "token",
			maxAiCredits: 4,
			aborted: never(),
			openSandbox: async () => sandbox,
		});

		await expect(worker.close()).rejects.toThrow("session stuck");
		expect(events).toEqual(["sandbox destroyed"]);
		expect(released(sessionIds[0]!)).toBe(true);
	});

	it("tears down and rethrows the original error when the session fails to open", async () => {
		let { events, sessionIds, sandbox, released } = fixture();
		await expect(openWorkerSession({
			async createSession(options) {
				sessionIds.push(options.sessionId);
				throw new Error("harness unavailable");
			},
		}, {
			token: () => "token",
			maxAiCredits: 4,
			aborted: never(),
			openSandbox: async () => sandbox,
		})).rejects.toThrow("harness unavailable");

		expect(events).toEqual(["sandbox destroyed"]);
		expect(released(sessionIds[0]!)).toBe(true);
	});

	it("destroys a session that finishes opening after the worker aborted", async () => {
		let { events, sessionIds, sandbox, session, released } = fixture();
		let { aborted, abort } = abortable();
		let late = Promise.withResolvers<typeof session>();
		let opening = openWorkerSession({
			createSession(options) {
				sessionIds.push(options.sessionId);
				return late.promise;
			},
		}, { token: () => "token", maxAiCredits: 4, aborted, openSandbox: async () => sandbox });
		await Bun.sleep(0);
		abort(new Error("deadline"));

		await expect(opening).rejects.toThrow("deadline");
		expect(events).toEqual(["sandbox destroyed"]);
		expect(released(sessionIds[0]!)).toBe(true);
		late.resolve(session);
		await Bun.sleep(0);
		expect(events).toEqual(["sandbox destroyed", "session destroyed"]);
	});

	it("destroys a sandbox that finishes opening after the worker aborted", async () => {
		let { events, sandbox } = fixture();
		let { aborted, abort } = abortable();
		let late = Promise.withResolvers<WorkerSandbox>();
		let created = false;
		let opening = openWorkerSession({
			async createSession() {
				created = true;
				throw new Error("not reached");
			},
		}, { token: () => "token", maxAiCredits: 4, aborted, openSandbox: () => late.promise });
		abort(new Error("cancelled"));

		await expect(opening).rejects.toThrow("cancelled");
		late.resolve(sandbox);
		await Bun.sleep(0);
		expect(events).toEqual(["sandbox destroyed"]);
		expect(created).toBe(false);
	});

	it("opens and closes a real just-bash sandbox by default", async () => {
		let received: WorkerSandbox | undefined;
		let worker = await openWorkerSession({
			async createSession(options) {
				received = options.sandboxSession;
				return { destroy: async () => {} };
			},
		}, { token: () => "token", maxAiCredits: 4, aborted: never() });

		expect(received?.defaultWorkingDirectory).toBeString();
		await worker.close();
	});
});
