import { Face, PresenceFaces } from "@chopin/editor";

import { RoomMembers } from "../../room-workspace";
import { AuditPlate, StateLabel } from "../frame";

import type { Session } from "@chopin/protocol";
import type { ReactNode } from "react";

/** Not a valid GitHub login, so its photograph never loads and the initial stays. */
const UNREACHABLE = "design-audit--unreachable";

let MEMBERS: Session.Member[] = [
	{ client: "audit-1", handle: "maggieappleton" },
	{ client: "audit-2", handle: "olivia" },
	{ client: "audit-3", handle: "jev" },
	{ client: "audit-4", handle: "demo:Ada" },
	{ client: "audit-5", handle: "sam" },
];

function Sample({ children, label }: { children: ReactNode; label: string }) {
	return (
		<div className="design-audit-identity-sample">
			<StateLabel>{label}</StateLabel>
			<div className="design-audit-identity-row">{children}</div>
		</div>
	);
}

export function IdentityPlate() {
	return (
		<AuditPlate
			description="Faces with and without a photograph, presence on a decision, and the people in a room."
			item="identity"
			title="Identity and collaboration"
		>
			<div className="design-audit-identity-grid">
				<Sample label="Photograph">
					<Face handle="maggieappleton" size={24} />
				</Sample>
				<Sample label="Initial while loading or unavailable">
					<Face handle={UNREACHABLE} size={24} />
				</Sample>
				<Sample label="Demo actor">
					<Face handle="demo:Ada" size={24} />
				</Sample>
				<Sample label="Editing this question, with overflow">
					<PresenceFaces handles={["maggieappleton", "olivia", "jev", "sam", "demo:Ada"]} />
				</Sample>
				<Sample label="People here">
					<RoomMembers members={MEMBERS} ring="page" />
				</Sample>
			</div>
		</AuditPlate>
	);
}
