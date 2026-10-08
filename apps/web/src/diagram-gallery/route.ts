export function isDiagramGalleryRoute(pathname: string, development: boolean): boolean {
	return development && pathname === "/diagram-gallery";
}
