import { LineIcon } from "./icon";

import type { IconProps } from "./icon";

export function ListIcon(props: IconProps) {
	return (
		<LineIcon {...props}>
			<path d="M6.75 4.75h8.5M6.75 9h8.5M6.75 13.25h8.5" />
			<circle cx="3.25" cy="4.75" r=".75" fill="currentColor" stroke="none" />
			<circle cx="3.25" cy="9" r=".75" fill="currentColor" stroke="none" />
			<circle cx="3.25" cy="13.25" r=".75" fill="currentColor" stroke="none" />
		</LineIcon>
	);
}
