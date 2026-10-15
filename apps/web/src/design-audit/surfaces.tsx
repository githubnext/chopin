import { ConversationPlate } from "./plates/conversation";
import { DecisionsPlate } from "./plates/decisions";
import { DialogsPlate } from "./plates/dialogs";
import { EmptyStatesPlate } from "./plates/empty-states";
import { ErrorsPlate } from "./plates/errors";
import { IdentityPlate } from "./plates/identity";
import { ListsPlate } from "./plates/lists";
import { LoadingStatusPlate } from "./plates/loading-status";
import { NavigationPlate } from "./plates/navigation";
import { ResolvedCommentsPlate } from "./plates/resolved-comments";
import { WorkflowRunsPlate } from "./plates/workflow-runs";

/** Each plate owns a `plates/<name>.tsx` and `.css` pair; surfaces.css imports the styles. */
export function Surfaces() {
	return (
		<>
			<DialogsPlate />
			<ListsPlate />
			<NavigationPlate />
			<ConversationPlate />
			<WorkflowRunsPlate />
			<IdentityPlate />
			<DecisionsPlate />
			<ResolvedCommentsPlate />
			<LoadingStatusPlate />
			<EmptyStatesPlate />
			<ErrorsPlate />
		</>
	);
}
