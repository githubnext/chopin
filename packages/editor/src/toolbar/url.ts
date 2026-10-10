/**
 * Asking for a URL.
 *
 * Checking what comes back is not politeness. An address the dialect rejects
 * would apply locally, sync cleanly, then fail validation on the server —
 * which cannot undo a Yjs transaction and so rebuilds the room's epoch,
 * costing everyone present their undo history. The cheapest place to catch it
 * is before it becomes a node.
 */

import { HIDDEN_URL_CHARACTERS, leavesRepository } from "@chopin/dialect";

export type UrlRules = {
	protocols: readonly string[];
	/**
	 * Whether a value with no protocol is acceptable.
	 *
	 * True for links, where a repository-relative path is meaningful. For
	 * images, which have nothing in the repository to resolve against, the one
	 * relative form the dialect allows: a path to an image Chopin hosts.
	 */
	relative: boolean | RegExp;
};

const SCHEME = /^[a-z][a-z0-9+.-]*:/i;

export function acceptable(value: string, rules: UrlRules): boolean {
	if (HIDDEN_URL_CHARACTERS.test(value)) return false;
	if (!SCHEME.test(value)) {
		return rules.relative instanceof RegExp
			? rules.relative.test(value)
			: rules.relative && !leavesRepository(value);
	}
	try {
		return rules.protocols.includes(new URL(value).protocol);
	} catch {
		return false;
	}
}

/** What the author typed, made safe to apply, or why it cannot be. */
export type Checked = { url: string; problem?: undefined } | { url?: undefined; problem: string };

/** Extensions that make `README.md` a repository file rather than a Moldovan domain. */
const FILES = new Set([
	"css",
	"html",
	"js",
	"json",
	"jsx",
	"md",
	"mdx",
	"png",
	"svg",
	"toml",
	"ts",
	"tsx",
	"txt",
	"yaml",
	"yml",
]);

const EMAIL = /^[^\s@/]+@[^\s@/]+\.[a-z]{2,}$/i;
const HOST = /^((?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+([a-z]{2,}))(?::\d+)?(?:[/?#]|$)/i;
const LOCALHOST = /^localhost(?::\d+)?(?:[/?#]|$)/i;

/**
 * Accept what people actually type.
 *
 * A bare `example.com` would otherwise pass as a relative path and point into
 * the repository, so a recognisable host or address gains the protocol it was
 * plainly meant to have before the rules judge it.
 */
export function checkUrl(entered: string, rules: UrlRules): Checked {
	// Only ordinary whitespace is trimmed; anything stranger is refused below.
	let value = entered.replace(/^[ \t\r\n]+|[ \t\r\n]+$/g, "");
	if (!value) return { problem: "Enter a URL." };
	if (HIDDEN_URL_CHARACTERS.test(value)) {
		return { problem: "This URL contains hidden characters. Try typing it instead." };
	}
	if (/\s/.test(value)) return { problem: "A URL cannot contain spaces." };

	// Before the scheme test, which would read `example.com:8080` as one.
	let host = HOST.exec(value);
	let web = LOCALHOST.test(value) || (host && !FILES.has(host[2]!.toLowerCase()));
	if (web && rules.protocols.includes("https:")) value = `https://${value}`;
	else if (!SCHEME.test(value) && EMAIL.test(value) && rules.protocols.includes("mailto:")) {
		value = `mailto:${value}`;
	}

	if (acceptable(value, rules)) return { url: value };
	let allowed = rules.protocols.map(protocol => protocol === "mailto:" ? protocol : `${protocol}//`)
		.join(" or ");
	return {
		problem: rules.relative === true
			? `Use an ${allowed} link, or a path in this repository.`
			: `Use an ${allowed} address.`,
	};
}

/**
 * Prompt, validate, and complain rather than silently dropping the input.
 *
 * Returns `undefined` when there is nothing to apply.
 */
export function askForUrl(label: string, rules: UrlRules): string | undefined {
	let entered = window.prompt(label);
	if (entered === null || !entered.trim()) return undefined;

	let checked = checkUrl(entered, rules);
	if (checked.problem !== undefined) {
		window.alert(checked.problem);
		return undefined;
	}
	return checked.url;
}
