export function visibleOutlineColor(color: string): boolean {
	let value = color.trim().toLowerCase().replaceAll(/\s/g, "");
	if (!value || value === "transparent") return false;
	if (/\/0(?:\.0+)?%?\)$/.test(value)) return false;
	return !/^(?:rgba|hsla)\([^)]*,0(?:\.0+)?%?\)$/.test(value);
}
