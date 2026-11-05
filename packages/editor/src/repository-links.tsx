/**
 * Links that name a path in the document's repository.
 *
 * The document keeps the path it was written with, such as `docs/review.md`. A browser cannot
 * resolve it: Lexical hands every link's `href` to `sanitizeUrl`, which reads that path as the
 * host `docs` (and one with an `@` in it as an email address), and `./docs/review.md` would open
 * on the Chopin page it sits in. So where the host knows the repository, an anchor and every
 * place that follows a link open the file on GitHub instead, by the dialect's one rule.
 *
 * Like the GitHub pills this is decoration over Lexical's own `<a>`, replaced after Lexical sets
 * it and never stored, so editing, collaboration and the server's headless mirror see the link
 * they always did. The repository reaches the editors through a context, so any editor the host
 * wraps (the collaborative one, a read-only one, an earlier version) resolves the same way.
 */

import { createContext, useContext, useEffect } from "react";
import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import { $isLinkNode, AutoLinkNode, LinkNode } from "@lexical/link";
import { $getNodeByKey, isHTMLAnchorElement, mergeRegister } from "lexical";
import { repositoryLinkUrl } from "@chopin/dialect";

import type { LexicalEditor, NodeKey, NodeMutation } from "lexical";
import type { LinkRepository } from "@chopin/dialect";

export type { LinkRepository } from "@chopin/dialect";

const RepositoryLinksContext = createContext<LinkRepository | undefined>(undefined);

/** Tells the editors below which repository its documents' links are paths in. */
export const RepositoryLinksProvider = RepositoryLinksContext.Provider;

export function useRepositoryLinks(): LinkRepository | undefined {
	return useContext(RepositoryLinksContext);
}

/**
 * Where a link written as `href` goes, for text the editor does not draw itself, such as
 * Chat. Anything but a repository path is returned as written.
 */
export function useLinkHref(href: string | undefined): string | undefined {
	let repository = useRepositoryLinks();
	if (href === undefined || !repository) return href;
	return repositoryLinkUrl(href, repository) ?? href;
}

/** Point an anchor at the file its repository path opens; any other target keeps Lexical's. */
export function pointAnchor(
	anchor: { readonly href: string; setAttribute(name: "href", value: string): void },
	target: string,
	repository: LinkRepository,
): void {
	let href = repositoryLinkUrl(target, repository);
	if (href !== undefined && anchor.href !== href) anchor.setAttribute("href", href);
}

/** Keep every link in the editor pointing where its target means. */
export function registerRepositoryLinks(
	editor: LexicalEditor,
	repository: LinkRepository,
): () => void {
	// Reported per registered class, and a typed URL becomes an AutoLinkNode.
	let point = (mutations: Map<NodeKey, NodeMutation>) => {
		editor.getEditorState().read(() => {
			for (let [key, mutation] of mutations) {
				if (mutation === "destroyed") continue;
				let node = $getNodeByKey(key);
				let element = editor.getElementByKey(key);
				if ($isLinkNode(node) && isHTMLAnchorElement(element)) {
					pointAnchor(element, node.getURL(), repository);
				}
			}
		});
	};
	return mergeRegister(
		editor.registerMutationListener(LinkNode, point),
		editor.hasNode(AutoLinkNode) ? editor.registerMutationListener(AutoLinkNode, point) : () => {},
	);
}

export function RepositoryLinksPlugin() {
	let [editor] = useLexicalComposerContext();
	let repository = useRepositoryLinks();
	useEffect(() => repository && registerRepositoryLinks(editor, repository), [editor, repository]);
	return null;
}
