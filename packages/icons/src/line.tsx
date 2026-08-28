import { LineIcon } from "./icon";

import type { IconProps } from "./icon";

export function ArrowUpIcon(props: IconProps) {
	return (
		<LineIcon title="arrow-up" {...props}>
			<line x1="9" x2="9" y1="2.75" y2="15.25" />
			<polyline points="4.75 7 9 2.75 13.25 7" />
		</LineIcon>
	);
}

export function ChevronIcon(props: IconProps) {
	return (
		<LineIcon title="chevron-right" {...props}>
			<polyline points="6.5 2.75 12.75 9 6.5 15.25" />
		</LineIcon>
	);
}

export function MessageIcon(props: IconProps) {
	return (
		<LineIcon title="msg" {...props}>
			<path d="M9,1.75C4.996,1.75,1.75,4.996,1.75,9c0,1.319,.358,2.552,.973,3.617,.43,.806-.053,2.712-.973,3.633,1.25,.068,2.897-.497,3.633-.973,.489,.282,1.264,.656,2.279,.848,.433,.082,.881,.125,1.338,.125,4.004,0,7.25-3.246,7.25-7.25S13.004,1.75,9,1.75Z" />
		</LineIcon>
	);
}

export function CheckIcon(props: IconProps) {
	return (
		<LineIcon title="check-3" {...props}>
			<path d="M2.75,9c1.54,1.537,2.745,3.312,3.75,5.25,2.333-4.417,5.25-7.917,8.75-10.5" />
		</LineIcon>
	);
}

export function InfoIcon(props: IconProps) {
	return (
		<LineIcon title="circle-info" {...props}>
			<path d="M9 16.25C13.004 16.25 16.25 13.004 16.25 9C16.25 4.996 13.004 1.75 9 1.75C4.996 1.75 1.75 4.996 1.75 9C1.75 13.004 4.996 16.25 9 16.25Z" />
			<path d="M9 12.75V9.25C9 8.9739 8.7761 8.75 8.5 8.75H7.75" />
			<path
				d="M9 6.75C8.448 6.75 8 6.301 8 5.75C8 5.199 8.448 4.75 9 4.75C9.552 4.75 10 5.199 10 5.75C10 6.301 9.552 6.75 9 6.75Z"
				fill="currentColor"
				stroke="none"
			/>
		</LineIcon>
	);
}

export function LightbulbIcon(props: IconProps) {
	return (
		<LineIcon title="lightbulb-2" {...props}>
			<path d="M9 11.25V8.25L7 6.25" />
			<path d="M9 8.25L11 6.25" />
			<path d="M14 6.75C14 3.637 11.154 1.18801 7.92201 1.86301C5.99001 2.26601 4.44702 3.85599 4.08802 5.79599C3.65402 8.13999 4.85901 10.255 6.75001 11.211V14.25C6.75001 15.355 7.64501 16.25 8.75001 16.25H9.25001C10.355 16.25 11.25 15.355 11.25 14.25V11.211C12.88 10.387 14 8.701 14 6.75Z" />
			<path d="M6.75 11.25H11.25" />
		</LineIcon>
	);
}

export function CloseIcon(props: IconProps) {
	return (
		<LineIcon title="xmark" {...props}>
			<line x1="14" x2="4" y1="4" y2="14" />
			<line x1="4" x2="14" y1="4" y2="14" />
		</LineIcon>
	);
}

export function PlusIcon(props: IconProps) {
	return (
		<LineIcon title="plus" viewBox="0 0 13 13" {...props}>
			<path d="M6.5 0.75V12.25" />
			<path d="M0.75 6.5H12.25" />
		</LineIcon>
	);
}
