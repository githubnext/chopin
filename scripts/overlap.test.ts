import { describe, expect, it } from "bun:test";

import {
	BUDGET_MS,
	CADDY_IMAGE,
	handOver,
	measureHandover,
	parseArguments,
	type Sample,
	type Slot,
	type Slots,
} from "./overlap";

const quick = { warmMs: 0, settleMs: 0 };
const read = (path: string) => Bun.file(new URL(path, import.meta.url)).text();

const sample = (startedAt: number, endedAt: number, status?: number): Sample => ({
	method: "GET",
	path: "/",
	startedAt,
	endedAt,
	status,
});

describe("measuring a hand-over", () => {
	it("reports the time from the release to the first answer after it, and what was held", () => {
		let report = measureHandover([
			sample(0, 10, 200),
			// Sent before the release, held by the proxy, answered by the new process.
			sample(480, 640, 200),
			sample(499, 700, 200),
			sample(650, 660, 200),
		], 500);
		expect(report).toMatchObject({
			requests: 4,
			failures: [],
			gapMs: 140,
			longestMs: 201,
			heldAcrossRelease: 2,
		});
	});

	it("counts every answer that is not 2xx, or missing, as a failure and never as the first served", () => {
		let report = measureHandover([
			sample(490, 510, 502),
			sample(495, 520, undefined),
			sample(500, 560, 503),
			sample(600, 610, 204),
		], 500);
		expect(report.failures.map(failure => failure.status)).toEqual([502, undefined, 503]);
		expect(report.gapMs).toBe(110);
	});

	it("has no gap when nothing was answered after the release", () => {
		expect(measureHandover([sample(0, 10, 200)], 500).gapMs).toBeUndefined();
	});

	it("keeps the design's budget inside the browser's grace", () => {
		expect(BUDGET_MS).toBeLessThan(1_500);
	});
});

function fake(serving: Slot | undefined, states: (string | undefined)[]) {
	let calls: string[] = [];
	let current = serving;
	let slots: Slots = {
		serving: async () => current,
		state: async slot => {
			calls.push(`state ${slot}`);
			return states.shift();
		},
		start: async slot => void calls.push(`start ${slot}`),
		stop: async slot => {
			calls.push(`stop ${slot}`);
			current = slot === "a" ? "b" : "a";
			return 0;
		},
		log: async slot => `chopin: 3 readiness check(s) answered not ready\nother ${slot}`,
	};
	let probe = {
		start: () => void calls.push("probe start"),
		stop: async (): Promise<Sample[]> => {
			calls.push("probe stop");
			return [sample(0, 10, 200), sample(450, 700, 200)];
		},
	};
	let lease = () => ({
		released: Promise.resolve(500),
		close: async () => void calls.push("lease closed"),
	});
	return { calls, slots, probe, lease };
}

describe("a deploy that overlaps two slots", () => {
	it("starts the idle slot, stops the serving one only once the idle one waits, and reports the cut", async () => {
		let { calls, slots, probe, lease } = fake("a", [undefined, undefined, "standby"]);
		let done = await handOver(slots, lease, probe, quick);

		expect(done).toMatchObject({ from: "a", to: "b", exit: 0 });
		expect(done.report.gapMs).toBe(200);
		expect(done.cut).toEqual(["chopin: 3 readiness check(s) answered not ready"]);
		let order = calls.filter(call => !call.startsWith("state"));
		expect(order.slice(0, 3)).toEqual(["probe start", "start b", "stop a"]);
		// The serving slot is stopped after the idle one was seen waiting, and not before.
		expect(calls.filter(call => call === "state b")).toHaveLength(3);
		expect(calls.indexOf("stop a")).toBeGreaterThan(calls.lastIndexOf("state b"));
	});

	it("gives the proxy time to find the new slot before the old one is stopped", async () => {
		let { calls, slots, probe, lease } = fake("a", ["standby"]);
		let stopped = 0;
		let stop = slots.stop;
		slots.stop = async slot => {
			stopped = performance.now();
			return stop(slot);
		};
		let seen = 0;
		let state = slots.state;
		slots.state = async slot => {
			seen = performance.now();
			return state(slot);
		};
		await handOver(slots, lease, probe, { warmMs: 120, settleMs: 0 });
		expect(stopped - seen).toBeGreaterThanOrEqual(115);
		expect(calls.indexOf("stop a")).toBeGreaterThan(calls.indexOf("state b"));
	});

	it("takes the other slot when the serving one is b, and accepts an idle slot that is already ready", async () => {
		let { calls, slots, probe, lease } = fake("b", ["ready"]);
		let done = await handOver(slots, lease, probe, quick);
		expect(done).toMatchObject({ from: "b", to: "a" });
		expect(calls).toContain("start a");
		expect(calls.indexOf("start a")).toBeLessThan(calls.indexOf("stop b"));
	});

	it("refuses to deploy when no slot is serving, without starting anything", async () => {
		let { calls, slots, probe, lease } = fake(undefined, []);
		await expect(handOver(slots, lease, probe, quick)).rejects.toThrow("no slot is serving");
		expect(calls).toEqual([]);
	});
});

describe("arguments", () => {
	it("names the image for a compose deploy, from the flag or the environment", () => {
		expect(parseArguments(["compose", "deploy", "--image", "chopin:next"], {})).toMatchObject({
			mode: "compose",
			command: "deploy",
			image: "chopin:next",
			port: 8080,
			clients: 4,
			warmMs: 1_500,
			maxGapMs: 1_500,
		});
		expect(parseArguments(["compose", "up"], { CHOPIN_IMAGE: "chopin:env" })).toMatchObject({
			command: "up",
			image: "chopin:env",
		});
		expect(() => parseArguments(["compose", "deploy"], {})).toThrow("--image");
		expect(parseArguments(["compose", "down"], {})).toMatchObject({ command: "down" });
		expect(() => parseArguments(["compose", "restart", "--image", "x"], {})).toThrow(
			"unknown command",
		);
	});

	it("takes a database for processes, and whole numbers only", () => {
		expect(parseArguments(["processes", "--database", "postgresql://x", "--hand-overs", "5"], {}))
			.toMatchObject({ mode: "processes", database: "postgresql://x", handOvers: 5 });
		expect(() => parseArguments(["processes"], {})).toThrow("--database");
		expect(() => parseArguments(["processes", "--database", "x", "--port", "eighty"], {})).toThrow(
			"--port",
		);
		expect(() => parseArguments(["processes", "--database", "x", "--clients", "0"], {})).toThrow(
			"--clients",
		);
		expect(() => parseArguments([], {})).toThrow("usage");
	});
});

describe("the reference configuration", () => {
	let compose = async () =>
		Bun.YAML.parse(await read("../deploy/overlap/compose.yaml")) as {
			services: Record<string, {
				image?: string;
				environment?: Record<string, string>;
				stop_grace_period?: string;
				depends_on?: unknown;
			}>;
		};

	it("sets the unready window to the proxy's health interval plus a margin, on both slots", async () => {
		let caddyfile = await read("../deploy/overlap/Caddyfile");
		let interval = Number(/health_interval (\d+)ms/.exec(caddyfile)?.[1]);
		expect(interval).toBe(250);
		let services = (await compose()).services;
		for (let slot of ["chopin-a", "chopin-b"]) {
			let environment = services[slot]!.environment!;
			expect(environment.HANDOVER).toBe("wait");
			expect(Number(environment.HANDOVER_UNREADY_MS)).toBeGreaterThanOrEqual(interval + 50);
			expect(services[slot]!.stop_grace_period).toBe("30s");
		}
	});

	it("holds requests for a ready upstream and retries quickly, and starts no slot with the proxy", async () => {
		let caddyfile = await read("../deploy/overlap/Caddyfile");
		expect(caddyfile).toContain("lb_try_duration 5s");
		expect(caddyfile).toContain("lb_try_interval 100ms");
		expect(caddyfile).toContain("health_uri /api/health/ready");
		expect(caddyfile).not.toContain("lb_retry_match");
		let { caddy } = (await compose()).services;
		expect(caddy!.image).toBe(CADDY_IMAGE);
		// Naming a slot is what starts it alone: the proxy must not pull the other one up.
		expect(caddy!.depends_on).toBeUndefined();
	});

	it("checks liveness, which a slot waiting in standby answers, from the image", async () => {
		let dockerfile = await read("../Dockerfile");
		expect(dockerfile).toContain("/api/health/live");
		expect(dockerfile).not.toMatch(/HEALTHCHECK[^\n]*\n[^\n]*api\/session/);
	});
});
