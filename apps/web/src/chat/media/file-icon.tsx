/**
 * A file's type as Slack draws it: a rounded square in the type's colour, with its glyph in white.
 * The colours are Chopin's roles (`media.css`), never Slack's own.
 */

import {
	FileArchiveIcon,
	FileCodeIcon,
	FileIcon,
	FileSpreadsheetIcon,
	FileTextIcon,
	FileTypeIcon as PdfIcon,
	PresentationIcon,
} from "lucide-react";

import type { LucideIcon } from "lucide-react";
import type { FileKind } from "./layout";

const GLYPHS: Record<FileKind, LucideIcon> = {
	pdf: PdfIcon,
	document: FileTextIcon,
	spreadsheet: FileSpreadsheetIcon,
	slides: PresentationIcon,
	code: FileCodeIcon,
	text: FileTextIcon,
	archive: FileArchiveIcon,
	generic: FileIcon,
};

export function FileKindIcon({ kind }: { kind: FileKind }) {
	let Glyph = GLYPHS[kind];
	return (
		<span aria-hidden="true" className="chat-file-icon" data-file-kind={kind}>
			<Glyph size={20} strokeWidth={1.75} />
		</span>
	);
}
