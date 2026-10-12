import { LineIcon } from "./icon";

import type { IconProps } from "./icon";

/** A comment on a passage: a speech bubble holding text, distinct from Chat's empty bubble. */
export function CommentIcon(props: IconProps) {
	return (
		<LineIcon {...props}>
			<path d="M4.25 2.75h9.5a2 2 0 0 1 2 2v6a2 2 0 0 1-2 2H8.75l-3.5 2.5v-2.5h-1a2 2 0 0 1-2-2v-6a2 2 0 0 1 2-2Z" />
			<path d="M5.75 6.25h6.5M5.75 9.25h4" />
		</LineIcon>
	);
}
