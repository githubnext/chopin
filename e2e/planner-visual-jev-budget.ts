/** Counts Jev requests at dispatch, including requests that later fail. */
export class JevBudget {
	private counts: Map<string, number>;
	private total = 0;
	private failure?: string;

	constructor(
		caseIds: readonly string[],
		private readonly perCase = 3,
		private readonly maximum = 9,
	) {
		this.counts = new Map(caseIds.map(id => [id, 0]));
	}

	reserve(caseId: string | undefined): { caseCount: number; total: number } {
		if (this.failure) throw new Error(`Jev run stopped: ${this.failure}`);
		let count = caseId ? this.counts.get(caseId) : undefined;
		if (count === undefined) {
			this.stop("unknown-case");
			throw new Error("Jev request has no frozen case identity");
		}
		if (count >= this.perCase || this.total >= this.maximum) {
			this.stop("request-cap");
			throw new Error("Jev request cap reached before dispatch");
		}
		this.counts.set(caseId!, count + 1);
		this.total += 1;
		return { caseCount: count + 1, total: this.total };
	}

	stop(reason: string): void {
		this.failure ??= reason;
	}

	get stopped(): string | undefined {
		return this.failure;
	}
}
