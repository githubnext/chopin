/**
 * The icons assistant-ui's and shadcn's copies import from `lucide-react`, drawn in Chopin's own
 * icon language. `tsconfig.json` maps `lucide-react` here, as it maps `@assistant-ui/react` to
 * Chopin's seam, so a copied file keeps its bytes and its classes while Chat shows one family of
 * glyphs: the same 18-unit grid, stroke and round joins in the composer, the toolbar, the viewer and
 * the menus. A copy's classes still size each glyph; a stroke width it asks for is ignored, because
 * one stroke for the family is the point.
 */

import {
	ArrowUpIcon as ArrowUp,
	CheckIcon as Check,
	ChevronDownIcon as ChevronDown,
	ChevronIcon,
	ChevronLeftIcon as ChevronLeft,
	CloseIcon,
	CopyIcon as Copy,
	DownloadIcon as Download,
	EllipsisIcon as Ellipsis,
	ExternalLinkIcon as ExternalLink,
	FileImageIcon as FileImage,
	FileTextIcon as FileText,
	FileZipIcon,
	ImageIcon as Image,
	ImageOffIcon as ImageOff,
	MagnifierIcon,
	MicIcon as Mic,
	PaperclipIcon as Paperclip,
	PlusIcon as Plus,
	RestartIcon,
	ShieldAlertIcon as ShieldAlert,
	SpinnerIcon,
	StopIcon,
	ThumbsDownIcon as ThumbsDown,
	ThumbsUpIcon as ThumbsUp,
} from "@chopin/icons";

import type { IconProps, IconSize } from "@chopin/icons";
import type { ReactElement, SVGProps } from "react";

export type LucideProps = SVGProps<SVGSVGElement> & {
	absoluteStrokeWidth?: boolean;
	size?: number | string;
};
/** What a copy keeps an icon as; Chopin's own icons fit it too. */
export type LucideIcon = (props: IconProps) => ReactElement;

function lucide(Glyph: (props: IconProps) => ReactElement): (props: LucideProps) => ReactElement {
	return function Icon({ absoluteStrokeWidth: _, ref: __, size, strokeWidth: ___, ...props }) {
		return <Glyph {...props} size={typeof size === "number" ? size as IconSize : undefined} />;
	};
}

export const ArrowUpIcon = lucide(ArrowUp);
export const CheckIcon = lucide(Check);
export const ChevronDownIcon = lucide(ChevronDown);
export const ChevronLeftIcon = lucide(ChevronLeft);
export const ChevronRightIcon = lucide(ChevronIcon);
export const CopyIcon = lucide(Copy);
export const DownloadIcon = lucide(Download);
export const EllipsisIcon = lucide(Ellipsis);
export const ExternalLinkIcon = lucide(ExternalLink);
export const FileArchiveIcon = lucide(FileZipIcon);
export const FileImageIcon = lucide(FileImage);
export const FileTextIcon = lucide(FileText);
export const ImageIcon = lucide(Image);
export const ImageOffIcon = lucide(ImageOff);
export const Loader2Icon = lucide(SpinnerIcon);
export const MicIcon = lucide(Mic);
export const PaperclipIcon = lucide(Paperclip);
export const PlusIcon = lucide(Plus);
export const RefreshCwIcon = lucide(RestartIcon);
export const SearchIcon = lucide(MagnifierIcon);
export const ShieldAlertIcon = lucide(ShieldAlert);
export const SquareIcon = lucide(StopIcon);
export const ThumbsDownIcon = lucide(ThumbsDown);
export const ThumbsUpIcon = lucide(ThumbsUp);
export const XIcon = lucide(CloseIcon);
