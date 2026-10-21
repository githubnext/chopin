/**
 * How long a workflow run took, for its end notice: seconds under a minute, then minutes.
 * Run cards carry whole seconds, so a run that ended in the second it started reads as less
 * than a second rather than being rounded up to a minute.
 */
export function runDuration(seconds: number): string {
	let tenths = Math.round(Math.max(0, seconds) * 10) / 10;
	if (tenths === 0) return "less than a second";
	if (tenths < 1) return `${tenths} s`;
	let whole = Math.round(tenths);
	if (whole < 60) return `${whole} s`;
	return `${Math.round(tenths / 60)} min`;
}
