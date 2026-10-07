import { LineIcon } from "./icon";

import type { IconProps } from "./icon";

export function ArrowUpIcon(props: IconProps) {
	return (
		<LineIcon {...props}>
			<line x1="9" x2="9" y1="2.75" y2="15.25" />
			<polyline points="4.75 7 9 2.75 13.25 7" />
		</LineIcon>
	);
}

export function ChevronIcon(props: IconProps) {
	return (
		<LineIcon {...props}>
			<polyline points="6.5 2.75 12.75 9 6.5 15.25" />
		</LineIcon>
	);
}

export function CodeIcon(props: IconProps) {
	return (
		<LineIcon {...props}>
			<polyline points="5.75 4.75 1.75 9 5.75 13.25" />
			<polyline points="12.25 4.75 16.25 9 12.25 13.25" />
		</LineIcon>
	);
}

export function MessageIcon(props: IconProps) {
	return (
		<LineIcon {...props}>
			<path d="M9,1.75C4.996,1.75,1.75,4.996,1.75,9c0,1.319,.358,2.552,.973,3.617,.43,.806-.053,2.712-.973,3.633,1.25,.068,2.897-.497,3.633-.973,.489,.282,1.264,.656,2.279,.848,.433,.082,.881,.125,1.338,.125,4.004,0,7.25-3.246,7.25-7.25S13.004,1.75,9,1.75Z" />
		</LineIcon>
	);
}

export function CheckIcon(props: IconProps) {
	return (
		<LineIcon {...props}>
			<path d="M2.75,9c1.54,1.537,2.745,3.312,3.75,5.25,2.333-4.417,5.25-7.917,8.75-10.5" />
		</LineIcon>
	);
}

export function DecisionIcon(props: IconProps) {
	return (
		<LineIcon {...props}>
			<polyline points="12.75 2.75 15.25 5.25 12.75 7.75" />
			<path d="M2.75 12.75h2.1c1.1 0 2.12-.58 2.69-1.52l2.92-4.96c.57-.94 1.59-1.52 2.69-1.52h2.1" />
			<polyline points="12.75 10.25 15.25 12.75 12.75 15.25" />
			<path d="M2.75 5.25h2.1c1.1 0 2.12.58 2.69 1.52M10.46 11.23c.57.94 1.59 1.52 2.69 1.52h2.1" />
		</LineIcon>
	);
}

export function ClockIcon(props: IconProps) {
	return (
		<LineIcon {...props}>
			<circle cx="9" cy="9" r="7.25" />
			<polyline points="9 4.75 9 9 12.25 11.25" />
		</LineIcon>
	);
}

export function InfoIcon(props: IconProps) {
	return (
		<LineIcon {...props}>
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
		<LineIcon {...props}>
			<path d="M9 11.25V8.25L7 6.25" />
			<path d="M9 8.25L11 6.25" />
			<path d="M14 6.75C14 3.637 11.154 1.18801 7.92201 1.86301C5.99001 2.26601 4.44702 3.85599 4.08802 5.79599C3.65402 8.13999 4.85901 10.255 6.75001 11.211V14.25C6.75001 15.355 7.64501 16.25 8.75001 16.25H9.25001C10.355 16.25 11.25 15.355 11.25 14.25V11.211C12.88 10.387 14 8.701 14 6.75Z" />
			<path d="M6.75 11.25H11.25" />
		</LineIcon>
	);
}

export function CloseIcon(props: IconProps) {
	return (
		<LineIcon {...props}>
			<line x1="14" x2="4" y1="4" y2="14" />
			<line x1="4" x2="14" y1="4" y2="14" />
		</LineIcon>
	);
}

export function ImageIcon(props: IconProps) {
	return (
		<LineIcon {...props}>
			<rect height="12.5" rx="2" ry="2" width="12.5" x="2.75" y="2.75" />
			<circle cx="6.75" cy="6.75" r="1.25" />
			<path d="M15.25 11.25 11.957 7.957c-.391-.391-1.024-.391-1.414 0L3.25 15.25" />
		</LineIcon>
	);
}

export function PlusIcon(props: IconProps) {
	return (
		<LineIcon {...props}>
			<line x1="9" x2="9" y1="3.25" y2="14.75" />
			<line x1="3.25" x2="14.75" y1="9" y2="9" />
		</LineIcon>
	);
}

export function SignInIcon(props: IconProps) {
	return (
		<LineIcon {...props}>
			<path d="M9.75,2.75h3.5c1.105,0,2,.895,2,2V13.25c0,1.105-.895,2-2,2h-3.5" />
			<polyline points="6.75 12.5 10.25 9 6.75 5.5" />
			<line x1="10.25" x2="2.75" y1="9" y2="9" />
		</LineIcon>
	);
}

export function SirenIcon(props: IconProps) {
	return (
		<LineIcon {...props}>
			<path d="M9 0.75V2.25" />
			<path d="M14.834 3.166L13.773 4.227" />
			<path d="M17.25 9H15.75" />
			<path d="M3.16602 3.166L4.22701 4.227" />
			<path d="M0.75 9H2.25" />
			<path d="M14 13.25H4C3.5858 13.25 3.25 13.5858 3.25 14V15.5C3.25 15.9142 3.5858 16.25 4 16.25H14C14.4142 16.25 14.75 15.9142 14.75 15.5V14C14.75 13.5858 14.4142 13.25 14 13.25Z" />
			<path d="M4.75 13.25V9C4.75 6.653 6.653 4.75 9 4.75C11.347 4.75 13.25 6.653 13.25 9V13.25" />
			<path d="M9 7.75C8.3105 7.75 7.75 8.3105 7.75 9" />
		</LineIcon>
	);
}

export function SparkleIcon(props: IconProps) {
	return (
		<LineIcon {...props}>
			<polygon points="9 2.25 10.912 7.087 15.75 9 10.912 10.913 9 15.75 7.087 10.913 2.25 9 7.087 7.087 9 2.25" />
		</LineIcon>
	);
}

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

export function LinkPlusIcon(props: IconProps) {
	return (
		<LineIcon {...props}>
			<path d="M14.251 1.25V6.25" />
			<path d="M16.751 3.75H11.751" />
			<path d="M7.86909 7.3934C7.56649 7.5539 7.28239 7.7617 7.02799 8.017L7.01799 8.027C5.63699 9.408 5.63699 11.646 7.01799 13.027L9.19299 15.202C10.574 16.583 12.812 16.583 14.193 15.202L14.203 15.192C15.584 13.811 15.584 11.573 14.203 10.192L13.4406 9.4296" />
			<path d="M9.13289 11.6066C9.43549 11.4461 9.71959 11.2383 9.97399 10.983L9.984 10.973C11.365 9.59199 11.365 7.35399 9.984 5.97299L7.80899 3.79799C6.42799 2.41699 4.18999 2.41699 2.80899 3.79799L2.79899 3.80799C1.41799 5.18899 1.41799 7.42699 2.79899 8.80799L3.5614 9.57039" />
		</LineIcon>
	);
}

export function MessagePlusIcon(props: IconProps) {
	return (
		<LineIcon {...props}>
			<path d="M14.75 12.25V17.25" />
			<path d="M16.2155 9.64111C16.2364 9.42991 16.25 9.2168 16.25 9C16.25 4.9961 13.004 1.75 9 1.75C4.996 1.75 1.75 4.9961 1.75 9C1.75 10.3188 2.10801 11.552 2.72301 12.6169C3.15301 13.4228 2.67 15.3291 1.75 16.25C3 16.3179 4.647 15.7529 5.383 15.2769C5.872 15.5591 6.647 15.9331 7.662 16.125C8.095 16.207 8.543 16.25 9 16.25C9.2167 16.25 9.4299 16.2363 9.6412 16.2156" />
			<path d="M17.25 14.75H12.25" />
		</LineIcon>
	);
}

export function MessageForwardIcon(props: IconProps) {
	return (
		<LineIcon {...props}>
			<path d="M10.25,9.25H2.878c-.616,0-1.109,.556-.989,1.16,.158,.789,.444,1.532,.834,2.207,.43,.806-.053,2.712-.973,3.633,1.25,.068,2.897-.497,3.633-.973,.489,.282,1.264,.656,2.279,.848,.832,.157,1.714,.171,2.623,.013,2.902-.504,5.27-2.806,5.827-5.699,.891-4.636-2.637-8.689-7.111-8.689C5.781,1.75,3.053,3.847,2.106,6.75" />
			<polyline points="7.75 6.5 10.5 9.25 7.75 12" />
		</LineIcon>
	);
}

export function WrenchIcon(props: IconProps) {
	return (
		<LineIcon {...props}>
			<path d="M15.07,5.07l-2.32,2.32-2.12-.38-.38-2.12,2.32-2.32c-1.4-.6-3.08-.33-4.22,.81-1.21,1.21-1.43,3.04-.67,4.48l-5.17,5.17c-.59,.59-.59,1.54,0,2.12h0c.59,.59,1.54,.59,2.12,0l5.17-5.17c1.44,.76,3.27,.54,4.48-.67,1.14-1.14,1.41-2.82,.81-4.22Z" />
		</LineIcon>
	);
}

export function LockIcon(props: IconProps) {
	return (
		<LineIcon {...props}>
			<rect x="3.75" y="7.75" width="10.5" height="8.5" rx="1.5" />
			<path d="M5.75 7.75V5a3.25 3.25 0 0 1 6.5 0v2.75" />
			<path d="M9 11.25V12.75" />
		</LineIcon>
	);
}

export function CircleCloseIcon(props: IconProps) {
	return (
		<LineIcon {...props}>
			<circle cx="9" cy="9" r="7.25" />
			<path d="M6.5 6.5L11.5 11.5M11.5 6.5L6.5 11.5" />
		</LineIcon>
	);
}

export function TableIcon(props: IconProps) {
	return (
		<LineIcon {...props}>
			<rect height="12.5" rx="2" width="12.5" x="2.75" y="2.75" />
			<line x1="2.75" x2="15.25" y1="7" y2="7" />
			<line x1="7.5" x2="7.5" y1="7" y2="15.25" />
		</LineIcon>
	);
}

export function LinkIcon(props: IconProps) {
	return (
		<LineIcon {...props}>
			<path d="M7.87 7.39c-.3.16-.59.37-.84.63l-.01.01c-1.38 1.38-1.38 3.62 0 5l2.17 2.17c1.38 1.38 3.62 1.38 5 0l.01-.01c1.38-1.38 1.38-3.62 0-5" />
			<path d="M10.13 10.61c.3-.16.59-.37.84-.63l.01-.01c1.38-1.38 1.38-3.62 0-5L8.81 2.8c-1.38-1.38-3.62-1.38-5 0l-.01.01c-1.38 1.38-1.38 3.62 0 5" />
		</LineIcon>
	);
}

export function DiagramIcon(props: IconProps) {
	return (
		<LineIcon {...props}>
			<rect height="4.5" rx="1" width="5" x="6.5" y="2.25" />
			<rect height="4.5" rx="1" width="5" x="1.75" y="11.25" />
			<rect height="4.5" rx="1" width="5" x="11.25" y="11.25" />
			<path d="M9,6.75v2.25M4.25,11.25V9h9.5v2.25" />
		</LineIcon>
	);
}

export function FormulaIcon(props: IconProps) {
	return (
		<LineIcon {...props}>
			<polyline points="14.25 3.25 3.75 3.25 9 9 3.75 14.75 14.25 14.75" />
		</LineIcon>
	);
}

export function TabsIcon(props: IconProps) {
	return (
		<LineIcon {...props}>
			<rect height="9" rx="2" width="12.5" x="2.75" y="6.25" />
			<path d="M2.75,6.25V4.75c0-.55.45-1,1-1h3.5c.55,0,1,.45,1,1v1.5" />
			<line x1="11" x2="14" y1="4.25" y2="4.25" />
		</LineIcon>
	);
}

export function MagnifierIcon(props: IconProps) {
	return (
		<LineIcon {...props}>
			<circle cx="8" cy="8" r="5.25" />
			<line x1="11.75" x2="15.25" y1="11.75" y2="15.25" />
		</LineIcon>
	);
}

export function DiffIcon(props: IconProps) {
	return (
		<LineIcon {...props}>
			<rect height="12.5" rx="2" width="12.5" x="2.75" y="2.75" />
			<line x1="5.5" x2="8.5" y1="7" y2="7" />
			<line x1="7" x2="7" y1="5.5" y2="8.5" />
			<line x1="9.5" x2="12.5" y1="11" y2="11" />
		</LineIcon>
	);
}

export function PencilIcon(props: IconProps) {
	return (
		<LineIcon {...props}>
			<path d="M10.5 4.25 13.75 7.5" />
			<path d="M3.25 14.75 3.9 11.6c.05-.25.17-.47.35-.65l7.6-7.6c.59-.59 1.54-.59 2.12 0l.94.94c.59.59.59 1.54 0 2.12l-7.6 7.6c-.18.18-.4.3-.65.35l-3.15.65c-.2.04-.4-.16-.36-.36Z" />
		</LineIcon>
	);
}
