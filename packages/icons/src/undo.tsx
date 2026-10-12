import { LineIcon } from "./icon";

import type { IconProps } from "./icon";

/** Step back: an arrow turning back on itself to the left. */
export function UndoIcon(props: IconProps) {
	return (
		<LineIcon {...props}>
			<polyline points="5.75 3.25 2.25 6.75 5.75 10.25" />
			<path d="M2.25 6.75h8.5a4.5 4.5 0 0 1 0 9H8.25" />
		</LineIcon>
	);
}

/** Step forward again: the undo arrow mirrored. */
export function RedoIcon(props: IconProps) {
	return (
		<LineIcon {...props}>
			<polyline points="12.25 3.25 15.75 6.75 12.25 10.25" />
			<path d="M15.75 6.75h-8.5a4.5 4.5 0 0 0 0 9h2.5" />
		</LineIcon>
	);
}
