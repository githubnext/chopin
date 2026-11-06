import * as Api from "./api";
import { warmRecentSearch } from "./document-search-dialog";

// Warms the lazy dialog chunks and the Search palette's recent list after first paint.
export function prefetchDialogs(
	userId: string,
	projects: Api.NavigationProject[] | undefined,
	includeArchived: boolean,
	source: unknown,
) {
	return Promise.all([
		import("./add-project-dialog"),
		import("./new-document-dialog"),
		import("./delete-document-dialog"),
		projects && warmRecentSearch(userId, projects, includeArchived, source),
	]);
}
