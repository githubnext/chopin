import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";

import { RESTART_QUIET_MS } from "../../packages/protocol/restart";
import { BASE_DELAY, MAX_DELAY, next, RESCUE_AT, RESTART_JITTER_MS } from "./ladder";

describe("the reconnect ladder", () => {
	it("keeps the constants the tab's own wire keeps", () => {
		let wire = readFileSync(new URL("../../apps/web/src/wire.ts", import.meta.url), "utf8");
		let constant = (name: string) =>
			Number(new RegExp(`const ${name} = ([\\d_]+);`).exec(wire)?.[1]?.replaceAll("_", ""));
		expect(BASE_DELAY).toBe(constant("BASE_DELAY"));
		expect(MAX_DELAY).toBe(constant("MAX_DELAY"));
		expect(RESCUE_AT).toBe(constant("RESCUE_AT"));
	});

	it("tries a restart the server announced at once, after a jittered moment and with no probe", () => {
		let lowest = next({ restarting: true, attempts: 0, lostAt: 0, now: 0, random: () => 0 });
		let highest = next({ restarting: true, attempts: 0, lostAt: 0, now: 0, random: () => 0.999 });
		expect(lowest).toEqual({ probe: false, delayMs: 0 });
		expect(highest.probe).toBe(false);
		expect(highest.delayMs).toBeLessThan(1_000);
	});

	it("spreads the first attempt over the jitter it is given, which is the tab's own by default", () => {
		let first = (jitterMs?: number) =>
			next({ restarting: true, attempts: 0, lostAt: 0, now: 0, random: () => 0.5, jitterMs });
		expect(first()).toEqual({ probe: false, delayMs: RESTART_JITTER_MS / 2 });
		expect(first(200)).toEqual({ probe: false, delayMs: 100 });
		expect(first(0)).toEqual({ probe: false, delayMs: 0 });
	});

	it("probes before every later attempt and waits about a second while the restart is quiet", () => {
		let early = next({ restarting: true, attempts: 1, lostAt: 0, now: 500, random: () => 0 });
		let late = next({ restarting: true, attempts: 3, lostAt: 0, now: 4_000, random: () => 0.999 });
		expect(early).toEqual({ probe: true, delayMs: 250 });
		expect(late.probe).toBe(true);
		expect(late.delayMs).toBeGreaterThanOrEqual(250);
		expect(late.delayMs).toBeLessThan(1_000);
	});

	it("returns to the backoff after the quiet, and never waits past the rescue point while it is ahead", () => {
		let after = next({
			restarting: true,
			attempts: 4,
			lostAt: 0,
			now: RESTART_QUIET_MS + 1,
			random: () => 0.5,
		});
		expect(after.probe).toBe(true);
		expect(after.delayMs).toBe(Math.min(BASE_DELAY * 2 ** 4, MAX_DELAY));
		let lost = next({ restarting: false, attempts: 1, lostAt: 0, now: 100, random: () => 0.999 });
		expect(lost).toEqual({ probe: true, delayMs: RESCUE_AT - 100 });
	});
});
