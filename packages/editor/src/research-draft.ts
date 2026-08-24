import type { Research } from "@chopin/protocol";
import type { RelativePosition } from "yjs";
import type { DOMRectLike } from "./toolbar/placement";

export type ResearchDraft = {
	anchor: DOMRectLike;
	position?: RelativePosition;
	question: string;
	created?: Research.RequestView;
	submitted?: { question: string; requestId: string };
	submitting?: boolean;
	cancelling?: boolean;
	error?: string;
};

type Placement = (position: RelativePosition, id: string) => boolean;

/**
 * Owns the non-document research composer across keyed Lexical editor lifetimes.
 * The current editor contributes only a replaceable placement function.
 */
export class ResearchDraftStore {
	#draft: ResearchDraft | undefined;
	#listeners = new Set<() => void>();
	#placement: Placement | undefined;

	subscribe(listener: () => void): () => void {
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	}

	get(): ResearchDraft | undefined {
		return this.#draft;
	}

	open(anchor: DOMRectLike, position?: RelativePosition): void {
		this.#set({ anchor, position, question: "" });
	}

	change(question: string): void {
		let draft = this.#draft;
		if (!draft || draft.submitting || draft.cancelling || draft.created) return;
		this.#set({
			...draft,
			question,
			error: undefined,
			submitted: draft.question === question ? draft.submitted : undefined,
		});
	}

	async start(
		create: (question: string, requestId: string) => Promise<Research.RequestView>,
		fallbackPosition?: RelativePosition,
	): Promise<void> {
		let draft = this.#draft;
		if (!draft || draft.submitting || draft.cancelling || draft.created || !draft.question.trim()) {
			return;
		}
		let position = draft.position ?? fallbackPosition;
		if (!position) {
			this.#set({
				...draft,
				error: "Choose an insertion point in the document before starting research.",
			});
			return;
		}
		draft = { ...draft, position };
		let submitted = draft.submitted?.question === draft.question
			? draft.submitted
			: { question: draft.question, requestId: crypto.randomUUID() };
		this.#set({ ...draft, submitted, submitting: true, error: undefined });

		let request: Research.RequestView;
		try {
			request = await create(submitted.question, submitted.requestId);
		} catch {
			let current = this.#current(submitted.requestId);
			if (current) {
				this.#set({
					...current,
					submitting: false,
					error: "Research could not be started.",
				});
			}
			return;
		}

		let current = this.#current(submitted.requestId);
		if (!current) return;
		if (current.position && this.#insert(current.position, request.id)) {
			this.#set(undefined);
			return;
		}
		this.#set({
			...current,
			created: request,
			submitting: false,
			error:
				"Research started, but its reference could not be placed. Choose a new insertion point in the document.",
		});
	}

	attachPlacement(place: Placement): () => void {
		this.#placement = place;
		let draft = this.#draft;
		if (
			draft?.created
			&& !draft.cancelling
			&& draft.position
			&& this.#insert(draft.position, draft.created.id)
		) {
			this.#set(undefined);
		}
		return () => {
			if (this.#placement === place) this.#placement = undefined;
		};
	}

	place(position: RelativePosition): boolean {
		let draft = this.#draft;
		if (!draft?.created || draft.cancelling) return false;
		if (this.#insert(position, draft.created.id)) {
			this.#set(undefined);
			return true;
		}
		this.#set({
			...draft,
			position,
			error: "Choose a new insertion point in the document, then place the research again.",
		});
		return false;
	}

	dismiss(): boolean {
		let draft = this.#draft;
		if (!draft) return true;
		if (draft.submitting || draft.cancelling || draft.created) return false;
		this.#set(undefined);
		return true;
	}

	async cancelCreated(
		cancel: (id: string) => Promise<Research.RequestView>,
	): Promise<boolean> {
		let draft = this.#draft;
		if (!draft?.created || draft.submitting || draft.cancelling) return false;
		let id = draft.created.id;
		this.#set({ ...draft, cancelling: true, error: undefined });
		try {
			await cancel(id);
		} catch {
			let current = this.#draft;
			if (current?.created?.id === id) {
				this.#set({
					...current,
					cancelling: false,
					error: "Research could not be cancelled.",
				});
			}
			return false;
		}
		if (this.#draft?.created?.id !== id) return false;
		this.#set(undefined);
		return true;
	}

	#current(requestId: string): ResearchDraft | undefined {
		let draft = this.#draft;
		return draft?.submitted?.requestId === requestId ? draft : undefined;
	}

	#insert(position: RelativePosition, id: string): boolean {
		try {
			return this.#placement?.(position, id) ?? false;
		} catch {
			return false;
		}
	}

	#set(draft: ResearchDraft | undefined): void {
		this.#draft = draft;
		for (let listener of this.#listeners) listener();
	}
}
