-- Preserve reservations made by earlier research-agenda previews, including partial units.
UPDATE research_agendas
SET record = (record - 'reservedAiCredits') || jsonb_build_object(
    'reservedSessions', ceil((record->>'reservedAiCredits')::numeric / 30)
)
WHERE record ? 'reservedAiCredits' AND NOT record ? 'reservedSessions';
