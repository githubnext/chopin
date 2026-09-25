import { describe, expect, it } from "bun:test";
import { HarnessAgent } from "@ai-sdk/harness/agent";
import { Output, tool } from "ai";
import { z } from "zod";

import type { HarnessV1, HarnessV1PromptTurnOptions, HarnessV1StartOptions } from "@ai-sdk/harness";

type SandboxSession = NonNullable<Parameters<HarnessAgent["createSession"]>[0]>["sandboxSession"];

export function harnessContract(
	name: string,
	createHarness: () => HarnessV1,
	createSandboxSession: () => SandboxSession = () =>
		({
			defaultWorkingDirectory: "/tmp",
			async run() {
				return { exitCode: 0, stdout: "", stderr: "" };
			},
			async destroy() {},
		}) as unknown as SandboxSession,
) {
	describe(`${name} harness contract`, () => {
		function fixture() {
			let starts: HarnessV1StartOptions[] = [];
			let turns: HarnessV1PromptTurnOptions[] = [];
			let emittedTools: {
				type: "tool-call" | "tool-result";
				toolCallId: string;
				toolName: string;
			}[] = [];
			let destroys = 0;
			let implementation = createHarness();
			let harness: HarnessV1 = {
				...implementation,
				async doStart(options) {
					starts.push(options);
					let session = await implementation.doStart(options);
					return {
						...session,
						async doPromptTurn(options) {
							turns.push(options);
							return session.doPromptTurn({
								...options,
								emit(part) {
									if (part.type === "tool-call" || part.type === "tool-result") {
										emittedTools.push({
											type: part.type,
											toolCallId: part.toolCallId,
											toolName: part.toolName,
										});
									}
									options.emit(part);
								},
							});
						},
						async doDestroy() {
							await session.doDestroy();
							destroys++;
						},
					};
				},
			};
			let sandboxSession = createSandboxSession();
			return {
				harness,
				sandboxSession,
				starts,
				turns,
				emittedTools,
				get destroys() {
					return destroys;
				},
			};
		}

		it("gives the adapter only the host tools and disables its built-ins", async () => {
			let state = fixture();
			let hostNames = ["first_host", "second_host"];
			let agent = new HarnessAgent({
				harness: state.harness,
				tools: {
					first_host: tool({ inputSchema: z.object({}), execute: async () => "ok" }),
					second_host: tool({ inputSchema: z.object({}), execute: async () => "ok" }),
				},
				activeTools: hostNames,
				permissionMode: "allow-reads",
			});
			let session = await agent.createSession({ sandboxSession: state.sandboxSession });
			try {
				await agent.generate({ session, prompt: "tools" });
				expect(state.turns).toHaveLength(1);
				expect(state.turns[0]!.tools.map(spec => spec.name)).toEqual(hostNames);
				let builtinNames = Object.keys(state.harness.builtinTools);
				expect(builtinNames.length === 0 || state.harness.supportsBuiltinToolFiltering === true)
					.toBe(true);
				expect(state.starts[0]!.builtinToolFiltering).toEqual(
					builtinNames.length === 0 ? undefined : { mode: "allow", toolNames: [] },
				);
				expect(state.emittedTools.filter(event => !hostNames.includes(event.toolName))).toEqual([]);
			} finally {
				await session.destroy();
			}
			expect(state.destroys).toBe(1);
		});

		it("parses structured output and forwards the JSON response format", async () => {
			let state = fixture();
			let agent = new HarnessAgent({
				harness: state.harness,
				activeTools: [],
				output: Output.object({ schema: z.object({ answer: z.string() }) }),
			});
			let session = await agent.createSession({ sandboxSession: state.sandboxSession });
			try {
				let result = await agent.generate({ session, prompt: "output" });
				expect(result.output).toMatchObject({ answer: expect.any(String) });
				expect(state.turns[0]!.responseFormat).toMatchObject({
					type: "json",
					schema: expect.any(Object),
				});
			} finally {
				await session.destroy();
			}
			expect(state.destroys).toBe(1);
		});

		it("forwards abortSignal, ends the interrupted turn, and destroys after the turn", async () => {
			let state = fixture();
			let agent = new HarnessAgent({ harness: state.harness, activeTools: [] });
			let session = await agent.createSession({ sandboxSession: state.sandboxSession });
			let controller = new AbortController();
			try {
				let result = await agent.stream({
					session,
					prompt: "abort",
					abortSignal: controller.signal,
				});
				expect(state.turns[0]!.abortSignal).toBe(controller.signal);
				expect(state.destroys).toBe(0);
				controller.abort();
				await result.consumeStream();
				expect(session.hasUnfinishedTurn()).toBe(false);
			} finally {
				await session.destroy();
			}
			expect(state.destroys).toBe(1);
			await session.destroy();
			expect(state.destroys).toBe(1);
		});
	});
}
