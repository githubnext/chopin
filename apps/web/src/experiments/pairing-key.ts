import { useCallback, useEffect, useRef, useState } from "react";
import { experimentRequest } from "./api";

/**
 * Set as the page goes to GitHub to authorize the next machine, with the automatic-work choice
 * the key is for, so the server page makes that key as it comes back. Never the key itself.
 */
const RETURNING_KEY = "chopin:machines:generate";

/** How long a key has left, in the whole minutes a person reads at a glance. */
export function expiryLabel(expiresAt: number, now: number): string {
	let left = expiresAt - now;
	return left > 0 ? `Single use · expires in ${Math.ceil(left / 60_000)} min` : "Expired";
}

export type PairingKey =
	| { state: "idle" }
	| { state: "minting" }
	| { state: "ready"; key: string; expiresAt: number; autoRun: boolean }
	/** GitHub authorizes the next machine first; `going` while the page is on its way there. */
	| { state: "authorize"; url: string; going: boolean }
	| { state: "expired" }
	| { state: "failed"; code: string };

/** The automatic-work choice a key was asked for just before the page went to GitHub, once. */
function returning(): boolean | undefined {
	try {
		let value = sessionStorage.getItem(RETURNING_KEY);
		sessionStorage.removeItem(RETURNING_KEY);
		return value === null ? undefined : value === "auto";
	} catch {
		return undefined;
	}
}

/**
 * A single-use pairing key for the signed-in person, held only in memory and minted only when
 * `generate` is pressed. Where GitHub must authorize the machine first, the press goes there and
 * back, and the page makes the key as it returns; asked again straight after, it waits for a
 * press rather than go round again (GitHub knows this person by another account). An expired key
 * stays expired until the next press.
 */
export function usePairingKey() {
	let [key, setKey] = useState<PairingKey>({ state: "idle" });
	let attempt = useRef(0);
	let mint = useCallback(async (autoRun: boolean, go: boolean) => {
		let id = ++attempt.current;
		setKey({ state: "minting" });
		try {
			let result = await experimentRequest<
				{ key: string; expiresIn: number } | { authorize: string }
			>("/api/connector/pairing-keys", { autoRun });
			if (id !== attempt.current) return;
			if ("key" in result) {
				// Counted on this clock from the key's lifetime, so a clock that differs from the
				// server's can't make a fresh key look expired.
				setKey({
					state: "ready",
					key: result.key,
					expiresAt: Date.now() + result.expiresIn,
					autoRun,
				});
				return;
			}
			setKey({ state: "authorize", url: result.authorize, going: go });
			if (!go) return;
			try {
				sessionStorage.setItem(RETURNING_KEY, autoRun ? "auto" : "manual");
			} catch {
				// Without storage the page asks for another press as it comes back.
			}
			location.assign(result.authorize);
		} catch (error) {
			if (id === attempt.current) {
				setKey({ state: "failed", code: error instanceof Error ? error.message : "unavailable" });
			}
		}
	}, []);
	useEffect(() => {
		let autoRun = returning();
		if (autoRun !== undefined) void mint(autoRun, false);
		return () => {
			attempt.current++;
		};
	}, [mint]);
	let expiresAt = key.state === "ready" ? key.expiresAt : undefined;
	useEffect(() => {
		if (expiresAt === undefined) return;
		let timer = window.setTimeout(
			() => setKey({ state: "expired" }),
			Math.max(0, expiresAt - Date.now()),
		);
		return () => window.clearTimeout(timer);
	}, [expiresAt]);
	let generate = useCallback((autoRun: boolean) => void mint(autoRun, true), [mint]);
	let reset = useCallback(() => {
		attempt.current++;
		setKey({ state: "idle" });
	}, []);
	return { key, generate, reset };
}
