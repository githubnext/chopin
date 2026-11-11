import { LineIcon } from "./icon";

import type { IconProps } from "./icon";

/** Two overlapping sheets. */
export function CopyIcon(props: IconProps) {
	return (
		<LineIcon {...props}>
			<rect x="5.75" y="5.75" width="10.5" height="10.5" rx="2" />
			<path d="M12.25 5.75V3.75C12.25 2.645 11.355 1.75 10.25 1.75H3.75C2.645 1.75 1.75 2.645 1.75 3.75V10.25C1.75 11.355 2.645 12.25 3.75 12.25H5.75" />
		</LineIcon>
	);
}
