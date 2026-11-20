import { describe, expect, test } from "bun:test";

import {
	machineStoreName,
	newStorePassword,
	quotedIdentifier,
	quotedLiteral,
	scramVerifier,
} from "./names";

describe("machine store names", () => {
	test("name a machine's role and database after its Chopin id", () => {
		expect(machineStoreName("0b5e6f0e-7a7b-4c1d-9e1f-2a3b4c5d6e7f"))
			.toBe("m_0b5e6f0e7a7b4c1d9e1f2a3b4c5d6e7f");
	});

	test("give every other id its own safe name, however it is written", () => {
		let ids = [
			"0B5E6F0E-7A7B-4C1D-9E1F-2A3B4C5D6E7F",
			"0b5e6f0e-7a7b-4c1d-9e1f-2a3b4c5d6e7f",
			"machine-1",
			"machine_1",
			'Robert"); DROP ROLE postgres; --',
			"ünïcödé",
			"x".repeat(500),
			"",
		];
		let names = ids.map(machineStoreName);
		expect(new Set(names).size).toBe(ids.length);
		for (let name of names) {
			expect(name).toMatch(/^m_[a-z0-9]{1,61}$/);
			expect(Buffer.byteLength(name)).toBeLessThanOrEqual(63);
		}
		expect(machineStoreName("machine-1")).toBe(machineStoreName("machine-1"));
	});

	test("quote identifiers and literals so no input leaves its quotes", () => {
		expect(quotedIdentifier('a"b')).toBe('"a""b"');
		expect(quotedLiteral("it's")).toBe("'it''s'");
		expect(() => quotedIdentifier("")).toThrow();
		expect(() => quotedIdentifier("a\0b")).toThrow();
		expect(() => quotedLiteral("a\0b")).toThrow();
	});

	test("make a password PostgreSQL stores only as a SCRAM-SHA-256 verifier", () => {
		let password = newStorePassword();
		expect(password).toMatch(/^[A-Za-z0-9_-]{43}$/);
		expect(newStorePassword()).not.toBe(password);
		let verifier = scramVerifier(password);
		expect(verifier).toMatch(
			/^SCRAM-SHA-256\$4096:[A-Za-z0-9+/=]+\$[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]+$/,
		);
		expect(verifier).not.toContain(password);
		let salt = Buffer.alloc(16, 7);
		expect(scramVerifier(password, salt)).toBe(scramVerifier(password, salt));
		expect(scramVerifier(password)).not.toBe(verifier);
	});
});
