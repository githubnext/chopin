import { describe, expect, it } from "bun:test";

import { CHAT_CAPABILITIES, incomingFrame, MAX_SOCKET_FRAME_BYTES } from "./incoming";

function frame(overrides: Record<string, unknown> = {}): string {
	return JSON.stringify({ kind: "session:ping", rid: "request-1", ts: 0, ...overrides });
}

describe("incoming WebSocket frames", () => {
	it("advertises reference and correlated send acknowledgement support", () => {
		expect(CHAT_CAPABILITIES).toEqual({ chatReferences: true, chatSendAcks: true });
	});

	it("accepts a bounded object request envelope", () => {
		expect(incomingFrame(frame())).toMatchObject({ kind: "session:ping", rid: "request-1" });
	});

	it("rejects primitive, null, array, and malformed JSON values", () => {
		for (let value of ["null", "[]", '"text"', "1", "true", "{"]) {
			expect(incomingFrame(value)).toBeUndefined();
		}
	});

	it("rejects invalid or oversized kind and request ids", () => {
		for (
			let value of [
				frame({ kind: null }),
				frame({ kind: [] }),
				frame({ kind: "x".repeat(65) }),
				frame({ kind: "bad kind" }),
				frame({ rid: null }),
				frame({ rid: [] }),
				frame({ rid: "x".repeat(129) }),
				frame({ rid: "bad request" }),
			]
		) expect(incomingFrame(value)).toBeUndefined();
	});

	it("rejects oversized raw frames before parsing", () => {
		let oversized = `{"kind":"session:ping","rid":"request","padding":"${
			"x".repeat(MAX_SOCKET_FRAME_BYTES)
		}"}`;
		expect(Buffer.byteLength(oversized)).toBeGreaterThan(MAX_SOCKET_FRAME_BYTES);
		expect(incomingFrame(oversized)).toBeUndefined();
	});
});
