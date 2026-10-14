import { LineIcon } from "./icon";

import type { IconSize } from "./icon";

/** A portrait page with ruled lines: reading the document itself. */
export function PageIcon({ size }: { size?: IconSize }) {
	return (
		<LineIcon size={size}>
			<line x1="10.25" x2="12.25" y1="6.25" y2="6.25" />
			<line x1="5.75" x2="12.25" y1="9.25" y2="9.25" />
			<line x1="5.75" x2="12.25" y1="12.25" y2="12.25" />
			<rect height="14.5" rx="2" ry="2" width="12.5" x="2.75" y="1.75" />
			<rect fill="currentColor" height="1.5" width="1.5" x="5.75" y="4.75" />
		</LineIcon>
	);
}

export function GlobeSearchIcon({ size }: { size?: IconSize }) {
	return (
		<LineIcon size={size}>
			<path d="M9.2549 16.2457C9.1702 16.2486 9.0852 16.25 9 16.25C4.996 16.25 1.75 13.004 1.75 9C1.75 4.996 4.996 1.75 9 1.75C13.004 1.75 16.25 4.996 16.25 9C16.25 9.0853 16.2485 9.17029 16.2455 9.25479" />
			<path d="M16.25 9C16.25 7.343 13.004 6 9 6C4.996 6 1.75 7.343 1.75 9C1.75 10.657 4.996 12 9 12C9.0488 12 9.0974 11.9998 9.1459 11.9994" />
			<path d="M11.9994 9.1459C11.9998 9.0974 12 9.0488 12 9C12 4.996 10.657 1.75 9 1.75C7.343 1.75 6 4.996 6 9C6 13.004 7.343 16.25 9 16.25" />
			<path d="M14 16.25C15.2426 16.25 16.25 15.243 16.25 14C16.25 12.757 15.2426 11.75 14 11.75C12.7574 11.75 11.75 12.757 11.75 14C11.75 15.243 12.7574 16.25 14 16.25Z" />
			<path d="M15.59 15.59L17.25 17.25" />
		</LineIcon>
	);
}

export function TerminalIcon({ size }: { size?: IconSize }) {
	return (
		<LineIcon size={size}>
			<polyline points="2.75 14.25 8 9 2.75 3.75" />
			<line x1="9.5" x2="15.25" y1="14.25" y2="14.25" />
		</LineIcon>
	);
}

export function BrainSparkleIcon({ size }: { size?: IconSize }) {
	return (
		<LineIcon size={size}>
			<path d="m9,13.75c-.2471,1.15-1.007,2-2.25,2s-2.25-1.007-2.25-2.25c0-.093.016-.182.027-.272-.998-.113-1.777-.95-1.777-1.978,0-.734.4-1.369.989-1.717-.876-.388-1.489-1.263-1.489-2.283,0-1.305,1.002-2.364,2.277-2.478-.011-.09-.027-.179-.027-.272,0-1.243,1.007-2.25,2.25-2.25s2.0578,1.052,2.25,1.75c.1922-.7059,1.007-1.75,2.25-1.75s2.25,1.007,2.25,2.25c0,.093-.016.182-.027.272,1.275.114,2.277,1.173,2.277,2.478,0,1.02-.613,1.895-1.489,2.283.589.348.989.983.989,1.717,0,1.028-.779,1.865-1.777,1.978.011.09.027.179.027.272,0,1.243-1.007,2.25-2.25,2.25s-2.0206-.8559-2.25-2Z" />
			<path
				d="m11.589,8.4055l-1.515-.5096-.505-1.5258c-.164-.4935-.975-.4935-1.139,0l-.505,1.5258-1.515.5096c-.245.0816-.41.3132-.41.5731s.165.4915.41.5731l1.515.5096.505,1.5258c.082.2467.312.4129.57.4129s.487-.1662.57-.4129l.505-1.5258,1.515-.5096c.245-.0816.41-.3132.41-.5731s-.166-.4905-.411-.5731Z"
				fill="currentColor"
				strokeWidth="0"
			/>
		</LineIcon>
	);
}

export function CodePullRequestIcon({ size }: { size?: IconSize }) {
	return (
		<LineIcon size={size}>
			<path d="M14.25,12.25V5.75c0-1.105-.895-2-2-2h-3.5" />
			<polyline points="11 6 8.75 3.75 11 1.5" />
			<line x1="3.75" x2="3.75" y1="5.75" y2="12.25" />
			<circle cx="14.25" cy="14.25" r="2" />
			<circle cx="3.75" cy="14.25" r="2" />
			<circle cx="3.75" cy="3.75" r="2" />
		</LineIcon>
	);
}

/** A pen line drawn on a 16px grid to span the cap height beside 14px text; one path, so it can be stroked on with a dash. */
export function ScribbleIcon({ size }: { size?: IconSize }) {
	return (
		<LineIcon size={size} viewBox="0 0 16 16">
			<path
				d="M1.25 11.6c1.47-5.4 2.7-8.1 3.68-8.1 1.6 0 .25 9 1.96 9 1.6 0 2.45-9 4.17-9 1.23 0 .74 7.74 1.96 7.74.74 0 1.35-1.44 1.72-2.7"
				pathLength="1"
			/>
		</LineIcon>
	);
}
