-- Freeze the 5th/20th/40th/60th/80th/95th percentile boundaries from the
-- 20 current published player totals on 2026-11-25. See ../../ratings.js.
-- Reclassify derived tiers only. Scores, locks, dates, authors and logs stay intact.
UPDATE players SET overall_tier = CASE
    WHEN control + execution + defending + reaction_time + chemistry + game_sense >= 1591 THEN 'S'
    WHEN control + execution + defending + reaction_time + chemistry + game_sense >= 1509 THEN 'A'
    WHEN control + execution + defending + reaction_time + chemistry + game_sense >= 1427 THEN 'B'
    WHEN control + execution + defending + reaction_time + chemistry + game_sense >= 1279 THEN 'C'
    WHEN control + execution + defending + reaction_time + chemistry + game_sense >= 1199 THEN 'D'
    WHEN control + execution + defending + reaction_time + chemistry + game_sense >= 1030 THEN 'E'
    ELSE 'F' END;

UPDATE assessments SET overall_tier = CASE
    WHEN control + execution + defending + reaction_time + chemistry + game_sense >= 1591 THEN 'S'
    WHEN control + execution + defending + reaction_time + chemistry + game_sense >= 1509 THEN 'A'
    WHEN control + execution + defending + reaction_time + chemistry + game_sense >= 1427 THEN 'B'
    WHEN control + execution + defending + reaction_time + chemistry + game_sense >= 1279 THEN 'C'
    WHEN control + execution + defending + reaction_time + chemistry + game_sense >= 1199 THEN 'D'
    WHEN control + execution + defending + reaction_time + chemistry + game_sense >= 1030 THEN 'E'
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
    SELECT CASE WHEN total >= 1591 THEN 'S' WHEN total >= 1509 THEN 'A'
        WHEN total >= 1427 THEN 'B' WHEN total >= 1279 THEN 'C'
        WHEN total >= 1199 THEN 'D' WHEN total >= 1030 THEN 'E' ELSE 'F' END
    FROM draft_totals WHERE draft_totals.id = player_drafts.id
)) WHERE id IN (SELECT id FROM draft_totals);
