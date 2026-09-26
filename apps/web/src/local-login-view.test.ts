import { describe, expect, it } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { LocalLoginView } from "./local-login-view";

import type { LocalSignInState } from "./local-sign-in";

function markup(state: LocalSignInState): string {
	return renderToStaticMarkup(createElement(LocalLoginView, {
		onCancel() {},
		onConsentDecision() {},
		onCopyAndOpen() {},
		onStart() {},
		state,
	}));
}

describe("LocalLoginView", () => {
	it("offers a sign-in action while idle", () => {
		let result = markup({ status: "idle" });
		expect(result).toContain("Open your workspace");
		expect(result).toContain("Sign in with GitHub");
	});

	it("shows the exact device-code request status while requesting", () => {
		expect(markup({ status: "requesting" })).toContain("Waiting for device code...");
	});

	it("shows the exact waiting status and a clickable verification link", () => {
		let result = markup({
			status: "waiting",
			userCode: "ABCD-1234",
			verificationUri: "https://github.com/login/device",
			expiresAt: "2026-09-26T00:15:00.000Z",
		});
		expect(result).toContain("Waiting for authorization...");
		expect(result).toContain("Enter one-time code: <strong>ABCD-1234</strong> at");
		expect(result).toContain(
			'<a href="https://github.com/login/device" rel="noopener noreferrer" target="_blank">https://github.com/login/device</a>',
		);
		expect(result).toContain("Copy code and open GitHub");
		expect(result).not.toContain("Failed to open browser");
		expect(result).not.toContain("Failed to copy to clipboard");
	});

	it("shows the exact manual fallback message for a blocked tab, without cancelling", () => {
		let result = markup({
			status: "waiting",
			userCode: "ABCD-1234",
			verificationUri: "https://github.com/login/device",
			expiresAt: "2026-09-26T00:15:00.000Z",
			presentationFailure: "open",
		});
		expect(result).toContain(
			"Failed to open browser. Please visit https://github.com/login/device and enter the code ABCD-1234 manually.",
		);
		expect(result).toContain("Copy code and open GitHub");
	});

	it("shows the exact manual fallback message for a rejected clipboard write", () => {
		let result = markup({
			status: "waiting",
			userCode: "ABCD-1234",
			verificationUri: "https://github.com/login/device",
			expiresAt: "2026-09-26T00:15:00.000Z",
			presentationFailure: "clipboard",
		});
		expect(result).toContain(
			"Failed to copy to clipboard. Please visit https://github.com/login/device and enter the code ABCD-1234 manually.",
		);
	});

	// The consent prompt renders through `createPortal`, which needs a real
	// `document` and is intentionally left to Playwright coverage, matching
	// this project's rule against simulating DOM APIs in `bun test`. Its
	// exact copy is still covered as pure strings in `local-sign-in.test.ts`.

	it("offers a retry action after cancellation", () => {
		let result = markup({ status: "cancelled" });
		expect(result).toContain("Sign-in was cancelled.");
		expect(result).toContain("Sign in with GitHub");
	});

	it("shows the exact error format with Retry and Cancel controls", () => {
		let result = markup({
			status: "error",
			message: "Device code expired before authorization completed",
		});
		expect(result).toContain(
			"Error during sign-in: Device code expired before authorization completed",
		);
		expect(result).toContain(">Retry<");
		expect(result).toContain(">Cancel<");
	});
});
