import { installJobCleanup } from "./job.test-fixtures";
import { expect, test } from "bun:test";
import * as Chat from "./service";
import { harness, JOB, member, socket, until } from "./job.test-fixtures";

installJobCleanup();

test("a queue handoff persist failure settles the shifted job", async () => {
	let state = harness();
	let commits = 0;
	state.context.persist = async () => {
		commits++;
		if (commits === 3) throw new Error("handoff unavailable");
	};
	await Chat.send(state.context, socket(), member("Human first"));
	await until(() => state.prompts.length === 1);
	let queued = Chat.job(state.context, JOB, "later", "session");
	state.emit("session.idle");
	expect(await queued).toEqual({ status: "failed", reason: "handoff unavailable" });
	expect(state.prompts).toHaveLength(1);
	expect(state.chat.busy).toBe(false);
	expect(state.chat.waiting).toEqual([]);
});

test("closing during queue handoff settles a job already removed from waiting", async () => {
	let state = harness();
	let commits = 0;
	let entered = Promise.withResolvers<void>();
	let release = Promise.withResolvers<void>();
	state.context.persist = async () => {
		commits++;
		if (commits === 3) {
			entered.resolve();
			await release.promise;
		}
	};
	await Chat.send(state.context, socket(), member("Human first"));
	await until(() => state.prompts.length === 1);
	let queued = Chat.job(state.context, JOB, "later", "session");
	state.emit("session.idle");
	await entered.promise;
	expect(state.chat.waiting).toEqual([]);
	let closing = Chat.close(state.chat);
	release.resolve();
	await closing;
	expect(await queued).toEqual({ status: "failed", reason: "The document closed." });
});
