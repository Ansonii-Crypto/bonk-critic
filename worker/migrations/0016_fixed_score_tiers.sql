-- Fixed ability thresholds: E43, D86, C129, B193, A216, S256 (out of 300).
-- Total thresholds are the score thresholds multiplied by six, independent of player counts.
-- Reclassify derived tiers only. Preserve scores, locks, dates, authors, revisions and logs.
UPDATE players SET overall_tier = CASE
    WHEN control + execution + defending + reaction_time + chemistry + game_sense >= 1536 THEN 'S'
    WHEN control + execution + defending + reaction_time + chemistry + game_sense >= 1296 THEN 'A'
    WHEN control + execution + defending + reaction_time + chemistry + game_sense >= 1158 THEN 'B'
    WHEN control + execution + defending + reaction_time + chemistry + game_sense >= 774 THEN 'C'
    WHEN control + execution + defending + reaction_time + chemistry + game_sense >= 516 THEN 'D'
    WHEN control + execution + defending + reaction_time + chemistry + game_sense >= 258 THEN 'E'
    ELSE 'F' END;

UPDATE assessments SET overall_tier = CASE
    WHEN control + execution + defending + reaction_time + chemistry + game_sense >= 1536 THEN 'S'
    WHEN control + execution + defending + reaction_time + chemistry + game_sense >= 1296 THEN 'A'
    WHEN control + execution + defending + reaction_time + chemistry + game_sense >= 1158 THEN 'B'
    WHEN control + execution + defending + reaction_time + chemistry + game_sense >= 774 THEN 'C'
    WHEN control + execution + defending + reaction_time + chemistry + game_sense >= 516 THEN 'D'
    WHEN control + execution + defending + reaction_time + chemistry + game_sense >= 258 THEN 'E'
    ELSE 'F' END;

WITH draft_totals AS (
    SELECT id,
        MIN(300, MAX(0, COALESCE(CAST(json_extract(data, '$.control') AS REAL), 0))) +
        MIN(300, MAX(0, COALESCE(CAST(json_extract(data, '$.execution') AS REAL), 0))) +
        MIN(300, MAX(0, COALESCE(CAST(json_extract(data, '$.defending') AS REAL), 0))) +
        MIN(300, MAX(0, COALESCE(CAST(json_extract(data, '$.reaction_time') AS REAL), 0))) +
        MIN(300, MAX(0, COALESCE(CAST(json_extract(data, '$.chemistry') AS REAL), 0))) +
        MIN(300, MAX(0, COALESCE(CAST(json_extract(data, '$.game_sense') AS REAL), 0))) AS total
    FROM player_drafts WHERE json_valid(data)
)
UPDATE player_drafts SET data = json_set(data, '$.overall_tier', (
    SELECT CASE WHEN total >= 1536 THEN 'S' WHEN total >= 1296 THEN 'A'
        WHEN total >= 1158 THEN 'B' WHEN total >= 774 THEN 'C'
        WHEN total >= 516 THEN 'D' WHEN total >= 258 THEN 'E' ELSE 'F' END
    FROM draft_totals WHERE draft_totals.id = player_drafts.id
)) WHERE id IN (SELECT id FROM draft_totals);
