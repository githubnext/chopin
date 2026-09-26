import { describe, expect, it } from "bun:test";

import {
	CONSENT_ACCEPT_LABEL,
	CONSENT_BODY,
	CONSENT_DECLINE_LABEL,
	CONSENT_TITLE,
	copyAndOpen,
	DEVICE_CODE_DENIED_MESSAGE,
	DEVICE_CODE_EXPIRED_MESSAGE,
	localSignInReducer,
	manualFallbackMessage,
	signInErrorMessage,
	waitingInstruction,
} from "./local-sign-in";

import type { LocalSignInState } from "./local-sign-in";

describe("local sign-in reducer", () => {
	it("moves from idle through waiting to complete on a direct grant", () => {
		let state: LocalSignInState = { status: "idle" };
		state = localSignInReducer(state, { type: "start" });
		expect(state).toEqual({ status: "requesting" });

		state = localSignInReducer(state, {
			type: "started",
			userCode: "ABCD-1234",
			verificationUri: "https://github.com/login/device",
			expiresAt: "2026-09-26T00:15:00.000Z",
		});
		expect(state).toEqual({
			status: "waiting",
			userCode: "ABCD-1234",
			verificationUri: "https://github.com/login/device",
			expiresAt: "2026-09-26T00:15:00.000Z",
		});

		expect(localSignInReducer(state, { type: "complete" })).toEqual({ status: "complete" });
	});

	it("routes an authorized grant through the consent path when the vault is unavailable", () => {
		let waiting: LocalSignInState = {
			status: "waiting",
			userCode: "ABCD-1234",
			verificationUri: "https://github.com/login/device",
			expiresAt: "2026-09-26T00:15:00.000Z",
		};
		let consenting = localSignInReducer(waiting, {
			type: "consent",
			path: "/home/user/.config/chopin/abc.json",
		});
		expect(consenting).toEqual({
			status: "consent",
			path: "/home/user/.config/chopin/abc.json",
		});
		expect(localSignInReducer(consenting, { type: "cancelled" })).toEqual({
			status: "cancelled",
		});
	});

	it("records a presentation failure only while waiting, without cancelling the attempt", () => {
		let waiting: LocalSignInState = {
			status: "waiting",
			userCode: "ABCD-1234",
			verificationUri: "https://github.com/login/device",
			expiresAt: "2026-09-26T00:15:00.000Z",
		};
		expect(localSignInReducer(waiting, { type: "presentation-failed", kind: "clipboard" }))
			.toEqual({ ...waiting, presentationFailure: "clipboard" });
		expect(
			localSignInReducer({ status: "idle" }, { type: "presentation-failed", kind: "open" }),
		).toEqual({ status: "idle" });
	});

	it("uses the exact local-expiry and denial messages as terminal errors", () => {
		let waiting: LocalSignInState = {
			status: "waiting",
			userCode: "ABCD-1234",
			verificationUri: "https://github.com/login/device",
			expiresAt: "2026-09-26T00:15:00.000Z",
		};
		expect(localSignInReducer(waiting, { type: "expired" })).toEqual({
			status: "error",
			message: DEVICE_CODE_EXPIRED_MESSAGE,
		});
		expect(localSignInReducer(waiting, { type: "denied" })).toEqual({
			status: "error",
			message: DEVICE_CODE_DENIED_MESSAGE,
		});
		expect(localSignInReducer(waiting, { type: "failed", message: "network unavailable" }))
			.toEqual({ status: "error", message: "network unavailable" });
	});
});

describe("local sign-in copy", () => {
	it("matches the issue's verbatim instruction and fallback strings", () => {
		expect(waitingInstruction("ABCD-1234", "https://github.com/login/device")).toBe(
			"Enter one-time code: ABCD-1234 at https://github.com/login/device",
		);
		expect(manualFallbackMessage("open", "https://github.com/login/device", "ABCD-1234")).toBe(
			"Failed to open browser. Please visit https://github.com/login/device and enter the code ABCD-1234 manually.",
		);
		expect(manualFallbackMessage("clipboard", "https://github.com/login/device", "ABCD-1234"))
			.toBe(
				"Failed to copy to clipboard. Please visit https://github.com/login/device and enter the code ABCD-1234 manually.",
			);
		expect(signInErrorMessage(DEVICE_CODE_EXPIRED_MESSAGE)).toBe(
			"Error during sign-in: Device code expired before authorization completed",
		);
	});

	it("matches the issue's verbatim plaintext-storage warning and choices", () => {
		expect(CONSENT_TITLE).toBe("System vault not available");
		expect(CONSENT_BODY).toEqual([
			"The recommended secure storage (keychain, keyring, or credential manager) could not be found or accessed. You may need to install or configure one.",
			"Storing the token in the config file saves it as plain text, which is insecure. If you decline, sign-in will be cancelled and no account state will be changed.",
			"Store token in plain text config file?",
		]);
		expect(CONSENT_ACCEPT_LABEL).toBe("Yes, store in plain text (insecure)");
		expect(CONSENT_DECLINE_LABEL).toBe("No, cancel sign-in");
	});
});

describe("copyAndOpen", () => {
	it("starts the clipboard write before opening the tab, in the same call", () => {
		let order: string[] = [];
		let clipboardStarted = false;
		return copyAndOpen("ABCD-1234", "https://github.com/login/device", {
			writeClipboard: async text => {
				clipboardStarted = true;
				order.push(`clipboard:${text}`);
			},
			openWindow: url => {
				// The clipboard write must already have started synchronously
				// before this call, so the same gesture covers both actions.
				expect(clipboardStarted).toBe(true);
				order.push(`open:${url}`);
				return { opener: "self" };
			},
		}).then(result => {
			expect(result).toEqual({ openOk: true, clipboardOk: true });
			expect(order).toEqual([
				"clipboard:ABCD-1234",
				"open:https://github.com/login/device",
			]);
		});
	});

	it("reports a blocked tab without failing the clipboard write", async () => {
		let result = await copyAndOpen("ABCD-1234", "https://github.com/login/device", {
			writeClipboard: async () => {},
			openWindow: () => null,
		});
		expect(result).toEqual({ openOk: false, clipboardOk: true });
	});

	it("reports a rejected clipboard write without failing the tab open", async () => {
		let result = await copyAndOpen("ABCD-1234", "https://github.com/login/device", {
			writeClipboard: async () => {
				throw new Error("denied");
			},
			openWindow: url => ({ opener: url }),
		});
		expect(result).toEqual({ openOk: true, clipboardOk: false });
	});

	it("still opens GitHub when clipboard access throws synchronously", async () => {
		let opened = false;
		let result = await copyAndOpen("ABCD-1234", "https://github.com/login/device", {
			writeClipboard: () => {
				throw new Error("clipboard unavailable");
			},
			openWindow: () => {
				opened = true;
				return { opener: null };
			},
		});
		expect(opened).toBe(true);
		expect(result).toEqual({ openOk: true, clipboardOk: false });
	});

	it("reports an opening exception without cancelling a pending clipboard write", async () => {
		let result = await copyAndOpen("ABCD-1234", "https://github.com/login/device", {
			writeClipboard: async () => {},
			openWindow: () => {
				throw new Error("popup blocked");
			},
		});
		expect(result).toEqual({ openOk: false, clipboardOk: true });
	});
	it("clears window.opener instead of passing the noopener feature", () => {
		let handle: { opener: unknown } = { opener: "self" };
		return copyAndOpen("ABCD-1234", "https://github.com/login/device", {
			writeClipboard: async () => {},
			openWindow: () => handle,
		}).then(() => {
			expect(handle.opener).toBeNull();
		});
	});
});
