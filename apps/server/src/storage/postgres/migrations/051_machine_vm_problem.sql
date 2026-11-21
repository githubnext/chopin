-- Why a paired machine's connector said it can't run agents in microVMs, and the fix, until a
-- connection that runs them clears it: { "reason": text, "fix"?: text }.
ALTER TABLE machines ADD COLUMN vm_problem jsonb CHECK (
	vm_problem IS NULL
	OR jsonb_typeof(vm_problem) = 'object'
	AND jsonb_typeof(vm_problem -> 'reason') = 'string'
	AND char_length(vm_problem ->> 'reason') BETWEEN 1 AND 600
	AND (vm_problem -> 'fix' IS NULL OR char_length(vm_problem ->> 'fix') BETWEEN 1 AND 600)
);
