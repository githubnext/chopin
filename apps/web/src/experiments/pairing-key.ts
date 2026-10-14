import { useCallback, useEffect, useRef, useState } from "react";
import { experimentRequest } from "./api";

/**
 * Coming back from GitHub within this long and still being asked to authorize means GitHub knows
 * this person by another account, so the card asks rather than sending them round again.
 */
export const AUTHORIZE_RETRY_MS = 2 * 60_000;
/** When the card last went to GitHub by itself, for this tab only. */
const AUTHORIZED_KEY = "chopin:machines:authorized-at";

/** How long a key has left, in the whole minutes a person reads at a glance. */
export function expiryLabel(expiresAt: number, now: number): string {
	let left = expiresAt - now;
	return left > 0 ? `Expires in ${Math.ceil(left / 60_000)} min` : "Expired";
}

/** Whether opening the card may go to GitHub by itself, given when it last did. */
export function autoAuthorize(last: number | undefined, now: number): boolean {
	return last === undefined || now - last > AUTHORIZE_RETRY_MS;
}

function lastAuthorized(): number | undefined {
	try {
		let value = Number(sessionStorage.getItem(AUTHORIZED_KEY));
		return value > 0 ? value : undefined;
	} catch {
		return undefined;
	}
}

export type PairingKey =
	| { state: "minting" }
	| { state: "ready"; key: string; expiresAt: number }
	/** GitHub authorizes the next machine first; `going` while the page is on its way there. */
	| { state: "authorize"; url: string; going: boolean }
	| { state: "expired" }
	| { state: "failed"; code: string };

/**
 * A single-use pairing key for the signed-in person while `open`, held only in memory: minted
 * as the card opens and again as it expires. Where GitHub must authorize the machine first, the
 * card's first mint goes there and back by itself; later ones wait for a press. `renew` is that
 * press, from the expired or authorize state.
 */
export function usePairingKey(open: boolean) {
	let [key, setKey] = useState<PairingKey>({ state: "minting" });
	let attempt = useRef(0);
	let mint = useCallback(async (go: "auto" | "press" | "never") => {
		let id = ++attempt.current;
		setKey({ state: "minting" });
		try {
			let result = await experimentRequest<
				{ key: string; expiresIn: number } | { authorize: string }
			>("/api/connector/pairing-keys", {});
			if (id !== attempt.current) return;
			if ("key" in result) {
				// Counted on this clock from the key's lifetime, so a clock that differs from the
				// server's can't make a fresh key look expired and ask for another at once.
				setKey({ state: "ready", key: result.key, expiresAt: Date.now() + result.expiresIn });
				return;
			}
			if (go === "never") {
				setKey({ state: "expired" });
				return;
			}
			let going = go === "press" || autoAuthorize(lastAuthorized(), Date.now());
			setKey({ state: "authorize", url: result.authorize, going });
			if (!going) return;
			try {
				sessionStorage.setItem(AUTHORIZED_KEY, String(Date.now()));
			} catch {
				// Without storage a second return asks with a button, as the guard would.
			}
			location.assign(result.authorize);
		} catch (error) {
			if (id === attempt.current) {
				setKey({ state: "failed", code: error instanceof Error ? error.message : "unavailable" });
			}
		}
	}, []);
	useEffect(() => {
		attempt.current++;
		setKey({ state: "minting" });
		if (open) void mint("auto");
	}, [open, mint]);
	// An expired key is replaced while the page is in view; one that ran out unseen waits for it.
	let expiresAt = key.state === "ready" ? key.expiresAt : undefined;
	useEffect(() => {
		if (expiresAt === undefined) return;
		let timer = window.setTimeout(() => {
			if (document.visibilityState === "hidden") setKey({ state: "expired" });
			else void mint("never");
		}, Math.max(0, expiresAt - Date.now()));
		return () => window.clearTimeout(timer);
	}, [expiresAt, mint]);
	let expired = key.state === "expired";
	useEffect(() => {
		if (!expired || !open) return;
		let visible = () => {
			if (document.visibilityState === "visible") void mint("never");
		};
		document.addEventListener("visibilitychange", visible);
		return () => document.removeEventListener("visibilitychange", visible);
	}, [expired, open, mint]);
	let renew = useCallback(() => void mint("press"), [mint]);
	return { key, renew };
}
