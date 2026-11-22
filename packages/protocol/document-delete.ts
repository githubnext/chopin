/**
 * Who may delete a document for good: a repository admin, or the person who created it while they
 * can still write to its repository. Other writers may archive it. A child document goes with its
 * parent and is never deleted on its own. The browser offers Delete by this rule; the server checks
 * it again with the repository role GitHub gives it at the request.
 */
export function mayDeleteDocument(
	document: { createdBy: string; parentChannelId?: string | undefined },
	permissions: { push: boolean; admin: boolean },
	userId: string,
): boolean {
	if (document.parentChannelId) return false;
	return permissions.admin || (permissions.push && document.createdBy === userId);
}
