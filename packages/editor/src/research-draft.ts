import type { Research } from "@chopin/protocol";
import type { RelativePosition } from "yjs";
import type { DOMRectLike } from "./toolbar/placement";

type ResearchDraftBase = {
	anchor: DOMRectLike;
	position?: RelativePosition;
	question: string;
	error?: string;
};

type Submission = { question: string; requestId: string };

export type ResearchDraft =
	& ResearchDraftBase
	& (
		| {
			phase: "editing";
			created?: never;
			submitted?: Submission;
			submitting?: false;
			cancelling?: false;
		}
		| {
			phase: "starting";
			created?: never;
			submitted: Submission;
			submitting: true;
			cancelling?: false;
		}
		| {
			phase: "placement";
			created: Research.RequestView;
			submitted: Submission;
			submitting?: false;
			cancelling?: false;
		}
		| {
			phase: "cancelling";
			created: Research.RequestView;
			submitted: Submission;
			submitting?: false;
			cancelling: true;
		}
	);

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

	canOpen(): boolean {
		return this.#draft === undefined;
	}

	open(anchor: DOMRectLike, position?: RelativePosition): boolean {
		if (!this.canOpen()) return false;
		this.#set({ phase: "editing", anchor, position, question: "" });
		return true;
	}

	change(question: string): void {
		let draft = this.#draft;
		if (draft?.phase !== "editing") return;
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
		if (draft?.phase !== "editing" || !draft.question.trim()) return;
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
		this.#set({ ...draft, phase: "starting", submitted, submitting: true, error: undefined });

		let request: Research.RequestView;
		try {
			request = await create(submitted.question, submitted.requestId);
		} catch {
			let current = this.#current(submitted.requestId);
			if (current) {
				this.#set({
					...current,
					phase: "editing",
					submitting: undefined,
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
			phase: "placement",
			created: request,
			submitting: undefined,
			error:
				"Research started, but its reference could not be placed. Choose a new insertion point in the document.",
		});
	}

	attachPlacement(place: Placement): () => void {
		this.#placement = place;
		let draft = this.#draft;
		if (
			draft?.phase === "placement"
			&& draft.position
			&& this.#insert(draft.position, draft.created.id)
		) {
			this.#set(undefined);
		}
		return () => {
			if (this.#placement === place) this.#placement = undefined;
		};
	}

	place(position: RelativePosition, writable = true): boolean {
		let draft = this.#draft;
		if (!writable || draft?.phase !== "placement") return false;
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
		if (draft.phase !== "editing") return false;
		this.#set(undefined);
		return true;
	}

	async cancelCreated(
		cancel: (id: string) => Promise<Research.RequestView>,
		writable = true,
	): Promise<boolean> {
		let draft = this.#draft;
		if (!writable || draft?.phase !== "placement") return false;
		let id = draft.created.id;
		this.#set({ ...draft, phase: "cancelling", cancelling: true, error: undefined });
		try {
			await cancel(id);
		} catch {
			let current = this.#draft;
			if (current?.phase === "cancelling" && current.created.id === id) {
				this.#set({
					...current,
					phase: "placement",
					cancelling: undefined,
					error: "Research could not be cancelled.",
				});
			}
			return false;
		}
		if (this.#draft?.phase !== "cancelling" || this.#draft.created.id !== id) return false;
		this.#set(undefined);
		return true;
	}

	#current(requestId: string): Extract<ResearchDraft, { phase: "starting" }> | undefined {
		let draft = this.#draft;
		return draft?.phase === "starting" && draft.submitted.requestId === requestId
			? draft as Extract<ResearchDraft, { phase: "starting" }>
			: undefined;
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
