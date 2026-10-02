/** Whether a document can show reader-local decision chrome. */
export function decisionHostVisible(host: HTMLElement): boolean {
	return !host.closest("[hidden], [inert], [aria-hidden='true']")
		&& host.getClientRects().length > 0
		&& host.clientWidth > 0
		&& host.clientHeight > 0;
}
