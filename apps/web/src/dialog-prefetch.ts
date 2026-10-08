import * as Api from "./api";
import { warmRecentSearch } from "./document-search-dialog";

// Warms the lazy dialog chunks and the Search palette's recent list after first paint.
export function prefetchDialogs(
	userId: string,
	projects: Api.NavigationProject[] | undefined,
	includeArchived: boolean,
	source: unknown,
) {
	void import("./add-project-dialog");
	void import("./new-document-dialog");
	void import("./delete-document-dialog");
	if (projects) return warmRecentSearch(userId, projects, includeArchived, source);
}
