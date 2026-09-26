import { useEffect, useReducer, useRef } from "react";

import * as Api from "./api";
import { LocalLoginView } from "./local-login-view";
import { copyAndOpen, localSignInReducer } from "./local-sign-in";

import type { LocalSignInEvent } from "./local-sign-in";

const POLL_INTERVAL_MS = 1500;

function safeMessage(reason: unknown, fallback: string): string {
	return reason instanceof Error && reason.message ? reason.message : fallback;
}

/** Turns one `Api.DeviceAuthorizationStatus` into the matching reducer event. */
function statusEvent(result: Api.DeviceAuthorizationStatus): LocalSignInEvent | undefined {
	switch (result.status) {
		case "waiting":
			return {
				type: "started",
				userCode: result.userCode,
				verificationUri: result.verificationUri,
				expiresAt: result.expiresAt,
			};
		case "authorized":
			return undefined;
		case "consent":
			return { type: "consent", path: result.path };
		case "complete":
			return { type: "complete" };
		case "expired":
			return { type: "expired" };
		case "denied":
			return { type: "denied" };
		case "cancelled":
			return { type: "cancelled" };
		case "failed":
			return { type: "failed", message: result.message };
	}
}

/**
 * Wires the pure local sign-in reducer to the device-flow API, the browser
 * poll timer, and clipboard/tab access. Rendering lives in `LocalLoginView`.
 */
export function LocalLogin() {
	let [state, dispatch] = useReducer(localSignInReducer, { status: "idle" });
	let pollTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
	let completing = useRef(false);
	let began = useRef(false);

	let start = async () => {
		began.current = true;
		dispatch({ type: "start" });
		try {
			let result = await Api.startDeviceAuthorization();
			let event = statusEvent(result);
			if (event) dispatch(event);
		} catch (reason) {
			dispatch({ type: "failed", message: safeMessage(reason, "Could not start sign-in.") });
		}
	};

	let cancel = async () => {
		began.current = true;
		dispatch({ type: "cancel" });
		try {
			await Api.cancelDeviceAuthorization();
		} catch {
			// The attempt is already cancelled locally; a failed cancel request
			// does not change what the user needs to do next.
		}
	};

	let decide = async (accept: boolean) => {
		try {
			let result = await Api.consentDeviceAuthorization(accept);
			if (result.status === "complete") {
				location.reload();
				return;
			}
			let event = statusEvent(result);
			if (event) dispatch(event);
		} catch (reason) {
			dispatch({ type: "failed", message: safeMessage(reason, "Could not save your decision.") });
		}
	};

	let copyAndOpenCode = async () => {
		if (state.status !== "waiting") return;
		let { userCode, verificationUri } = state;
		let result = await copyAndOpen(userCode, verificationUri, {
			openWindow: url => window.open(url, "_blank"),
			writeClipboard: text => navigator.clipboard.writeText(text),
		});
		if (!result.openOk) dispatch({ type: "presentation-failed", kind: "open" });
		else if (!result.clipboardOk) dispatch({ type: "presentation-failed", kind: "clipboard" });
	};

	let finish = async (active: () => boolean) => {
		if (completing.current) return;
		completing.current = true;
		try {
			let completed = await Api.completeDeviceAuthorization();
			if (!active()) return;
			if (completed.status === "complete") {
				location.reload();
				return;
			}
			let event = statusEvent(completed);
			if (event) dispatch(event);
		} catch (reason) {
			if (active()) {
				dispatch({
					type: "failed",
					message: safeMessage(reason, "Could not finish sign-in."),
				});
			}
		} finally {
			completing.current = false;
		}
	};

	useEffect(() => {
		let active = true;
		void Api.deviceAuthorizationStatus().then(result => {
			if (!active || began.current || result.status === "cancelled") return;
			if (result.status === "authorized") {
				void finish(() => active && !began.current);
				return;
			}
			let event = statusEvent(result);
			if (event) dispatch(event);
		}, () => {});
		return () => {
			active = false;
		};
	}, []);

	useEffect(() => {
		if (state.status !== "waiting") return;
		let active = true;
		let poll = async () => {
			try {
				let result = await Api.deviceAuthorizationStatus();
				if (!active) return;
				if (result.status === "authorized") {
					if (completing.current) {
						pollTimer.current = setTimeout(poll, POLL_INTERVAL_MS);
						return;
					}
					await finish(() => active);
					return;
				}
				let event = statusEvent(result);
				if (event) dispatch(event);
			} catch {
				// Transient polling failures do not end the attempt; the next
				// tick tries again until the device code expires.
			}
			if (active) pollTimer.current = setTimeout(poll, POLL_INTERVAL_MS);
		};
		pollTimer.current = setTimeout(poll, POLL_INTERVAL_MS);
		return () => {
			active = false;
			clearTimeout(pollTimer.current);
		};
	}, [state.status]);

	return (
		<LocalLoginView
			onCancel={() => void cancel()}
			onConsentDecision={accept => void decide(accept)}
			onCopyAndOpen={() => void copyAndOpenCode()}
			onStart={() => void start()}
			state={state}
		/>
	);
}
