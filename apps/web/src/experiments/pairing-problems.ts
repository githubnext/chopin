/**
 * What /connect says when a request fails. The server answers with a code (see `fail()` in
 * apps/server/src/experiments); people read a title that says what happened and a line that says
 * what to do next, never the code itself.
 */

export type Problem = {
	title: string;
	body: string;
	/** The failure may pass on its own, so trying again is worth offering. */
	retry: boolean;
};

const NEW_LINK = "Run chopin connect again in your terminal for a new one.";

/**
 * A pairing link that cannot be shown (`load`) or approved (`approve`). Pairings live in the
 * server's memory for five minutes, so an unknown link and an expired one look the same.
 */
export function pairingProblem(
	code: string,
	step: "load" | "approve",
	repository?: string,
): Problem {
	switch (code) {
		case "pairing-expired":
			return {
				title: "This link has expired",
				body: `Pairing links last a few minutes. ${NEW_LINK}`,
				retry: false,
			};
		case "pairing-forbidden":
		case "already-paired":
			return {
				title: "Another account approved this link",
				body: `A link pairs a machine for one GitHub account. ${NEW_LINK}`,
				retry: false,
			};
		case "pairing-capacity":
			return {
				title: "Chopin is pairing too many machines",
				body: "Wait a minute, then run chopin connect again in your terminal.",
				retry: false,
			};
		case "repository-forbidden":
			return {
				title: "You can't connect this repository",
				body: `Connecting a checkout of ${
					repository ?? "a repository"
				} needs write access to it on GitHub. Ask an owner for access, or connect a repository you can push to.`,
				retry: false,
			};
		case "authentication-required":
			return {
				title: "Sign in to connect this machine",
				body:
					"Your Chopin session has ended. Sign in again, then open the link from your terminal.",
				retry: false,
			};
		default:
			return step === "load"
				? {
					title: "Couldn't open this pairing",
					body: "Chopin didn't answer. Check your connection, then try again.",
					retry: true,
				}
				: {
					title: "Couldn't connect this machine",
					body: "Chopin didn't answer. Check your connection, then try again while the link lasts.",
					retry: true,
				};
	}
}

/** The person's machine list could not load; the page keeps asking every few seconds. */
export function listProblem(code: string): Problem {
	if (code === "authentication-required") {
		return {
			title: "Sign in to see your machines",
			body: "Your Chopin session has ended. Reload the page to sign in again.",
			retry: false,
		};
	}
	return {
		title: "Couldn't load your machines",
		body: "Chopin keeps trying every few seconds. Check your connection, or try again now.",
		retry: true,
	};
}

/** A single-use pairing key for the setup command could not be made. */
export function keyProblem(code: string): Problem {
	if (code === "pairing-key-rate-limited") {
		return {
			title: "Too many keys at once",
			body: "You made several keys in the last few minutes. Wait a few minutes, then try again.",
			retry: true,
		};
	}
	if (code === "authentication-required") {
		return {
			title: "Sign in to add a machine",
			body: "Your Chopin session has ended. Reload the page to sign in again.",
			retry: false,
		};
	}
	return {
		title: "Couldn't make a key",
		body: "Chopin didn't answer. Check your connection, then try again.",
		retry: true,
	};
}
