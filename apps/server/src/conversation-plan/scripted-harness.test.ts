import { expect, test } from "bun:test";
import { headingJob, scriptedHeading } from "../chat/job-scripted-harness.test-fixtures";
import type { HarnessV1StreamPart } from "@ai-sdk/harness";

test("the scripted model contract drains an admitted result before destruction", async () => {
	let h = await scriptedHeading([{ tool: "draft_heading", args: {} }]);
	let entered = Promise.withResolvers<void>();
	let release = Promise.withResolvers<void>();
	let controller = new AbortController();
	let session: Awaited<ReturnType<typeof h.driver.fake.doStart>> | undefined;
	let observerFinished = false;
	let destroyed = false;
	let done = false;
	let parts: HarnessV1StreamPart[] = [];
	try {
		h.opened.plan.chat.job = headingJob();
		h.opened.plan.chat.turn = {
			id: "contract-turn",
			handle: "chopin",
			started: 1,
			responded: false,
		};
		h.onResult(async () => {
			entered.resolve();
			await release.promise;
			observerFinished = true;
		});
		session = await h.driver.fake.doStart({ sessionId: "contract-session" } as never);
		let prompt = await session.doPromptTurn({
			tools: [],
			abortSignal: controller.signal,
			emit: (part: HarnessV1StreamPart) => parts.push(part),
		} as never);
		void prompt.done.then(() => {
			done = true;
		});
		await h.driver.released;
		let call = h.driver.calls[0];
		if (!call) throw new Error("missing admitted scripted tool call");
		let submitted = prompt.submitToolResult({ toolCallId: call.toolCallId, output: "{}" });
		await entered.promise;
		controller.abort();
		let destroying = session.doDestroy();
		void destroying.then(() => {
			destroyed = true;
		});
		await Bun.sleep(10);
		expect(observerFinished).toBe(false);
		expect(done).toBe(false);
		expect(destroyed).toBe(false);
		expect(h.driver.destroyed()).toBe(0);
		release.resolve();
		await submitted;
		await destroying;
		await prompt.done;
		expect(observerFinished).toBe(true);
		expect(done).toBe(true);
		expect(destroyed).toBe(true);
		expect(h.driver.destroyed()).toBe(1);
		expect(h.driver.calls).toHaveLength(1);
		expect(parts.filter(part => part.type === "tool-result")).toEqual([]);
		await session.doDestroy();
		expect(h.driver.destroyed()).toBe(1);
	} finally {
		controller.abort();
		release.resolve();
		await session?.doDestroy();
		await h.close();
	}
});

test("the scripted model stop cancels its held gate without aborting the caller signal", async () => {
	let h = await scriptedHeading([], true);
	let controller = new AbortController();
	let session: Awaited<ReturnType<typeof h.driver.fake.doStart>> | undefined;
	let escape: ReturnType<typeof setTimeout> | undefined;
	try {
		let job = headingJob();
		let turn = { id: "stop-turn", handle: "chopin", started: 1, responded: false };
		h.opened.plan.chat.job = job;
		h.opened.plan.chat.turn = turn;
		session = await h.driver.fake.doStart({ sessionId: "stop-session" } as never);
		let prompt = await session.doPromptTurn({
			tools: [],
			abortSignal: controller.signal,
			emit: (_part: HarnessV1StreamPart) => {},
		} as never);
		await h.driver.entered;
		escape = setTimeout(() => controller.abort(), 500);
		let stopped = await session.doStop();
		expect(controller.signal.aborted).toBe(false);
		clearTimeout(escape);
		await prompt.done;
		expect(stopped).toMatchObject({ type: "resume-session", harnessId: h.driver.fake.harnessId });
		expect(h.driver.calls).toEqual([]);
		expect(h.driver.results).toEqual([]);
		expect(h.opened.plan.chat.job).toBe(job);
		expect(h.opened.plan.chat.turn).toBe(turn);
		expect(await h.savedSource()).toBe("");
		await session.doDestroy();
		expect(h.driver.destroyed()).toBe(1);
	} finally {
		clearTimeout(escape);
		controller.abort();
		await session?.doDestroy();
		await h.close();
	}
});
