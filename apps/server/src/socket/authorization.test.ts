import { expect, test } from "bun:test";
import { refreshAuthorization } from "./authorization";

import type { AuthorizationResult } from "../wire";

test("ordinary callers share a pending authorization check", async () => {
	let gate = Promise.withResolvers<AuthorizationResult>();
	let calls: boolean[] = [];
	let state = {};
	let check = (forced: boolean) => {
		calls.push(forced);
		return gate.promise;
	};
	let first = refreshAuthorization(state, false, check);
	let second = refreshAuthorization(state, false, check);
	expect(calls).toEqual([false]);
	gate.resolve("allowed");
	expect(await first).toBe("allowed");
	expect(await second).toBe("allowed");
	expect(calls).toEqual([false]);
});

test("a forced read rechecks GitHub after a cached ordinary check was already in flight", async () => {
	let gate = Promise.withResolvers<AuthorizationResult>();
	let calls: boolean[] = [];
	let hasPull = true;
	let state = {};
	let check = (forced: boolean) => {
		calls.push(forced);
		return forced
			? Promise.resolve<AuthorizationResult>(hasPull ? "allowed" : "denied")
			: gate.promise;
	};
	let ordinary = refreshAuthorization(state, false, check);
	let forced = refreshAuthorization(state, true, check);
	expect(calls).toEqual([false]);
	hasPull = false;
	gate.resolve("allowed");
	expect(await ordinary).toBe("allowed");
	expect(await forced).toBe("denied");
	expect(calls).toEqual([false, true]);
});

test("forced callers retain denied and unavailable in-flight results", async () => {
	for (let outcome of ["denied", "unavailable"] as const) {
		let gate = Promise.withResolvers<AuthorizationResult>();
		let calls: boolean[] = [];
		let state = {};
		let check = (forced: boolean) => {
			calls.push(forced);
			return gate.promise;
		};
		let ordinary = refreshAuthorization(state, false, check);
		let forced = refreshAuthorization(state, true, check);
		gate.resolve(outcome);
		expect(await ordinary).toBe(outcome);
		expect(await forced).toBe(outcome);
		expect(calls).toEqual([false]);
	}
});
