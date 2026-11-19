/** Follows a link to a page of Chopin's own, as the navigation does. */
export function navigateTo(href: string) {
	history.pushState(null, "", href);
	window.dispatchEvent(new PopStateEvent("popstate"));
}
