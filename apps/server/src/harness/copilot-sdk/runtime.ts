import type { CopilotClient, CopilotSession, SessionConfig } from "@github/copilot-sdk";

export type RuntimeClient = Pick<
	CopilotClient,
	"createSession" | "deleteSession" | "forceStop" | "start" | "stop"
>;

export type RuntimeSource = {
	client: RuntimeClient;
	cleanup: () => void;
};

type Generation = RuntimeSource & {
	ready: Promise<void>;
	opening: Set<Promise<CopilotSession>>;
	sessions: Map<string, CopilotSession>;
	closing: Map<string, Promise<Error[]>>;
	disposing?: Promise<Error[]>;
};

function reason(value: unknown): Error {
	return value instanceof Error ? value : new Error(String(value));
}

function failure(message: string, errors: Error[]): Error | undefined {
	if (errors.length === 0) return undefined;
	if (errors.length === 1) return errors[0];
	return new AggregateError(errors, message);
}

function bounded<T>(operation: Promise<T>, timeoutMs: number, message: string): Promise<T> {
	return new Promise<T>((resolve, reject) => {
		let timer = setTimeout(() => reject(new Error(message)), timeoutMs);
		operation.then(
			value => {
				clearTimeout(timer);
				resolve(value);
			},
			err => {
				clearTimeout(timer);
				reject(err);
			},
		);
	});
}

/** Owns one lazily started Copilot runtime and every disposable session on it. */
export class Runtime {
	#create: () => RuntimeSource;
	#operationTimeoutMs: number;
	#generation?: Generation;
	#owners = new WeakMap<CopilotSession, Generation>();
	#known = new WeakSet<CopilotSession>();
	#accepting = true;
	#stopping?: Promise<void>;

	constructor(create: () => RuntimeSource, operationTimeoutMs = 10_000) {
		this.#create = create;
		this.#operationTimeoutMs = operationTimeoutMs;
	}

	async open(config: SessionConfig): Promise<CopilotSession> {
		if (!this.#accepting) throw new Error("The Copilot runtime is shutting down.");
		let generation = this.#current();
		let opening = (async () => {
			await generation.ready;
			if (!this.#accepting || this.#generation !== generation) {
				throw new Error("The Copilot runtime is shutting down.");
			}
			let session = await generation.client.createSession(config);
			if (!this.#accepting || this.#generation !== generation) {
				if (!generation.disposing) {
					let errors = await this.#close(generation, session);
					let cleanup = failure("The Copilot session could not be closed.", errors);
					if (cleanup) throw cleanup;
				}
				throw new Error("The Copilot runtime is shutting down.");
			}
			generation.sessions.set(session.sessionId, session);
			this.#owners.set(session, generation);
			this.#known.add(session);
			return session;
		})();
		generation.opening.add(opening);
		try {
			return await opening;
		} finally {
			generation.opening.delete(opening);
		}
	}

	async discard(session: CopilotSession): Promise<boolean> {
		let generation = this.#owners.get(session);
		if (!generation) return this.#known.has(session);
		let errors = await this.#close(generation, session);
		generation.sessions.delete(session.sessionId);
		generation.closing.delete(session.sessionId);
		this.#owners.delete(session);
		let error = failure("The Copilot session could not be closed.", errors);
		if (error) throw error;
		return true;
	}

	shutdown(): Promise<void> {
		if (this.#stopping) return this.#stopping;
		this.#accepting = false;
		let generation = this.#generation;
		return this.#stopping = (async () => {
			if (!generation) return;
			let errors: Error[] = [];
			try {
				await bounded(
					Promise.allSettled(generation.opening),
					this.#operationTimeoutMs,
					"Copilot session opening did not stop before shutdown.",
				);
			} catch (err) {
				errors.push(reason(err));
			}
			errors.push(...await this.#dispose(generation));
			if (this.#generation === generation) this.#generation = undefined;
			let error = failure("The Copilot runtime could not shut down cleanly.", errors);
			if (error) throw error;
		})();
	}

	#current(): Generation {
		if (this.#generation) return this.#generation;
		let source = this.#create();
		let generation = {
			...source,
			ready: Promise.resolve(),
			opening: new Set<Promise<CopilotSession>>(),
			sessions: new Map<string, CopilotSession>(),
			closing: new Map<string, Promise<Error[]>>(),
		};
		this.#generation = generation;
		generation.ready = Promise.resolve().then(() => generation.client.start()).catch(
			async err => {
				let errors = [reason(err), ...await this.#dispose(generation)];
				if (this.#generation === generation) this.#generation = undefined;
				throw failure("The Copilot runtime could not start.", errors)!;
			},
		);
		return generation;
	}

	#close(generation: Generation, session: CopilotSession): Promise<Error[]> {
		let existing = generation.closing.get(session.sessionId);
		if (existing) return existing;
		let closing = (async () => {
			let errors: Error[] = [];
			try {
				await bounded(
					Promise.resolve().then(() => session.disconnect()),
					this.#operationTimeoutMs,
					`Copilot session ${session.sessionId} disconnect timed out.`,
				);
			} catch (err) {
				errors.push(reason(err));
			}
			try {
				await bounded(
					Promise.resolve().then(() => generation.client.deleteSession(session.sessionId)),
					this.#operationTimeoutMs,
					`Copilot session ${session.sessionId} deletion timed out.`,
				);
			} catch (err) {
				errors.push(reason(err));
			}
			return errors;
		})();
		generation.closing.set(session.sessionId, closing);
		return closing;
	}

	#dispose(generation: Generation): Promise<Error[]> {
		if (generation.disposing) return generation.disposing;
		return generation.disposing = (async () => {
			let errors: Error[] = [];
			let sessions = [...generation.sessions.values()];
			let closed = await Promise.all(sessions.map(session => this.#close(generation, session)));
			for (let index = 0; index < sessions.length; index++) {
				let session = sessions[index]!;
				this.#owners.delete(session);
				errors.push(...closed[index]!);
			}
			generation.sessions.clear();
			generation.closing.clear();
			let force = false;
			try {
				let stopped = await bounded(
					Promise.resolve().then(() => generation.client.stop()),
					this.#operationTimeoutMs,
					"Copilot runtime stop timed out.",
				);
				errors.push(...stopped);
				force = stopped.length > 0;
			} catch (err) {
				errors.push(reason(err));
				force = true;
			}
			if (force) {
				try {
					await bounded(
						Promise.resolve().then(() => generation.client.forceStop()),
						this.#operationTimeoutMs,
						"Copilot runtime force-stop timed out.",
					);
				} catch (err) {
					errors.push(reason(err));
				}
			}
			try {
				generation.cleanup();
			} catch (err) {
				errors.push(reason(err));
			}
			return errors;
		})();
	}
}
