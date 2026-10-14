import { expect, test } from "bun:test";
import { listProblem, pairingProblem } from "./pairing-problems";

const PAIRING_CODES = [
	"pairing-expired",
	"pairing-forbidden",
	"pairing-capacity",
	"already-paired",
	"repository-forbidden",
	"authentication-required",
	"origin-forbidden",
	"invalid-request",
	"unavailable",
	"Failed to fetch",
	"something-new",
];

test("an expired pairing link says so and how to get a new one", () => {
	expect(pairingProblem("pairing-expired", "load")).toEqual({
		title: "This link has expired",
		body:
			"Pairing links last a few minutes. Run chopin connect again in your terminal for a new one.",
		retry: false,
	});
});

test("a repository the person cannot push to is named, with what access it needs", () => {
	expect(pairingProblem("repository-forbidden", "load", "octo-org/score").body)
		.toBe(
			"Connecting a checkout of octo-org/score needs write access to it on GitHub. Ask an owner for access, or connect a repository you can push to.",
		);
});

test("only failures that may pass on their own offer to try again", () => {
	expect(pairingProblem("unavailable", "load").retry).toBe(true);
	expect(pairingProblem("Failed to fetch", "approve").retry).toBe(true);
	expect(pairingProblem("already-paired", "approve").retry).toBe(false);
});

test("no pairing failure shows the server's code", () => {
	for (let code of PAIRING_CODES) {
		for (let step of ["load", "approve"] as const) {
			let problem = pairingProblem(code, step, "octo-org/score");
			expect(problem.title).not.toContain(code);
			expect(problem.body).not.toContain(code);
			expect(problem.title).toMatch(/^[A-Z]/);
		}
	}
});

test("a machine list that fails to load says Chopin keeps trying, in plain words", () => {
	for (let code of ["authentication-required", "unavailable", "Failed to fetch", "odd"]) {
		let problem = listProblem(code);
		expect(problem.body).not.toContain(code);
	}
	expect(listProblem("unavailable").title).toBe("Couldn't load your machines");
	expect(listProblem("authentication-required").title).toBe("Sign in to see your machines");
});
