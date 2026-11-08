/** One argument of a Windows command line, quoted the way a program's C runtime splits it back. */
export function windowsArgument(value: string) {
	if (value !== "" && !/[\s"]/.test(value)) return value;
	let quoted = '"';
	let backslashes = 0;
	for (let character of value) {
		if (character === "\\") {
			backslashes++;
			continue;
		}
		quoted += "\\".repeat(character === '"' ? backslashes * 2 + 1 : backslashes) + character;
		backslashes = 0;
	}
	return `${quoted}${"\\".repeat(backslashes * 2)}"`;
}
