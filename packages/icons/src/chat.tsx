/*
 * Chat's glyphs, on the same 18-unit grid, 1.5 stroke and round joins as every other line icon, so a
 * toolbar, a picker's tabs and a file's square read as one family with the composer.
 */

import { LineIcon } from "./icon";

import type { IconProps } from "./icon";

export function ChevronDownIcon(props: IconProps) {
	return (
		<LineIcon {...props}>
			<polyline points="2.75 6.5 9 12.75 15.25 6.5" />
		</LineIcon>
	);
}

export function ChevronLeftIcon(props: IconProps) {
	return (
		<LineIcon {...props}>
			<polyline points="11.5 2.75 5.25 9 11.5 15.25" />
		</LineIcon>
	);
}

/** A globe: Chat's own command, which is not the agent's. */
export function GlobeIcon(props: IconProps) {
	return (
		<LineIcon {...props}>
			<circle cx="9" cy="9" r="7.25" />
			<path d="M9 1.75C7 3.75 6 6.25 6 9s1 5.25 3 7.25c2-2 3-4.5 3-7.25s-1-5.25-3-7.25ZM1.75 9h14.5" />
		</LineIcon>
	);
}

/** A robot's head: an agent handing work to another. */
export function BotIcon(props: IconProps) {
	return (
		<LineIcon {...props}>
			<rect height="9" rx="2.5" width="12.5" x="2.75" y="6.25" />
			<path d="M9 6.25v-3M.75 10.75h2M15.25 10.75h2" />
			<circle cx="9" cy="2.5" fill="currentColor" r=".75" stroke="none" />
			<circle cx="6.5" cy="10.5" fill="currentColor" r="1" stroke="none" />
			<circle cx="11.5" cy="10.5" fill="currentColor" r="1" stroke="none" />
		</LineIcon>
	);
}

/** An open arc that turns while something loads. */
export function SpinnerIcon(props: IconProps) {
	return (
		<LineIcon {...props}>
			<path d="M16.25 9A7.25 7.25 0 1 1 9 1.75" />
		</LineIcon>
	);
}

export function ThumbsUpIcon(props: IconProps) {
	return (
		<LineIcon {...props}>
			<rect height="7.5" rx="1" width="3.5" x="1.75" y="7.75" />
			<path d="M5.25 8.25 8.1 2.9c.25-.45.8-.65 1.3-.45 1 .4 1.55 1.45 1.3 2.5l-.55 2.3h4.1c1.05 0 1.85.95 1.65 2l-.95 4.9c-.15.9-.95 1.6-1.9 1.6H5.25" />
		</LineIcon>
	);
}

export function ThumbsDownIcon(props: IconProps) {
	return (
		<LineIcon {...props}>
			<g transform="matrix(1 0 0 -1 0 18)">
				<rect height="7.5" rx="1" width="3.5" x="1.75" y="7.75" />
				<path d="M5.25 8.25 8.1 2.9c.25-.45.8-.65 1.3-.45 1 .4 1.55 1.45 1.3 2.5l-.55 2.3h4.1c1.05 0 1.85.95 1.65 2l-.95 4.9c-.15.9-.95 1.6-1.9 1.6H5.25" />
			</g>
		</LineIcon>
	);
}

/** A shield with a mark: an image Chat will not load. */
export function ShieldAlertIcon(props: IconProps) {
	return (
		<LineIcon {...props}>
			<path d="M9 1.75 3.25 4v4.6c0 3.6 2.4 6.4 5.75 7.65 3.35-1.25 5.75-4.05 5.75-7.65V4L9 1.75Z" />
			<path d="M9 5.75v3.5" />
			<circle cx="9" cy="11.9" fill="currentColor" r=".85" stroke="none" />
		</LineIcon>
	);
}

/** A face: the emoji picker's Smileys tab. */
export function SmileyIcon(props: IconProps) {
	return (
		<LineIcon {...props}>
			<circle cx="9" cy="9" r="7.25" />
			<circle cx="6.5" cy="7.25" fill="currentColor" r=".9" stroke="none" />
			<circle cx="11.5" cy="7.25" fill="currentColor" r=".9" stroke="none" />
			<path d="M5.9 10.75c.65 1.4 1.75 2.25 3.1 2.25s2.45-.85 3.1-2.25" />
		</LineIcon>
	);
}

/** A leaf: Animals and nature. */
export function LeafIcon(props: IconProps) {
	return (
		<LineIcon {...props}>
			<path d="M3.25 14.75C3.25 7.5 7.5 3.25 14.75 3.25c0 7.25-4.25 11.5-11.5 11.5Z" />
			<path d="M3.25 14.75 9.75 8.25" />
		</LineIcon>
	);
}

/** A cup: Food and drink. */
export function CupIcon(props: IconProps) {
	return (
		<LineIcon {...props}>
			<path d="M2.75 7.25h9.5v3.5a4.5 4.5 0 0 1-4.5 4.5h-.5a4.5 4.5 0 0 1-4.5-4.5v-3.5Z" />
			<path d="M12.25 8.25h.75a2 2 0 0 1 0 4h-1" />
			<path d="M6 2.75v2M9 2.75v2" />
		</LineIcon>
	);
}

/** A car: Travel and places. */
export function CarIcon(props: IconProps) {
	return (
		<LineIcon {...props}>
			<path d="M3.5 13.25H2.75V9.6c0-.45.15-.85.45-1.2l1.45-3.5c.3-.75 1.05-1.15 1.85-1.15h4.95c.8 0 1.55.4 1.85 1.15l1.45 3.5c.3.35.45.75.45 1.2v3.65h-.75" />
			<path d="M7 13.25h4M3 8.5h12" />
			<circle cx="5.25" cy="13.25" r="1.75" />
			<circle cx="12.75" cy="13.25" r="1.75" />
		</LineIcon>
	);
}

/** A ball: Activities. */
export function BallIcon(props: IconProps) {
	return (
		<LineIcon {...props}>
			<circle cx="9" cy="9" r="7.25" />
			<path d="M9 1.75v14.5M1.75 9h14.5" />
			<path d="M4.1 3.65c1.95 2.95 1.95 7.75 0 10.7M13.9 3.65c-1.95 2.95-1.95 7.75 0 10.7" />
		</LineIcon>
	);
}

/** A heart: Symbols. */
export function HeartIcon(props: IconProps) {
	return (
		<LineIcon {...props}>
			<path d="M9 15.25S2.25 11.4 2.25 6.6c0-2.1 1.6-3.85 3.6-3.85 1.4 0 2.5.8 3.15 1.95.65-1.15 1.75-1.95 3.15-1.95 2 0 3.6 1.75 3.6 3.85 0 4.8-6.75 8.65-6.75 8.65Z" />
		</LineIcon>
	);
}

/** A flag: Flags. */
export function FlagIcon(props: IconProps) {
	return (
		<LineIcon {...props}>
			<path d="M3.75 16.25V2.25" />
			<path d="M3.75 2.75h9.4c.5 0 .8.5.6.95L12.25 6.5l1.5 2.8c.25.45-.1.95-.6.95h-9.4" />
		</LineIcon>
	);
}

const PAGE = "M10.25 1.75h-5c-1.1 0-2 .9-2 2v10.5c0 1.1.9 2 2 2h7.5c1.1 0 2-.9 2-2v-8.5l-4.5-4Z";
const FOLD = "M10.25 1.75v3c0 .55.45 1 1 1h3.5";

function Page({ children, ...props }: IconProps & { children?: React.ReactNode }) {
	return (
		<LineIcon {...props}>
			<path d={PAGE} />
			<path d={FOLD} />
			{children}
		</LineIcon>
	);
}

/** A page: a file of no kind Chat knows. */
export function FileIcon(props: IconProps) {
	return <Page {...props} />;
}

export function FileTextIcon(props: IconProps) {
	return (
		<Page {...props}>
			<path d="M6.25 9.25h5.5M6.25 11.5h5.5M6.25 13.75h3" />
		</Page>
	);
}

export function FileCodeIcon(props: IconProps) {
	return (
		<Page {...props}>
			<path d="M7.25 9.5 5.75 11.25l1.5 1.75M10.75 9.5l1.5 1.75-1.5 1.75" />
		</Page>
	);
}

export function FileSheetIcon(props: IconProps) {
	return (
		<Page {...props}>
			<rect height="5" rx=".75" width="6.5" x="5.75" y="8.75" />
			<path d="M5.75 11.25h6.5M9 8.75v5" />
		</Page>
	);
}

export function FileZipIcon(props: IconProps) {
	return (
		<Page {...props}>
			<path d="M7.25 4h1M8.25 6h1M7.25 8h1" />
			<rect height="2.75" rx=".75" width="2.5" x="6.75" y="10.25" />
		</Page>
	);
}

/** A page with Acrobat's loop: a PDF. */
export function FilePdfIcon(props: IconProps) {
	return (
		<Page {...props}>
			<path d="M5.75 13.75c1.5-1.9 2.6-4.1 2.9-5.6.15-.75-.75-.95-.95-.25-.45 1.6.95 3.75 3.85 4.6.75.2 1.05-.8.25-1-2.25-.55-4.75.4-6.05 2.25Z" />
		</Page>
	);
}

export function FileImageIcon(props: IconProps) {
	return (
		<Page {...props}>
			<circle cx="7.25" cy="9.25" r="1" />
			<path d="M12.25 12.5 10.5 10.75c-.3-.3-.75-.3-1.05 0l-3.7 3.5" />
		</Page>
	);
}

export function FileVideoIcon(props: IconProps) {
	return (
		<Page {...props}>
			<path d="M7.5 9.15v3.7c0 .3.35.5.6.35l2.95-1.85c.25-.15.25-.55 0-.7L8.1 8.8c-.25-.15-.6.05-.6.35Z" />
		</Page>
	);
}

export function FileAudioIcon(props: IconProps) {
	return (
		<Page {...props}>
			<path d="M8.25 13.25v-4.5l3.25-.75v4" />
			<circle cx="7.25" cy="13.25" r="1" />
			<circle cx="10.5" cy="12" r="1" />
		</Page>
	);
}

/** A board on a stand: slides. */
export function SlidesIcon(props: IconProps) {
	return (
		<LineIcon {...props}>
			<path d="M1.75 3.25h14.5" />
			<path d="M2.75 3.25v6.5c0 1.1.9 2 2 2h8.5c1.1 0 2-.9 2-2v-6.5" />
			<path d="M9 11.75v2.5M6.25 16.25 9 14.25l2.75 2" />
		</LineIcon>
	);
}
