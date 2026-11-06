/**
 * The cut: the steps by which a process that was serving lets go, in the order that keeps it from
 * ever refusing a request that was routed to it, and from answering anything once it has
 * released the writer lease.
 *
 * The steps are injected, so this order is what tests hold fixed and the process supplies what
 * each step does.
 */
export type CutSteps = {
	/** Readiness goes off. The process still holds the lease and still serves everything. */
	unready(): void;
	/** How many readiness checks were answered not ready since `unready`. */
	refused(): number;
	/** Stops the listener without closing a socket. */
	stopListening(): Promise<void>;
	/** Lets requests already running finish, up to the bound; returns those still running. */
	finishRequests(boundMs: number): Promise<string[]>;
	/** Stops admitting edits and commits what is left of every document. */
	commit(): Promise<void>;
	/** Records what a remote Planner's link holds, for the next process to take back. */
	persistLinkState(): Promise<void>;
	/** Releases the writer lease. */
	release(): Promise<void>;
	/** Tells every client the server is restarting, and closes each socket and link. */
	closeClients(): Promise<void>;
};

export type CutTiming = {
	/** How long readiness stays off while the process still serves. */
	unreadyMs: number;
	/** How long requests already running are given before their connections are closed. */
	requestWaitMs: number;
};

export type CutLog = {
	info(message: string): void;
	warn(message: string): void;
};

export type CutReport = {
	/** Readiness checks refused in the unready window. */
	refused: number;
	/** Requests still running when the bound ran out. */
	abandoned: string[];
	/** The errors of steps that failed. Every step is tried regardless. */
	errors: Error[];
	/** How long each step took, in milliseconds. */
	phases: Record<string, number>;
};

export async function cut(
	steps: CutSteps,
	timing: CutTiming,
	log: CutLog = { info: console.info, warn: console.warn },
): Promise<CutReport> {
	let report: CutReport = { refused: 0, abandoned: [], errors: [], phases: {} };
	let phase = async (name: string, step: () => Promise<void> | void) => {
		let started = performance.now();
		try {
			await step();
		} catch (error) {
			report.errors.push(error instanceof Error ? error : new Error(String(error)));
		}
		report.phases[name] = Math.round(performance.now() - started);
	};

	await phase("unready", async () => {
		steps.unready();
		// The whole window and never longer: how many proxies check is unknowable from here.
		if (timing.unreadyMs > 0) await new Promise(resolve => setTimeout(resolve, timing.unreadyMs));
		report.refused = steps.refused();
		if (report.refused === 0 && timing.unreadyMs > 0) {
			log.warn(
				`chopin: no readiness check was answered during the ${timing.unreadyMs} ms before the `
					+ "listener stopped, so no proxy checks readiness actively. Requests may still reach "
					+ "the listener as it stops, which counts against the hand-over budget",
			);
		} else {
			log.info(
				`chopin: ${report.refused} readiness check(s) answered not ready in the ${timing.unreadyMs} ms window`,
			);
		}
	});
	await phase("listener", () => steps.stopListening());
	await phase("requests", async () => {
		report.abandoned = await steps.finishRequests(timing.requestWaitMs);
		for (let request of report.abandoned) {
			log.warn(
				`chopin: closing ${request}, still running after ${timing.requestWaitMs} ms, without an answer`,
			);
		}
	});
	await phase("commit", () => steps.commit());
	await phase("linkState", () => steps.persistLinkState());
	await phase("release", () => steps.release());
	await phase("close", () => steps.closeClients());
	return report;
}
