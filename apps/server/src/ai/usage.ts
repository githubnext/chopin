import { AI_USAGE_DAYS } from "@chopin/protocol/ai-usage";

import { requestedModel, UsageReader } from "./usage-reader";

import type { AiUsageSummary } from "@chopin/protocol/ai-usage";
import type { AiAttemptResult, AiPlaceholder, Lease } from "../storage/model";
import type { StorageAdapter } from "../storage/port";

const DAY_MS = 24 * 60 * 60 * 1000;
/** How long a request's record is kept once it has ended. */
const KEPT_DAYS = 90;

type Ending = Omit<AiAttemptResult, "completedAt">;

export type AiUsageOptions = {
	storage: StorageAdapter;
	/** The writer lease this process holds, which every record is written under. */
	lease: () => Lease | undefined;
	clock?: () => Date;
};

/** The proxy could not record a request before sending it, so it was not sent. */
export class AiUsageUnrecorded extends Error {
	override name = "AiUsageUnrecorded";
}

/**
 * One request the proxy is about to send, recorded as pending with its own id. It is completed
 * once, by the first of its endings: refused at the send, failed before an answer, or answered,
 * when the answer's body has ended, errored or been cancelled, with the token counts the provider
 * reported in it.
 */
export class AiAttemptRecord {
	#ended = false;

	constructor(readonly id: string, private readonly finish: (ending: Ending) => void) {}

	/** The proxy refused the request at the send, so nothing reached the provider. */
	unsent(reason: string): void {
		this.#end({ outcome: "unsent", error: reason, tokens: {} });
	}

	/** The request was sent and ended without an answer to pass on. */
	failed(error: string, status?: number): void {
		this.#end({
			outcome: "error",
			error,
			...(status === undefined ? {} : { status }),
			tokens: {},
		});
	}

	/**
	 * The provider answered with `status`: `body`, which is passed on as it is, is read for its
	 * token counts and any error on its way, and the request is completed when it ends.
	 */
	answered(
		status: number,
		contentType: string | null,
		body: ReadableStream<Uint8Array> | null,
	): ReadableStream<Uint8Array> | null {
		let reader = new UsageReader(contentType);
		let settle = (ended: "end" | "error" | "cancel") => {
			let read = reader.end();
			let error = ended === "cancel"
				? "cancelled"
				: read.error ?? (ended === "error"
					? "interrupted"
					: status >= 400 || status < 200
					? `http-${status}`
					: undefined);
			this.#end({
				outcome: error ? "error" : "ok",
				status,
				...(error ? { error } : {}),
				tokens: read.tokens,
			});
		};
		if (!body) {
			settle("end");
			return null;
		}
		let source = body.getReader();
		return new ReadableStream<Uint8Array>({
			async pull(controller) {
				let next: Awaited<ReturnType<typeof source.read>>;
				try {
					next = await source.read();
				} catch (err) {
					settle("error");
					controller.error(err);
					return;
				}
				if (next.done) {
					settle("end");
					controller.close();
					return;
				}
				reader.push(next.value);
				controller.enqueue(next.value);
			},
			cancel(reason) {
				settle("cancel");
				return source.cancel(reason);
			},
		}, { highWaterMark: 0 });
	}

	#end(ending: Ending): void {
		if (this.#ended) return;
		this.#ended = true;
		this.finish(ending);
	}
}

/**
 * What the AI proxy sends for each person's launches: every request is recorded under the writer
 * lease before it is sent, against its launch, person, provider and the model it names, and
 * completed once with how it ended and the tokens its provider reported. A request its process
 * never completed, because it stopped first, is marked unknown by the next process (`retire`).
 */
export class AiUsage {
	readonly #storage: StorageAdapter;
	readonly #lease: () => Lease | undefined;
	readonly #clock: () => Date;

	constructor(options: AiUsageOptions) {
		this.#storage = options.storage;
		this.#lease = options.lease;
		this.#clock = options.clock ?? (() => new Date());
	}

	/**
	 * Records a request for `placeholder`'s launch as pending before it is sent, with the model its
	 * `body` names; throws `AiUsageUnrecorded` when it can't be, and then it must not be sent.
	 */
	async begin(placeholder: AiPlaceholder, body: Uint8Array | undefined): Promise<AiAttemptRecord> {
		let lease = this.#lease();
		if (!lease) throw new AiUsageUnrecorded("this process does not hold the writer lease");
		let id = crypto.randomUUID();
		let model = requestedModel(body);
		try {
			await this.#storage.aiUsage.begin(lease, {
				id,
				launchId: placeholder.launchId,
				userId: placeholder.userId,
				provider: placeholder.provider,
				...(model ? { model } : {}),
				startedAt: this.#clock(),
			});
		} catch (err) {
			throw new AiUsageUnrecorded("the request could not be recorded", { cause: err });
		}
		return new AiAttemptRecord(id, ending => this.#complete(id, ending));
	}

	/** The person's own requests over the last `AI_USAGE_DAYS` days, by model. */
	async summary(userId: string): Promise<AiUsageSummary> {
		let since = new Date(this.#clock().getTime() - AI_USAGE_DAYS * DAY_MS);
		let totals = await this.#storage.aiUsage.summary(userId, since);
		return {
			since: since.toISOString(),
			models: totals.map(total => ({
				provider: total.provider,
				...(total.model ? { model: total.model } : {}),
				requests: total.requests,
				errors: total.errors,
				unknown: total.unknown,
				tokens: { ...total.tokens },
			})),
		};
	}

	/** Marks unknown every request an earlier process sent and never completed. */
	async retire(): Promise<number> {
		let lease = this.#lease();
		return lease ? this.#storage.aiUsage.retire(lease, this.#clock()) : 0;
	}

	/** Removes the records of ended requests started more than `KEPT_DAYS` days ago. */
	async sweep(): Promise<number> {
		let lease = this.#lease();
		if (!lease) return 0;
		return this.#storage.aiUsage.deleteBefore(
			lease,
			new Date(this.#clock().getTime() - KEPT_DAYS * DAY_MS),
		);
	}

	#complete(id: string, ending: Ending): void {
		let lease = this.#lease();
		if (!lease) return;
		this.#storage.aiUsage.complete(lease, id, { ...ending, completedAt: this.#clock() }).catch(
			err => console.warn("[ai] couldn't record how a proxied request ended", err),
		);
	}
}
