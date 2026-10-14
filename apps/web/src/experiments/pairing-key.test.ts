import { expect, test } from "bun:test";
import { expiryLabel } from "./pairing-key";

test("a key's expiry reads in whole minutes, rounded up, until it has passed", () => {
	let now = 1_000_000;
	expect(expiryLabel(now + 10 * 60_000, now)).toBe("Single use · expires in 10 min");
	expect(expiryLabel(now + 9 * 60_000 + 1, now)).toBe("Single use · expires in 10 min");
	expect(expiryLabel(now + 61_000, now)).toBe("Single use · expires in 2 min");
	expect(expiryLabel(now + 1, now)).toBe("Single use · expires in 1 min");
	expect(expiryLabel(now, now)).toBe("Expired");
});
