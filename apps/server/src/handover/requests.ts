/**
 * What a process does with HTTP requests while it hands the database over to another one.
 *
 * Waiting for the writer lease, a process answers only what needs no lease and holds the rest
 * until it is ready or a bound passes. Once it is on its way out it tells every client to close
 * its connection after the answer. When the cut asks the requests still running to finish and the
 * bound passes, each one left is abandoned: its connection is closed without an answer, whatever
 * its handler goes on to do, and no request is answered after that.
 */
const ABANDONED = Symbol("abandoned");

export type Exempt = (request: Request, url: URL) => boolean | Promise<boolean>;

export type RequestsOptions = {
	/** How long a held request waits before it is answered 503. */
	holdMs: number;
	/** Requests that need no lease: they are answered at once while others are held. */
	exempt: Exempt;
};

export class Requests {
	readonly #holdMs: number;
	readonly #exempt: Exempt;
	readonly #running = new Map<number, string>();
	readonly #abandons = new Map<number, () => void>();
	#sealed = false;
	#next = 0;
	#holding = false;
	#release = () => {};
	#released: Promise<void> = Promise.resolve();
	#closing = false;
	#idle: (() => void) | undefined;
	#held = 0;
	#expired = 0;
	#longest = 0;

	constructor(options: RequestsOptions) {
		this.#holdMs = options.holdMs;
		this.#exempt = options.exempt;
	}

	/** Starts holding every request that needs the lease, until `release`. */
	hold(): void {
		if (this.#holding) return;
		this.#holding = true;
		this.#released = new Promise<void>(resolve => {
			this.#release = resolve;
		});
	}

	/** The process may serve: every held request goes on, and none is held again. */
	release(): { held: number; expired: number; longestMs: number } {
		this.#holding = false;
		this.#release();
		return { held: this.#held, expired: this.#expired, longestMs: Math.round(this.#longest) };
	}

	/** From now on every answer asks the client to close its connection. */
	close(): void {
		this.#closing = true;
	}

	/** How many requests are being answered now. */
	get running(): number {
		return this.#running.size;
	}

	/**
	 * Waits until no request is running, or `boundMs` passes. A request still running then is
	 * abandoned: its connection is closed without an answer, its signal is aborted, and anything
	 * its handler returns later is dropped. From here on every request that arrives is closed the
	 * same way, so nothing is answered once the caller goes on to release the lease. Returns the
	 * requests abandoned, as "METHOD /path", so the caller can log each.
	 */
	async finish(boundMs: number): Promise<string[]> {
		if (this.#running.size > 0) {
			let timer: ReturnType<typeof setTimeout> | undefined;
			await Promise.race([
				new Promise<void>(resolve => {
					this.#idle = resolve;
				}),
				new Promise<void>(resolve => {
					timer = setTimeout(resolve, boundMs);
				}),
			]);
			clearTimeout(timer);
			this.#idle = undefined;
		}
		this.#sealed = true;
		let abandoned = [...this.#running.values()];
		for (let abandon of this.#abandons.values()) abandon();
		return abandoned;
	}

	async handle(
		request: Request,
		run: (abandoned: AbortSignal) => Promise<Response | undefined> | Response | undefined,
	): Promise<Response | undefined> {
		if (this.#sealed) return closedWithoutAnswer();
		if (this.#holding) {
			let url = new URL(request.url);
			if (!await this.#exempt(request, url)) {
				let refusal = await this.#hold(request);
				if (refusal) return this.#marked(refusal);
			}
		}
		let id = this.#next++;
		this.#running.set(id, `${request.method} ${new URL(request.url).pathname}`);
		let controller = new AbortController();
		let abandoned = new Promise<typeof ABANDONED>(resolve => {
			this.#abandons.set(id, () => {
				controller.abort();
				resolve(ABANDONED);
			});
		});
		try {
			let work = Promise.resolve(run(controller.signal));
			let outcome = await Promise.race([work, abandoned]);
			if (outcome === ABANDONED) {
				// Whatever it makes of its work is never sent.
				work.then(
					late => {
						void late?.body?.cancel().catch(() => {});
					},
					() => {},
				);
				return closedWithoutAnswer();
			}
			return this.#marked(outcome);
		} finally {
			this.#running.delete(id);
			this.#abandons.delete(id);
			if (this.#running.size === 0) this.#idle?.();
		}
	}

	/** Waits for release; the answer if it ran out first or the client went away. */
	async #hold(request: Request): Promise<Response | undefined> {
		let started = performance.now();
		this.#held++;
		let timer: ReturnType<typeof setTimeout> | undefined;
		let gone: (() => void) | undefined;
		let outcome = await Promise.race([
			this.#released.then(() => "released" as const),
			new Promise<"expired">(resolve => {
				timer = setTimeout(() => resolve("expired"), this.#holdMs);
			}),
			new Promise<"gone">(resolve => {
				gone = () => resolve("gone");
				if (request.signal.aborted) gone();
				else request.signal.addEventListener("abort", gone, { once: true });
			}),
		]);
		clearTimeout(timer);
		if (gone) request.signal.removeEventListener("abort", gone);
		this.#longest = Math.max(this.#longest, performance.now() - started);
		if (outcome === "released") return undefined;
		if (outcome === "expired") this.#expired++;
		return new Response("standby", {
			status: 503,
			headers: {
				"cache-control": "no-store",
				"content-type": "text/plain; charset=utf-8",
				"retry-after": "1",
			},
		});
	}

	#marked(response: Response | undefined): Response | undefined {
		if (!response || !this.#closing) return response;
		try {
			response.headers.set("connection", "close");
			return response;
		} catch {
			// Headers a proxied answer owns cannot be changed; copy the answer.
			let copy = new Response(response.body, response);
			copy.headers.set("connection", "close");
			return copy;
		}
	}
}

/**
 * An answer whose body fails before a byte is written, which Bun takes as a reason to close the
 * connection with nothing sent. The proxy sees a closed connection, not a status.
 */
function closedWithoutAnswer(): Response {
	return new Response(
		new ReadableStream({
			start(controller) {
				controller.error();
			},
		}),
	);
}

/**
 * The request, with its signal aborted when `signal` is, so a handler that watches its request
 * stops with a request the cut abandoned as it does with a client that went away.
 */
export function abandonable(request: Request, signal: AbortSignal): Request {
	return new Request(request, { signal: AbortSignal.any([request.signal, signal]) });
}
