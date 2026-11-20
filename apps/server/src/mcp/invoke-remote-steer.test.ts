/**
 * A keyed instruction given to a remote Planner's running turn whose confirmation does not arrive
 * in time may have been read: it is recorded as uncertain and never delivered again, by a new turn
 * or by a retry.
 */
import { HarnessAgent } from "@ai-sdk/harness/agent";
import { expect, test } from "bun:test";

import * as Chat from "../chat/service";
import { harness, installJobCleanup, member, socket, until } from "../chat/job.test-fixtures";
import { createRemoteAdapter } from "../harness/remote/adapter";
import { MemoryMcpInvocationStore } from "../storage/memory/mcp-invocations";
import { attach, finishTurn, linkAuth, linkServer } from "../testing/agent-link";
import { IdempotentInvocations, invocationFingerprint, UNCONFIRMED } from "./invoke";

import type { AgentHandlers } from "@chopin/agent-link/client";
import type { Lease } from "../storage/model";

installJobCleanup();

const INSTRUCTION = "Also publish the release";
const DOCUMENT = { id: "room", title: "Room", url: "https://chopin.test/room" };
const UNSURE = { kind: "refused", code: "planner-unavailable", message: UNCONFIRMED } as const;

/**
 * A Chat whose Planner is a remote client attached over a real agent link, with steer
 * confirmations that time out after 100 ms, and the first one held back until `confirm`.
 */
async function remote(handlers: AgentHandlers) {
	let h = harness();
	let { auth, channel, storage } = await linkAuth();
	let server = linkServer(auth, 100);
	let client = await attach(server.url, channel.id, handlers);
	let link = server.links.at(-1)!;
	let receive = link.receive.bind(link);
	let held: (() => void) | undefined;
	link.receive = raw => {
		let text = typeof raw === "string" ? raw : new TextDecoder().decode(raw as Uint8Array);
		let frame = JSON.parse(text) as { type?: string };
		if (frame.type === "control-result" && !held) {
			held = () => receive(raw);
			return;
		}
		receive(raw);
	};
	let adapter = createRemoteAdapter(() => ({
		link: server.links.at(-1)!,
		planner: { channelId: channel.id, isolated: false },
	}));
	let agent = new HarnessAgent({
		harness: adapter,
		tools: {},
		activeTools: [],
		permissionMode: "allow-reads",
	});
	h.context.openPlannerSession = async () => {
		let session = await agent.createSession({
			sandboxSession: {
				defaultWorkingDirectory: "/tmp",
				async run() {
					return { exitCode: 0, stdout: "", stderr: "" };
				},
				async destroy() {},
			} as never,
		});
		return {
			ok: true,
			value: {
				activeTools: [],
				stream: (prompt: string, signal: AbortSignal) =>
					agent.stream({ session, prompt, abortSignal: signal }),
				steer: (text: string) => session.experimental_steerTurn(text),
				destroy: () => session.destroy(),
			},
		} as never;
	};
	let store = new MemoryMcpInvocationStore({ channelExists: () => true, assertLease() {} });
	let scope = { userId: "U_bo", channelId: "room", key: "same-key" };
	let invocations = () => new IdempotentInvocations(store, () => ({}) as Lease, () => new Date());
	let calls = invocations();
	return {
		h,
		invoke: () =>
			calls.run(scope, invocationFingerprint({ instruction: INSTRUCTION }, "room"), {
				document: DOCUMENT,
			}, async key => {
				let delivery = await key.reconcile(id => h.chat.entries.some(entry => entry.id === id));
				if (delivery === "idempotency-conflict") return { kind: "refused", code: delivery };
				let code = await Chat.invoke(
					h.context,
					{ id: "U_bo", login: "bo" },
					INSTRUCTION,
					undefined,
					undefined,
					undefined,
					undefined,
					delivery,
				);
				return code ? { kind: "refused", code } : { kind: "invoked", document: DOCUMENT };
			}),
		/** A new process over the same storage and Chat. */
		restart: () => {
			calls = invocations();
		},
		record: () => store.get(scope),
		posted: () => h.chat.entries.filter(entry => entry.text === INSTRUCTION),
		confirm: () => held?.(),
		async close() {
			await Chat.close(h.chat);
			await client.detach();
			await server.stop();
			await storage.close();
		},
	};
}

test("an instruction whose steer is confirmed too late is refused as uncertain, and no retry gives it again", async () => {
	let started = Promise.withResolvers<void>();
	let heard: string[] = [];
	let link = await remote({
		async turn(context) {
			context.emit({ type: "stream-start", modelId: "scripted" });
			started.resolve();
			if (!context.signal.aborted) {
				await new Promise(resolve =>
					context.signal.addEventListener("abort", resolve, { once: true })
				);
			}
		},
		steer(message) {
			heard.push(message.prompt);
		},
	});
	try {
		await Chat.send(link.h.context, socket(), member("@chopin initial turn"));
		await started.promise;
		expect(await link.invoke()).toEqual(UNSURE);
		expect((await link.record())?.uncertainAt).toBeInstanceOf(Date);
		link.confirm();
		await Bun.sleep(10);
		expect(await link.invoke()).toEqual(UNSURE);
		link.restart();
		expect(await link.invoke()).toEqual(UNSURE);
		expect(heard).toHaveLength(1);
		expect(heard[0]).toContain(INSTRUCTION);
		expect(link.posted()).toHaveLength(1);
	} finally {
		await link.close();
	}
});

test("an instruction whose steer is confirmed too late starts no turn of its own when the turn it was given to ends", async () => {
	let started = Promise.withResolvers<void>();
	let finish = Promise.withResolvers<void>();
	let prompts: string[] = [];
	let heard: string[] = [];
	let link = await remote({
		async turn(context) {
			prompts.push(context.message.prompt);
			context.emit({ type: "stream-start", modelId: "scripted" });
			started.resolve();
			if (prompts.length === 1) {
				// The turn reads the instruction it was given and ends normally.
				await finish.promise;
				context.emit({ type: "text-start", id: "answer" });
				context.emit({ type: "text-delta", id: "answer", delta: "The release is published." });
				context.emit({ type: "text-end", id: "answer" });
				finishTurn(context);
			} else if (!context.signal.aborted) {
				await new Promise(resolve =>
					context.signal.addEventListener("abort", resolve, { once: true })
				);
			}
		},
		steer(message) {
			heard.push(message.prompt);
			finish.resolve();
		},
	});
	try {
		await Chat.send(link.h.context, socket(), member("@chopin initial turn"));
		await started.promise;
		expect(await link.invoke()).toEqual(UNSURE);
		await until(() => !link.h.chat.busy);
		await Bun.sleep(50);
		expect(prompts).toHaveLength(1);
		expect(heard).toHaveLength(1);
		expect(link.posted()).toHaveLength(1);
		expect(await link.invoke()).toEqual(UNSURE);
		await Bun.sleep(50);
		expect(prompts).toHaveLength(1);
		expect(heard).toHaveLength(1);
	} finally {
		await link.close();
	}
});
