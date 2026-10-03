/** One reader can pin one decision, even when parent and child editors both mount. */
type Pin = { owner: object; id: string };

let current: Pin | undefined;
let listeners = new Set<() => void>();

export function currentDecision(): Pin | undefined {
	return current;
}

/** A reply may update local chrome after its marker vanishes, but not after new reader intent. */
export function decisionReplyCurrent(
	owner: object,
	id: string,
	requestIntent: number,
	currentIntent: number,
): boolean {
	return requestIntent === currentIntent
		&& (!current || (current.owner === owner && current.id === id));
}

export function subscribeDecision(listener: () => void): () => void {
	listeners.add(listener);
	return () => listeners.delete(listener);
}

export function claimDecision(owner: object, id: string): void {
	if (current?.owner === owner && current.id === id) return;
	current = { owner, id };
	for (let listener of listeners) listener();
}

export function releaseDecision(owner?: object, id?: string): void {
	if (!current || (owner && current.owner !== owner) || (id && current.id !== id)) return;
	current = undefined;
	for (let listener of listeners) listener();
}
