export type ImageCorner = "top left" | "top right" | "bottom left" | "bottom right";

export function imageWidth(width: number, maximum: number): number {
	let max = Math.max(1, Math.min(4096, Math.floor(maximum)));
	return Math.round(Math.max(Math.min(64, max), Math.min(width, max)));
}

export function draggedImageWidth(
	width: number,
	ratio: number,
	dx: number,
	dy: number,
	corner: ImageCorner,
	maximum: number,
): number {
	let horizontal = dx * (corner.endsWith("right") ? 1 : -1);
	let vertical = dy * ratio * (corner.startsWith("bottom") ? 1 : -1);
	let change = Math.abs(horizontal) >= Math.abs(vertical) ? horizontal : vertical;
	return imageWidth(width + change, maximum);
}
