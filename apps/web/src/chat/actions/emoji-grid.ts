/**
 * Where an arrow key goes in the picker's grid, which is one list of emoji in sections (Frequently
 * used, then each category), each section starting a new row as Slack's does. Up and down keep the
 * column across sections, landing on a shorter row's last emoji; left and right run on through the
 * whole list. `undefined` means the key left the grid upward, back to the search field.
 */
export function moveInGrid(
	sizes: readonly number[],
	index: number,
	key: string,
	columns: number,
): number | undefined {
	let total = sizes.reduce((sum, size) => sum + size, 0);
	if (total === 0) return undefined;
	if (key === "Home") return 0;
	if (key === "End") return total - 1;
	if (key === "ArrowRight") return Math.min(total - 1, index + 1);
	if (key === "ArrowLeft") return index === 0 ? undefined : index - 1;
	if (key !== "ArrowDown" && key !== "ArrowUp") return index;
	let start = 0;
	let section = 0;
	while (section < sizes.length - 1 && index >= start + sizes[section]!) {
		start += sizes[section]!;
		section++;
	}
	let offset = index - start;
	let column = offset % columns;
	let size = sizes[section]!;
	if (key === "ArrowDown") {
		let below = offset + columns;
		if (below < size) return start + below;
		// Into the next row of this section when it is shorter than the column, else the next section.
		if (Math.floor(below / columns) * columns < size) return start + size - 1;
		let next = section + 1;
		while (next < sizes.length && sizes[next] === 0) next++;
		if (next >= sizes.length) return index;
		let nextStart = sizes.slice(0, next).reduce((sum, value) => sum + value, 0);
		return nextStart + Math.min(column, sizes[next]! - 1);
	}
	if (offset >= columns) return start + offset - columns;
	let previous = section - 1;
	while (previous >= 0 && sizes[previous] === 0) previous--;
	if (previous < 0) return undefined;
	let previousSize = sizes[previous]!;
	let previousStart = sizes.slice(0, previous).reduce((sum, value) => sum + value, 0);
	let lastRow = Math.floor((previousSize - 1) / columns) * columns;
	return previousStart + Math.min(lastRow + column, previousSize - 1);
}
