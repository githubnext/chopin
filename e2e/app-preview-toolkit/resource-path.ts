import * as path from "node:path";

export function resourcePath(output: string, pathname: string, paths = path) {
	let decoded: string;
	try {
		decoded = decodeURIComponent(pathname === "/" ? "/index.html" : pathname);
	} catch {
		return undefined;
	}
	if (
		!decoded.startsWith("/") || decoded.includes("\\") || decoded.includes("\0")
		|| decoded.split("/").includes("..")
	) return undefined;
	let resolved = paths.resolve(output, decoded.slice(1));
	let relative = paths.relative(output, resolved);
	if (
		relative === ".." || relative.startsWith(`..${paths.sep}`) || paths.isAbsolute(relative)
	) return undefined;
	return resolved;
}
