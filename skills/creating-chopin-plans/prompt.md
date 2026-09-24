# Create a Chopin plan

The conversation below has settled enough context for one initial Chopin
document. Follow the installed `creating-chopin-plans` skill and the current
Chopin MCP initialize instructions and tool descriptions.

<SETTLED_CONVERSATION>

...

</SETTLED_CONVERSATION>

## Revise an existing document

Use this prompt instead of the creation prompt when the document already exists:

Revise `<CANONICAL_CHOPIN_DOCUMENT_URL>` to incorporate `<REQUESTED_CHANGES>`.
Follow the installed `creating-chopin-plans` skill and the current Chopin MCP
instructions. Read the latest source and revision before calling
`update_document`; preserve server-owned projections and do not create a second
document. Reconcile revision conflicts with a fresh read, and retry uncertain
responses only with identical arguments and the same idempotency key. Return
the canonical document URL and summarize the accepted changes.
