/** Below this, a scaled-down diagram's labels stop being comfortably legible. */
export const MIN_DIAGRAM_SCALE = 0.75;

/** Whether a drawing `authored` wide can be shrunk into `room` and still be read. */
export function fitsLegibly(room: number, authored: number): boolean {
	return !(authored > 0) || room >= authored * MIN_DIAGRAM_SCALE;
}
