import { LineIcon } from "./icon";

import type { IconProps } from "./icon";

/** The marks of a message box's formatting toolbar and its send, as outlines on the 18px grid. */

export function BoldIcon(props: IconProps) {
	return (
		<LineIcon {...props}>
			<path d="M4.5 2.75h4.25a2.75 2.75 0 0 1 0 5.5H4.5zM4.5 8.25h5a2.9 2.9 0 0 1 0 5.8H4.5z" />
		</LineIcon>
	);
}

export function ItalicIcon(props: IconProps) {
	return (
		<LineIcon {...props}>
			<path d="M7.25 3h5.5M5.25 15h5.5M10.75 3 7.25 15" />
		</LineIcon>
	);
}

export function StrikethroughIcon(props: IconProps) {
	return (
		<LineIcon {...props}>
			<path d="M3 9h12M12.25 5.25C11.75 4 10.6 3.25 9 3.25c-1.8 0-3.1 1-3.1 2.45 0 1 .6 1.6 1.6 2M10.5 10.25c1.1.4 1.6 1.05 1.6 2 0 1.45-1.4 2.5-3.2 2.5-1.6 0-2.8-.8-3.25-2.25" />
		</LineIcon>
	);
}

export function NumberedListIcon(props: IconProps) {
	return (
		<LineIcon {...props}>
			<path d="M8 4.5h7.25M8 9h7.25M8 13.5h7.25M2.75 3.5l1-.75v3.5M2.75 8.5a1 1 0 0 1 2 .15c0 .75-1 1.3-2 2.1h2.25M2.75 12.5h2l-1.1 1.2a1 1 0 1 1-.9 1.75" />
		</LineIcon>
	);
}

export function BulletedListIcon(props: IconProps) {
	return (
		<LineIcon {...props}>
			<path
				d="M7 4.5h8.25M7 9h8.25M7 13.5h8.25M2.75 4.5h.01M2.75 9h.01M2.75 13.5h.01"
				strokeWidth="2.25"
			/>
			<path d="M7 4.5h8.25M7 9h8.25M7 13.5h8.25" />
		</LineIcon>
	);
}

export function CodeBlockIcon(props: IconProps) {
	return (
		<LineIcon {...props}>
			<rect height="13.5" rx="2.25" width="13.5" x="2.25" y="2.25" />
			<path d="M5.75 7.25 7.5 9l-1.75 1.75M9.25 11.25h3" />
		</LineIcon>
	);
}

export function AtSignIcon(props: IconProps) {
	return (
		<LineIcon {...props}>
			<circle cx="9" cy="9" r="2.75" />
			<path d="M11.75 6.25v3.9a1.9 1.9 0 0 0 3.75-.4V9A6.5 6.5 0 1 0 12.9 14.2" />
		</LineIcon>
	);
}

/** A paper plane: Send. */
export function SendIcon(props: IconProps) {
	return (
		<LineIcon {...props}>
			<path d="M16 2 8.25 9.75M16 2l-5 14-2.75-6.25L2 7z" />
		</LineIcon>
	);
}

/** A filled square: Stop. */
export function StopIcon(props: IconProps) {
	return (
		<LineIcon {...props}>
			<rect fill="currentColor" height="9" rx="1.75" width="9" x="4.5" y="4.5" />
		</LineIcon>
	);
}
