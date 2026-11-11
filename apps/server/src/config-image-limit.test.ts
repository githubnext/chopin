import { expect, test } from "bun:test";
import { configured } from "./config-conversation.test-fixtures";

test("MAX_STORED_IMAGE_BYTES defaults to 10 MiB", () => {
	expect(configured().imageMaxBytes).toBe(10_485_760);
});

test("MAX_STORED_IMAGE_BYTES accepts whole bytes within its bounds", () => {
	for (let value of ["1048576", "2097152", "10485760", "268435456"]) {
		expect(configured({ MAX_STORED_IMAGE_BYTES: value }).imageMaxBytes).toBe(Number(value));
	}
});

test("MAX_STORED_IMAGE_BYTES rejects out-of-range and malformed values", () => {
	for (let value of ["", "1048575", "268435457", "-1", "1e7", "10.5", "10 MiB", "0x400"]) {
		expect(() => configured({ MAX_STORED_IMAGE_BYTES: value })).toThrow(
			"MAX_STORED_IMAGE_BYTES must be an integer between 1048576 and 268435456 bytes",
		);
	}
});
