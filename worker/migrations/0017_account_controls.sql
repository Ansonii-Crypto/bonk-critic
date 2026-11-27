-- Bonk login_legacy.php returns serialized account controls. Store only the
-- validated football bindings/filter preference, never the provider payload.
CREATE TABLE IF NOT EXISTS bonk_account_controls(
    bonk_id TEXT PRIMARY KEY REFERENCES bonk_users(bonk_id) ON DELETE CASCADE,
    controls_json TEXT
);
