export type ParsedDocumentPath = {
	owner: string;
	repository: string;
	slug?: string;
};

const DOCUMENT_PATH = /^\/documents\/([^/]+)\/([^/]+)(?:\/([^/]+))?\/?$/;

function encodedSegment(value: string): string {
	if (!value) throw new TypeError("document path segments must not be empty");
	return encodeURIComponent(value);
}

export function documentsPath(owner: string, repository: string): string {
	return `/documents/${encodedSegment(owner)}/${encodedSegment(repository)}`;
}

export function documentPath(owner: string, repository: string, slug: string): string {
	return `${documentsPath(owner, repository)}/${encodedSegment(slug)}`;
}

export function parseDocumentPath(pathname: string): ParsedDocumentPath | undefined {
	let match = DOCUMENT_PATH.exec(pathname);
	if (!match) return undefined;
	try {
		let owner = decodeURIComponent(match[1]!);
		let repository = decodeURIComponent(match[2]!);
		if (!owner || !repository) return undefined;
		if (match[3] === undefined) return { owner, repository };
		let slug = decodeURIComponent(match[3]);
		return slug ? { owner, repository, slug } : undefined;
	} catch {
		return undefined;
	}
}
