import type { Effect, EffectDeps } from "./effect-types";
// Extracted from archive 446a9779a937fa5be7cd3eb52fd7f3023d691ed2, effects.ts.

export async function runEffects(deps: EffectDeps, effects: readonly Effect[]): Promise<number> {
	let completed = 0;
	let blocked = new Set<string>();
	for (
		let effect of [
			...effects.filter(item => item.kind !== "job"),
			...effects.filter(item => item.kind === "job"),
		]
	) {
		// A fresh, explicit writer action supplies the owner context for research.
		if (effect.kind === "research") continue;
		if (deps.applied(effect.key)) continue;
		if (
			effect.kind !== "insert-card" && "threadId" in effect && effect.threadId
			&& blocked.has(effect.threadId)
		) continue;
		try {
			if (effect.kind === "insert-card") {
				let target = deps.target(effect.threadId);
				if (target.kind !== "unlinked") {
					await deps.markApplied(effect.key);
					completed++;
					continue;
				}
				let card = await deps.insertCard({
					threadId: effect.threadId,
					header: effect.header,
					question: effect.question,
					options: effect.options,
				});
				await deps.link(effect.threadId, card);
			} else if (effect.kind === "job") {
				if (effect.intent.kind === "prose" && !effect.threadId) {
					throw new Error("prose job effect has no linked thread");
				}
				if (effect.threadId) {
					let target = deps.target(effect.threadId);
					if (target.kind === "unlinked") {
						blocked.add(effect.threadId);
						continue;
					}
					if (
						effect.intent.kind === "prose"
						&& !deps.proseReady?.(
							effect.threadId,
							effect.intent.target,
							effect.intent.trigger,
						)
					) {
						await deps.markApplied(effect.key);
						completed++;
						continue;
					}
					if (
						target.kind === "closed"
						&& effect.intent.kind !== "prose"
					) {
						await deps.markApplied(effect.key);
						completed++;
						continue;
					}
				}
				if (!deps.enqueueJob) continue;
				await deps.enqueueJob(effect.intent, effect.key);
			} else if (effect.kind === "scoped-choice") {
				if (!deps.scopedChoice) continue;
				await deps.scopedChoice(effect);
			} else if (effect.kind === "defer-prompt") {
				if (!deps.deferPrompt) continue;
				await deps.deferPrompt(effect);
			} else {
				let target = deps.target(effect.threadId);
				if (target.kind === "unlinked") {
					blocked.add(effect.threadId);
					continue;
				}
				if (target.kind === "open") {
					if (effect.kind === "add-option") {
						await deps.addOption(target.id, {
							optionId: effect.optionId,
							label: effect.label,
							trigger: effect.trigger,
							...(effect.source ? { source: effect.source } : {}),
						});
					} else if (effect.kind === "prompt") {
						await deps.prompt(target.id, effect.generation, {
							optionId: effect.optionId,
							messageId: effect.messageId,
							sourceMessageIds: effect.sourceMessageIds,
						});
					} else {
						await deps.suggest(target.id, {
							optionId: effect.optionId,
							messageIds: effect.messageIds,
						});
					}
				}
			}
			await deps.markApplied(effect.key);
			completed++;
		} catch (error) {
			if ("threadId" in effect && effect.threadId) blocked.add(effect.threadId);
			deps.report(error);
		}
	}
	return completed;
}
