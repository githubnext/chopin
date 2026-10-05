/**
 * Asking for a URL.
 *
 * Checking what comes back is not politeness. An address the dialect rejects
 * would apply locally, sync cleanly, then fail validation on the server —
 * which cannot undo a Yjs transaction and so rebuilds the room's epoch,
 * costing everyone present their undo history. The cheapest place to catch it
 * is before it becomes a node.
 */

export type UrlRules = {
	protocols: readonly string[];
	/**
	 * Whether a value with no protocol is acceptable.
	 *
	 * True for links, where a repository-relative path is meaningful. False for
	 * images, which have nothing to resolve against.
	 */
	relative: boolean;
};

export function acceptable(value: string, rules: UrlRules): boolean {
	if (!/^[a-z][a-z0-9+.-]*:/i.test(value)) return rules.relative;
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

/**
 * Accept what people actually type.
 *
 * A bare `example.com` would otherwise pass as a relative path and point into
 * the repository, so a recognisable host or address gains the protocol it was
 * plainly meant to have before the rules judge it.
 */
export function checkUrl(entered: string, rules: UrlRules): Checked {
	let value = entered.trim();
	if (!value) return { problem: "Enter a URL." };
	if (/\s/.test(value)) return { problem: "A URL cannot contain spaces." };

	if (!/^[a-z][a-z0-9+.-]*:/i.test(value)) {
		let host = HOST.exec(value);
		if (EMAIL.test(value) && rules.protocols.includes("mailto:")) value = `mailto:${value}`;
		else if (host && !FILES.has(host[2]!.toLowerCase()) && rules.protocols.includes("https:")) {
			value = `https://${value}`;
		}
	}

	if (acceptable(value, rules)) return { url: value };
	let allowed = rules.protocols.map(protocol => protocol === "mailto:" ? protocol : `${protocol}//`)
		.join(" or ");
	return {
		problem: rules.relative
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
