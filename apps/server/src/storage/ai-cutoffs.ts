/**
 * The writes this process has committed that can end AI authority before it expires: a launch
 * ended, a machine revoked or its launches ended, a document archived, and a credential connected,
 * replaced or removed, which also counts for its person. Each is counted once its write has
 * settled and before its caller hears so. One process serves a database at a time, under the
 * writer lease, so a count read before a read and found the same after it says that no such write
 * completed while the read was made.
 */
export class AiCutoffs {
	#all = 0;
	readonly #people = new Map<string, number>();

	cut(userId?: string): void {
		this.#all++;
		if (userId !== undefined) this.#people.set(userId, this.person(userId) + 1);
	}

	all(): number {
		return this.#all;
	}

	person(userId: string): number {
		return this.#people.get(userId) ?? 0;
	}
}
