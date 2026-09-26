/**
 * Pure state machine and copy for local device-flow sign-in.
 *
 * This module holds no browser API calls. `local-login.tsx` wires the
 * reducer to `Api.*` calls, timers, `navigator.clipboard`, and `window.open`;
 * `local-login-view.tsx` renders one `LocalSignInState` with no side effects.
 */

export type LocalSignInState =
	| { status: "idle" }
	| { status: "requesting" }
	| {
		status: "waiting";
		userCode: string;
		verificationUri: string;
		expiresAt: string;
		presentationFailure?: "open" | "clipboard";
	}
	| { status: "consent"; path: string }
	| { status: "complete" }
	| { status: "cancelled" }
	| { status: "error"; message: string };

export type LocalSignInEvent =
	| { type: "start" }
	| { type: "started"; userCode: string; verificationUri: string; expiresAt: string }
	| { type: "presentation-failed"; kind: "open" | "clipboard" }
	| { type: "consent"; path: string }
	| { type: "complete" }
	| { type: "cancelled" }
	| { type: "denied" }
	| { type: "expired" }
	| { type: "failed"; message: string }
	| { type: "cancel" };

/** The exact local-expiry message from issue #157. */
export const DEVICE_CODE_EXPIRED_MESSAGE = "Device code expired before authorization completed";

/** The exact message used when GitHub reports the request was denied. */
export const DEVICE_CODE_DENIED_MESSAGE = "Authorization was denied";

export const CONSENT_TITLE = "System vault not available";

/** The three paragraphs of the plaintext-storage warning, in order, verbatim. */
export const CONSENT_BODY = [
	"The recommended secure storage (keychain, keyring, or credential manager) could not be found or accessed. You may need to install or configure one.",
	"Storing the token in the config file saves it as plain text, which is insecure. If you decline, sign-in will be cancelled and no account state will be changed.",
	"Store token in plain text config file?",
] as const;

export const CONSENT_ACCEPT_LABEL = "Yes, store in plain text (insecure)";
export const CONSENT_DECLINE_LABEL = "No, cancel sign-in";

export function localSignInReducer(
	state: LocalSignInState,
	event: LocalSignInEvent,
): LocalSignInState {
	switch (event.type) {
		case "start":
			return { status: "requesting" };
		case "started":
			return {
				status: "waiting",
				userCode: event.userCode,
				verificationUri: event.verificationUri,
				expiresAt: event.expiresAt,
			};
		case "presentation-failed":
			return state.status === "waiting" ? { ...state, presentationFailure: event.kind } : state;
		case "consent":
			return { status: "consent", path: event.path };
		case "complete":
			return { status: "complete" };
		case "cancelled":
			return { status: "cancelled" };
		case "denied":
			return { status: "error", message: DEVICE_CODE_DENIED_MESSAGE };
		case "expired":
			return { status: "error", message: DEVICE_CODE_EXPIRED_MESSAGE };
		case "failed":
			return { status: "error", message: event.message };
		case "cancel":
			return { status: "cancelled" };
		default:
			return state;
	}
}

export function waitingInstruction(userCode: string, verificationUri: string): string {
	return `Enter one-time code: ${userCode} at ${verificationUri}`;
}

export function manualFallbackMessage(
	kind: "open" | "clipboard",
	verificationUri: string,
	userCode: string,
): string {
	return kind === "open"
		? `Failed to open browser. Please visit ${verificationUri} and enter the code ${userCode} manually.`
		: `Failed to copy to clipboard. Please visit ${verificationUri} and enter the code ${userCode} manually.`;
}

export function signInErrorMessage(message: string): string {
	return `Error during sign-in: ${message}`;
}

export type CopyAndOpenResult = { openOk: boolean; clipboardOk: boolean };

/**
 * Copies the code and opens the verification URL in one user gesture.
 *
 * The clipboard write starts before `openWindow` so the promise is created
 * while the click still carries user activation and document focus; the
 * caller awaits it only after the tab attempt returns. A blocked tab or a
 * rejected clipboard write reports its own failure without undoing the other.
 */
export async function copyAndOpen(
	code: string,
	verificationUri: string,
	deps: {
		writeClipboard: (text: string) => Promise<void>;
		openWindow: (url: string) => { opener: unknown } | null;
	},
): Promise<CopyAndOpenResult> {
	let clipboardPromise: Promise<boolean>;
	try {
		clipboardPromise = deps.writeClipboard(code).then(() => true, () => false);
	} catch {
		clipboardPromise = Promise.resolve(false);
	}
	let handle: { opener: unknown } | null;
	try {
		handle = deps.openWindow(verificationUri);
		if (handle) handle.opener = null;
	} catch {
		handle = null;
	}
	let clipboardOk = await clipboardPromise;
	return { clipboardOk, openOk: handle !== null };
}
