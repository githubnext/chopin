/**
 * What a stopping process does about the turns running now: it keeps serving, gives them until a
 * bound to finish, and cuts off those still running with a notice. A turn cut off is never run
 * again, because it may already have changed the document.
 */
export type Turns<Chat> = {
	/** The chats with a turn running now. */
	busy(): Chat[];
	/** Cuts the running turn off, with the notice its Chat records. */
	interrupt(chat: Chat): void;
	/** Resolves when the turn has ended. */
	settled(chat: Chat): Promise<unknown>;
	/** Called once, before the first turn is cut off. */
	beforeInterrupt(): void;
};

export type TurnWait = {
	waitMs: number;
	/** How long the notice of a cut-off turn is given to be recorded. */
	settleMs?: number;
	poll?: number;
};

/** Returns how many turns were cut off. */
export async function finishTurns<Chat>(turns: Turns<Chat>, wait: TurnWait): Promise<number> {
	let deadline = Date.now() + wait.waitMs;
	while (turns.busy().length > 0 && Date.now() < deadline) {
		await new Promise(resolve => setTimeout(resolve, wait.poll ?? 25));
	}
	let running = turns.busy();
	if (running.length === 0) return 0;
	turns.beforeInterrupt();
	for (let chat of running) turns.interrupt(chat);
	let timer: ReturnType<typeof setTimeout> | undefined;
	await Promise.race([
		Promise.allSettled(running.map(chat => turns.settled(chat))),
		new Promise(resolve => {
			timer = setTimeout(resolve, wait.settleMs ?? 2_000);
		}),
	]);
	clearTimeout(timer);
	return running.length;
}
