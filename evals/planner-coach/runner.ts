import { scenarioSession } from "./session";
import { turnPrompt } from "./prompt";
import type { Harness, Limits, Scenario, Transcript, TranscriptTurn } from "./types";

export async function runScenario(scenario: Scenario, settings: {
	harness: Harness;
	token: string;
	instructions: string;
	model: string;
	visual: "off" | "fixture-prose";
	limits: Limits;
}): Promise<Transcript> {
	let transcript: Transcript = {
		scenario,
		turns: [],
		tools: [],
		initialSource: scenario.source,
		finalSource: scenario.source,
		finalRevision: 0,
		activeTools: [],
		failures: [],
	};
	let fixture: Awaited<ReturnType<typeof scenarioSession>> | undefined;
	try {
		fixture = await scenarioSession(scenario, settings);
		transcript.initialSource = fixture.source();
		transcript.activeTools = fixture.session.activeTools ?? [];
		for (let [index, human] of scenario.turns.entries()) {
			let controller = new AbortController();
			fixture.guard.begin(index + 1, human, controller);
			let guardFailureStart = fixture.guard.failures.length;
			let turn: TranscriptTurn = {
				number: index + 1,
				human,
				prompt: turnPrompt(transcript.turns, human),
				text: "",
				parts: [],
				status: "complete",
				failures: [],
			};
			transcript.turns.push(turn);
			let startedAt = Date.now();
			let timer: ReturnType<typeof setTimeout> | undefined;
			let consume: Promise<void> | undefined;
			let deadline = new Promise<never>((_, reject) => {
				timer = setTimeout(() => {
					controller.abort(new Error("Turn timeout"));
					reject(new Error("Turn timeout"));
				}, settings.limits.turnTimeoutMs);
			});
			try {
				let active = fixture;
				consume = (async () => {
					let result = await active.session.stream(turn.prompt, controller.signal);
					let bytes = 0;
					for await (let part of result.fullStream) {
						bytes += Buffer.byteLength(JSON.stringify(part));
						if (bytes > 4 * 1024 * 1024) active.guard.fail("Transcript cap exceeded");
						turn.parts.push(part);
						if (part.type === "text-delta") turn.text += part.text;
						if (part.type === "error") throw part.error;
						if (part.type === "abort" && !active.guard.waiting) {
							turn.failures.push("Harness aborted the turn");
						}
						if (part.type === "tool-call" && !transcript.activeTools.includes(part.toolName)) {
							active.guard.fail(`Tool outside Planner authority: ${part.toolName}`);
						}
					}
				})();
				await Promise.race([consume, deadline]);
			} catch (error) {
				if (!fixture.guard.waiting) {
					turn.status = "failed";
					turn.failures.push(error instanceof Error ? error.message : String(error));
				}
			} finally {
				clearTimeout(timer);
				try {
					let active = fixture;
					await finishWithin(
						(async () => {
							await consume?.catch(() => {});
							await active.guard.drain();
						})(),
						5_000,
					);
				} catch {
					turn.status = "failed";
					turn.failures.push("Aborted stream or tool did not settle; no next turn was sent");
				}
				if (fixture.guard.waiting && !turn.failures.length) turn.status = "awaiting-human";
				else if (
					controller.signal.aborted || turn.failures.length
					|| fixture.guard.failures.length > guardFailureStart
				) {
					turn.status = "failed";
					turn.failures.push(...fixture.guard.failures.slice(guardFailureStart));
					if (!turn.failures.length) turn.failures.push(String(controller.signal.reason));
				}
				turn.durationMs = Date.now() - startedAt;
			}
			if (turn.status !== "complete" || turn.failures.length) break;
		}
	} catch (error) {
		transcript.failures.push(error instanceof Error ? error.message : String(error));
	} finally {
		if (fixture) {
			transcript.tools = fixture.guard.traces;
			transcript.failures.push(...fixture.guard.failures);
			transcript.finalSource = fixture.source();
			transcript.finalRevision = fixture.revision();
			try {
				let stored = await fixture.storedDocument();
				transcript.durableDocument = {
					...stored,
					matchesLiveSource: stored.source === transcript.finalSource,
				};
				if (!transcript.durableDocument.matchesLiveSource) {
					transcript.failures.push("Stored document differs from live source before cleanup");
				}
			} catch (error) {
				transcript.failures.push(`Stored document check: ${String(error)}`);
			}
			try {
				await fixture.close();
			} catch (error) {
				transcript.failures.push(`Cleanup: ${String(error)}`);
			}
		}
	}
	return transcript;
}

export async function finishWithin<T>(promise: Promise<T>, ms: number): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			promise,
			new Promise<never>((_, reject) => {
				timer = setTimeout(() => reject(new Error("Cleanup deadline exceeded")), ms);
			}),
		]);
	} finally {
		clearTimeout(timer);
	}
}
