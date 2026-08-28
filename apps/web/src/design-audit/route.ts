export function isDesignAuditRoute(pathname: string, development: boolean): boolean {
	return development && pathname === "/design-audit";
}
