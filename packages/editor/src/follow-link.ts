/**
 * Following a link to a page of the host's own.
 *
 * The editor cannot tell a section of the document on show, or another document, from any other
 * address, and opening one in a new tab is what made a reader lose their place. So the host says
 * which links are its own and follows them where they are, as a browser follows a link on a page;
 * the editor opens a new tab only for a link the host did not take, or when asked to (a modified
 * or middle click). It is its own small module so the host can provide it without importing
 * the editor.
 */

import { createContext, useContext } from "react";

/** The host's own links: which they are, and how to follow one in place. */
export type FollowLink = {
	owns(href: string): boolean;
	follow(href: string): void;
};

const FollowLinkContext = createContext<FollowLink | undefined>(undefined);

export const FollowLinkProvider = FollowLinkContext.Provider;

export function useFollowLink(): FollowLink | undefined {
	return useContext(FollowLinkContext);
}
