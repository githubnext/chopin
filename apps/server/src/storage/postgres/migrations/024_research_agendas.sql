CREATE TABLE research_agendas (
    channel_id text PRIMARY KEY REFERENCES channels(id) ON DELETE CASCADE,
    revision bigint NOT NULL CHECK (revision > 0),
    state text NOT NULL CHECK (state IN ('active', 'paused', 'stopped', 'failed')),
    record jsonb NOT NULL CHECK (jsonb_typeof(record) = 'object')
);
CREATE INDEX research_agendas_active ON research_agendas(channel_id) WHERE state = 'active';

-- Retained across scope changes, so a late old request can never become ordinary research.
CREATE TABLE research_agenda_runs (
    id text PRIMARY KEY,
    channel_id text NOT NULL REFERENCES research_agendas(channel_id) ON DELETE CASCADE,
    record jsonb NOT NULL CHECK (jsonb_typeof(record) = 'object')
);
CREATE INDEX research_agenda_runs_channel ON research_agenda_runs(channel_id);
