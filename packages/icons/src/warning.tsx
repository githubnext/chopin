import { LineIcon } from "./icon";

import type { IconProps } from "./icon";

export function WarningIcon(props: IconProps) {
	return (
		<LineIcon {...props}>
			<path d="M7.63796 3.48996L2.21295 12.89C1.60795 13.9399 2.36395 15.25 3.57495 15.25H14.425C15.636 15.25 16.392 13.9399 15.787 12.89L10.362 3.48996C9.75696 2.44996 8.24296 2.44996 7.63796 3.48996Z" />
			<path d="M9 6.75V9.75" />
			<path
				d="M9 13.5C8.448 13.5 8 13.05 8 12.5C8 11.95 8.448 11.5 9 11.5C9.552 11.5 10 11.9501 10 12.5C10 13.0499 9.552 13.5 9 13.5Z"
				fill="currentColor"
				stroke="none"
			/>
		</LineIcon>
	);
}
