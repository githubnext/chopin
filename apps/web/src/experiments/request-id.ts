/** Keep identity while retrying an uncertain response; edited input starts a new operation. */
export class RequestIdentity {
	#current: { signature: string; id: string } | undefined;
	key(input: unknown): string {
		let signature = JSON.stringify(input);
		if (this.#current?.signature !== signature) {
			this.#current = { signature, id: crypto.randomUUID() };
		}
		return this.#current.id;
	}
	clear() {
		this.#current = undefined;
	}
}
