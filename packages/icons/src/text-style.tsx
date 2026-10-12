import { LineIcon } from "./icon";

import type { IconProps } from "./icon";

/** "Aa": the shape of a block of text, such as a heading, a quote or a list. */
export function TextStyleIcon(props: IconProps) {
	return (
		<LineIcon {...props}>
			<path d="M1.75 14.25 5.5 3.75l3.75 10.5M3.1 10.5h4.8" />
			<circle cx="13" cy="11.5" r="2.75" />
			<path d="M15.75 8.75v5.5" />
		</LineIcon>
	);
}
