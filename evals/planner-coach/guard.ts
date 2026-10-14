import { WRITE_TOOLS } from "../../apps/server/src/agent/job-scope";
import * as Room from "../../apps/server/src/plan/room";
import type { DocumentRoom } from "../../apps/server/src/agent/tools";
import type { Limits, Tools, Trace, Turn } from "./types";

const EXTERNAL_WORK = new Set(["create_research_workspace", "propose_investigation"]);

export class ToolGuard {
	traces: Trace[] = [];
	failures: string[] = [];
	turn = 0;
	count = 0;
	waiting = false;
	controller = new AbortController();
	human: Turn = { speaker: "fixture", text: "" };
	inFlight = new Set<Promise<void>>();

	constructor(readonly room: DocumentRoom, readonly limits: Limits) {}

	begin(number: number, human: Turn, controller: AbortController) {
		this.turn = number;
		this.count = 0;
		this.waiting = false;
		this.human = human;
		this.controller = controller;
	}

	wrap(tools: Tools): Tools {
		return Object.fromEntries(
			Object.entries(tools).map(([name, original]) => {
				let execute = original.execute;
				if (!execute) return [name, original];
				return [name, {
					...original,
					execute: async (input, options) => {
						let done = Promise.withResolvers<void>();
						this.inFlight.add(done.promise);
						let controller = this.controller;
						let human = this.human;
						let trace: Trace = {
							index: this.traces.length,
							turn: this.turn,
							name,
							input,
							revisionBefore: this.room.plan.revision,
							sourceBefore: Room.project(this.room.plan.document),
						};
						this.traces.push(trace);
						let timer: ReturnType<typeof setTimeout> | undefined;
						try {
							if (++this.count > this.limits.maxTools) this.fail("Tool call cap exceeded");
							controller.signal.throwIfAborted();
							if (human.stopWrites && WRITE_TOOLS.has(name)) {
								trace.refusal = `Mutation attempted after explicit stop: ${name}`;
								this.fail(`Mutation attempted after explicit stop: ${name}`);
							}
							if (EXTERNAL_WORK.has(name)) {
								trace.refusal = "External work unavailable in this frozen evaluation";
								return trace.output = `Error: ${trace.refusal}`;
							}
							if (name === "ask") {
								timer = setTimeout(() => {
									this.waiting = true;
									trace.refusal =
										"Bounded human wait ended; unanswered cards are withdrawn during abort cleanup";
									controller.abort(new Error("Bounded human decision wait ended"));
								}, this.limits.questionWaitMs);
							}
							return trace.output = await execute(input, {
								...options,
								abortSignal: AbortSignal.any([
									controller.signal,
									...(options.abortSignal ? [options.abortSignal] : []),
								]),
							});
						} catch (error) {
							trace.error = error instanceof Error ? error.message : String(error);
							throw error;
						} finally {
							clearTimeout(timer);
							try {
								trace.revisionAfter = this.room.plan.revision;
								trace.sourceAfter = Room.project(this.room.plan.document);
							} finally {
								this.inFlight.delete(done.promise);
								done.resolve();
							}
						}
					},
				}];
			}),
		);
	}

	async drain() {
		await Promise.allSettled(this.inFlight);
	}

	fail(message: string): never {
		this.failures.push(message);
		this.controller.abort(new Error(message));
		throw new Error(message);
	}
}
