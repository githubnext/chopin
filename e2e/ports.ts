/**
 * The ports the browser suite binds, in one place.
 *
 * Every port is written as the number it has always had (8788 to 8805) and
 * passed through `e2ePort`. With `E2E_PORT_BASE` unset it is returned as
 * written. With `E2E_PORT_BASE=9950` the whole suite moves together, 8788 to
 * 9950 and 8805 to 9967, so a machine that shares its ports can give the suite
 * its own range.
 */
const FIRST = 8788;

export function e2ePort(port: number): number {
	let base = process.env.E2E_PORT_BASE;
	if (!base) return port;
	let moved = Number(base) + (port - FIRST);
	if (!Number.isInteger(moved) || moved < 1 || moved > 65535) {
		throw new Error(`chopin: E2E_PORT_BASE=${base} is not a usable port base`);
	}
	return moved;
}

/**
 * A database a spec creates and drops for itself, on the cluster of
 * `E2E_DATABASE_URL_3`. With `E2E_DATABASE_SUFFIX` set the name carries it, so a
 * cluster that other runs share never has their database of the same name
 * dropped.
 */
export function e2eDatabaseName(name: string): string {
	let suffix = process.env.E2E_DATABASE_SUFFIX;
	return suffix ? `${name}_${suffix}` : name;
}
