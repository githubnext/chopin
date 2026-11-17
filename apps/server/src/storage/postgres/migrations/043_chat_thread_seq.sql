-- The last sequence a thread gave out, so a restart, whatever its clock says, gives none of them again.
-- Additive: a server that does not know the column reads a thread's sequence from its entries.
ALTER TABLE chat_threads ADD COLUMN last_seq bigint;
