import { expect, test } from "bun:test";
import { AUTHORIZE_RETRY_MS, autoAuthorize, expiryLabel } from "./pairing-key";

test("a key's expiry reads in whole minutes, rounded up, until it has passed", () => {
	let now = 1_000_000;
	expect(expiryLabel(now + 10 * 60_000, now)).toBe("Expires in 10 min");
	expect(expiryLabel(now + 9 * 60_000 + 1, now)).toBe("Expires in 10 min");
	expect(expiryLabel(now + 61_000, now)).toBe("Expires in 2 min");
	expect(expiryLabel(now + 1, now)).toBe("Expires in 1 min");
	expect(expiryLabel(now, now)).toBe("Expired");
});

test("opening the card goes to GitHub by itself once, not again straight after coming back", () => {
	let now = 5_000_000;
	expect(autoAuthorize(undefined, now)).toBe(true);
	// Back from GitHub and still asked: a different account there, so the card asks instead.
	expect(autoAuthorize(now - 5_000, now)).toBe(false);
	expect(autoAuthorize(now - AUTHORIZE_RETRY_MS - 1, now)).toBe(true);
});
