import { MODEL_TIMEOUT_MS } from "./domain";
import type { AgendaCredential } from "./assessor";

/** Authorization is abortable too: revocation cannot strand a reserved model call. */
export async function agendaModelCall<T>(
	credential: AgendaCredential,
	requestedSignal: AbortSignal,
	execute: (signal: AbortSignal, aborted: Promise<never>) => Promise<T>,
): Promise<T> {
	let signal = AbortSignal.any([
		requestedSignal,
		credential.signal,
		AbortSignal.timeout(MODEL_TIMEOUT_MS),
	]);
	let onAbort!: () => void;
	let aborted = new Promise<never>((_, reject) => {
		onAbort = () => reject(new Error("agenda model interrupted"));
		if (signal.aborted) onAbort();
		else signal.addEventListener("abort", onAbort, { once: true });
	});
	try {
		if (!await Promise.race([credential.authorize(), aborted])) {
			throw new Error("agenda owner unavailable");
		}
		let output = await Promise.race([execute(signal, aborted), aborted]);
		if (!await Promise.race([credential.authorize(), aborted]) || signal.aborted) {
			throw new Error("agenda owner unavailable");
		}
		return output;
	} finally {
		signal.removeEventListener("abort", onAbort);
	}
}
