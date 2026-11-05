/**
 * Where a repository-relative link goes.
 *
 * The dialect lets a link name a path in the document's repository, but a
 * browser has nothing to resolve one against: `docs/review.md` is read as the
 * host `docs`, and `./docs/review.md` as a path on whatever page shows it. So
 * every place that draws or follows a link asks here first. The stored target
 * never changes; only where it opens does.
 */

import { climbsOutOfRepository, disguisedUrl, REPOSITORY_STAND_IN as STAND_IN } from "./dialect";

/** The repository a document's links resolve against, and the ref they open at. */
export type LinkRepository = {
	owner: string;
	name: string;
	/** A branch, tag or commit: the repository's default branch unless the document has its own. */
	ref: string;
};

/**
 * An address written without its `mailto:`, which the link editor completes
 * as it is typed. Anything with a `/` is a path, however many `@` it holds.
 */
export const BARE_EMAIL: RegExp = /^[^\s@/]+@[^\s@/]+\.[a-z]{2,}$/i;

/**
 * The file on GitHub that a repository-relative link target opens, or nothing
 * when the target is not a path in the repository and should be left as it is.
 *
 * That includes a target the dialect refuses (it names another host, or hides
 * its protocol) and a path that climbs out of the repository root: neither is
 * given an address on GitHub, whatever it would have resolved to. A path that
 * starts with `/` is Chopin's own (a link to another document), not the repository's.
 */
export function repositoryLinkUrl(target: string, repository: LinkRepository): string | undefined {
	// A path from the root of the site is one of Chopin's own: a link to another document, say.
	if (
		!target || /^[#?/]/.test(target) || /^[a-z][a-z0-9+.-]*:/i.test(target)
		|| BARE_EMAIL.test(target)
	) return;
	if (disguisedUrl(target) !== undefined || climbsOutOfRepository(target)) return;

	// Settled against a stand-in root, which the parser cannot leave except by climbing, and that is refused above.
	let settled = new URL(STAND_IN.href + target);

	let ref = repository.ref.split("/");
	let root = [repository.owner, repository.name, "blob", ...ref].map(encodeURIComponent).join("/");
	let rest = settled.pathname.slice(STAND_IN.pathname.length);
	return `https://github.com/${root}/${rest}${settled.search}${settled.hash}`;
}
