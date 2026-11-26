import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {DatabaseSync} from 'node:sqlite';
import test from 'node:test';

const worker = (await import('../src/index.js')).default;
const attributes = ['control', 'execution', 'defending', 'reaction_time', 'chemistry', 'game_sense'];
const origin = 'https://bonk-critic.com';
const bands = [[0, 'F'], [258, 'E'], [516, 'D'], [774, 'C'], [1158, 'B'], [1296, 'A'], [1536, 'S']];
const expectedTier = total => [...bands].reverse().find(([minimum]) => total >= minimum)[1];
const digest = async value => Buffer.from(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))).toString('hex');

function assessment(total, name = 'Test player', date = '2026-11-25') {
    const base = Math.floor(total / attributes.length), remainder = total % attributes.length;
    return {name, assessed_at: date, overall_tier: 'S', class_name: 'Weaver',
        ...Object.fromEntries(attributes.map((key, index) => [key, base + (index < remainder ? 1 : 0)]))};
}

async function environment(t) {
    const db = new DatabaseSync(':memory:');
    t.after(() => db.close());
    db.exec('PRAGMA foreign_keys=ON');
    db.exec(readFileSync(new URL('../schema.sql', import.meta.url), 'utf8'));
    function prepare(sql, values = []) {
        return {
            bind(...args) { return prepare(sql, args); },
            async first() { return db.prepare(sql).get(...values) || null; },
            async all() { return {results: db.prepare(sql).all(...values)}; },
            async run() { return {meta: {changes: Number(db.prepare(sql).run(...values).changes)}}; }
        };
    }
    const env = {ALLOWED_ORIGIN: origin, API_RATE_LIMITER: {async limit() { return {success: true}; }},
        LOGIN_RATE_LIMITER: {async limit() { return {success: true}; }}, DB: {prepare, async batch(statements) {
            db.exec('BEGIN');
            try {
                const result = [];
                for (const statement of statements) result.push(await statement.run());
                db.exec('COMMIT');
                return result;
            } catch (error) { db.exec('ROLLBACK'); throw error; }
        }}};
    const user = crypto.randomUUID() + crypto.randomUUID(), admin = crypto.randomUUID() + crypto.randomUUID();
    const userDigest = await digest(user), adminDigest = await digest(admin);
    db.prepare('INSERT INTO bonk_users VALUES(?,?,?)').run('3177088', 'Test administrator', '2026-11-25');
    db.prepare('INSERT INTO admin_bonk_links VALUES(?,?)').run('primary-zimble', '3177088');
    db.prepare('INSERT INTO admin_credentials(account_id,code_hash) VALUES(?,?)').run('primary-zimble', 'test-only');
    db.prepare('INSERT INTO user_sessions VALUES(?,?,?)').run(userDigest, '3177088', Date.now() + 600000);
    db.prepare('INSERT INTO admin_sessions VALUES(?,?,?)').run(adminDigest, Date.now() + 600000, 'primary-zimble');
    db.prepare('INSERT INTO admin_session_identity VALUES(?,?)').run(adminDigest, userDigest);
    const request = (path, {body, method, authenticated = true} = {}) => worker.fetch(new Request('https://api.test' + path, {
        method: method || (body ? 'POST' : 'GET'),
        headers: {Origin: origin, 'Content-Type': 'application/json', ...(authenticated ? {'X-Account-Session': user, Authorization: 'Bearer ' + admin} : {})},
        ...(body ? {body: JSON.stringify(body)} : {})
    }), env);
    async function create(total, name, date) {
        const response = await request('/api/players', {body: assessment(total, name, date)});
        const result = await response.json();
        assert.equal(response.status, 201, JSON.stringify(result));
        return result.id;
    }
    return {db, request, create};
}

test('published assessment tiers use fixed total boundaries and ignore supplied tiers', async t => {
    const {db, request, create} = await environment(t);
    const totals = [0, 1800, ...bands.slice(1).flatMap(([minimum]) => [minimum - 1, minimum])];
    for (const total of totals) {
        const id = await create(total, 'Boundary ' + total);
        const player = db.prepare('SELECT * FROM players WHERE id=?').get(id);
        const saved = db.prepare('SELECT * FROM assessments WHERE player_id=?').get(id);
        assert.equal(player.overall_tier, expectedTier(total), 'player total ' + total);
        assert.equal(saved.overall_tier, expectedTier(total), 'assessment total ' + total);
        assert.equal(saved.total, total);
        const publicView = await (await request('/api/players/' + id, {authenticated: false})).json();
        assert.equal(publicView.player.overall_tier, expectedTier(total));
        assert.equal(publicView.history[0].overall_tier, expectedTier(total));
    }
    const before = db.prepare('SELECT COUNT(*) AS count FROM players').get().count;
    for (const control of [-1, 301, 1.5, 'not a score']) {
        const response = await request('/api/players', {body: {...assessment(1400, 'Invalid ' + control), control}});
        assert.equal(response.status, 400);
    }
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM players').get().count, before);
});

test('the published tier definition uses fixed ability scores and their six-attribute totals', async t => {
    const {request, create} = await environment(t);
    const response = await request('/api/tier-system', {authenticated: false});
    assert.equal(response.status, 200);
    const definition = await response.json();
    assert.equal(definition.metadata.version, '2026-11-26-fixed-score-v1');
    assert.equal(definition.metadata.effectiveAt, '2026-11-26');
    assert.deepEqual(definition.cutoffs.map(item => item.score), [43, 86, 129, 193, 216, 256]);
    assert.deepEqual(definition.cutoffs.map(item => [item.total, item.tier]), bands.slice(1));
    assert.doesNotMatch(JSON.stringify(definition), /percentile|sampleSize|referenceTotals|calibratedAt/);
    for (const cutoff of definition.cutoffs) {
        assert.equal(cutoff.total, cutoff.score * attributes.length, cutoff.tier + ' total');
        assert.equal(globalThis.BonkRatings.tierForTotal(cutoff.total), cutoff.tier);
        assert.equal(globalThis.BonkRatings.tierForScore(cutoff.score), cutoff.tier);
        assert.equal(globalThis.BonkRatings.tierForScore(cutoff.score - 1), expectedTier((cutoff.score - 1) * 6));
        assert.equal(globalThis.BonkRatings.tierForScore(cutoff.score - 0.01), expectedTier(cutoff.total - 1));
    }
    await create(1800, 'A new qualifying player');
    await request('/api/player-drafts', {body: {data: assessment(0, 'Unpublished draft')}});
    assert.deepEqual(await (await request('/api/tier-system', {authenticated: false})).json(), definition);
    assert.doesNotMatch(JSON.stringify(definition), /bonk_id|owner_id|account_id|password|token/);
});

test('editing and adding assessments recalculate tiers while keeping historical totals and locks intact', async t => {
    const {db, request, create} = await environment(t);
    const id = await create(1400, 'Changing player', '2026-11-20');
    const first = db.prepare('SELECT id FROM assessments WHERE player_id=?').get(id).id;
    let response = await request('/api/players/' + id, {method: 'PUT', body: {...assessment(1509, 'Changing player', '2026-11-20'), assessment_id: first, overall_tier: 'F'}});
    assert.equal(response.status, 200);
    assert.equal(db.prepare('SELECT overall_tier FROM assessments WHERE id=?').get(first).overall_tier, 'A');
    response = await request('/api/players/' + id, {method: 'PUT', body: {...assessment(1279, 'Changing player', '2026-11-25'), new_assessment: true, overall_tier: 'S'}});
    assert.equal(response.status, 200);
    const history = db.prepare('SELECT * FROM assessments WHERE player_id=? ORDER BY id').all(id);
    assert.deepEqual(history.map(item => [item.total, item.overall_tier]), [[1509, 'A'], [1279, 'B']]);
    assert.equal(db.prepare('SELECT overall_tier FROM players WHERE id=?').get(id).overall_tier, 'B');
    const change = JSON.parse(db.prepare("SELECT assessment_changes FROM activity_logs WHERE assessment_changes IS NOT NULL ORDER BY id LIMIT 1").get().assessment_changes);
    assert.equal(change.after.overall_tier, 'A');
    db.prepare('UPDATE players SET locked=1 WHERE id=?').run(id);
    response = await request('/api/players/' + id, {method: 'PUT', body: {...assessment(1800, 'Changing player'), assessment_id: first}});
    assert.equal(response.status, 423);
    assert.deepEqual(db.prepare('SELECT total,overall_tier FROM assessments WHERE player_id=? ORDER BY id').all(id).map(item => [item.total, item.overall_tier]), [[1509, 'A'], [1279, 'B']]);
});

test('saved drafts are reclassified when read, edited and pushed without trusting a stale tier', async t => {
    const {db, request} = await environment(t);
    const created = await (await request('/api/player-drafts', {body: {data: {name: 'Draft', control: '200', overall_tier: 'S'}}})).json();
    assert.equal(JSON.parse(db.prepare('SELECT data FROM player_drafts WHERE id=?').get(created.id).data).overall_tier, 'F');
    const complete = assessment(1427, 'Draft');
    const updated = await request('/api/player-drafts/' + created.id, {method: 'PUT', body: {revision: created.revision, data: {...complete, overall_tier: 'F'}}});
    assert.equal(updated.status, 200);
    const revision = (await updated.json()).revision;
    db.prepare('UPDATE player_drafts SET data=json_set(data,\'$.overall_tier\',\'S\') WHERE id=?').run(created.id);
    const list = await (await request('/api/player-drafts')).json();
    assert.equal(list.drafts[0].data.overall_tier, 'A');
    assert.equal(list.drafts[0].revision, revision);
    const pushed = await request('/api/player-drafts/' + created.id + '/push', {body: {revision}});
    assert.equal(pushed.status, 201);
    const id = (await pushed.json()).id;
    assert.equal(db.prepare('SELECT overall_tier FROM players WHERE id=?').get(id).overall_tier, 'A');
    assert.equal(db.prepare('SELECT overall_tier FROM assessments WHERE player_id=?').get(id).overall_tier, 'A');
});

test('a top-ranked player needs the S benchmark and every qualifying player can be S', async t => {
    const {db, create} = await environment(t);
    const id = await create(1400, 'Existing player');
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM players').get().count, 1);
    assert.equal(db.prepare('SELECT overall_tier FROM players WHERE id=?').get(id).overall_tier, 'A');
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM players WHERE overall_tier='S'").get().count, 0);
    const qualified = [];
    for (const total of [1536, 1591, 1800]) qualified.push(await create(total, 'Qualified ' + total));
    assert.deepEqual(qualified.map(playerId => db.prepare('SELECT overall_tier FROM players WHERE id=?').get(playerId).overall_tier), ['S', 'S', 'S']);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM players WHERE overall_tier='S'").get().count, 3);
    for (let index = 0; index < 5; index++) await create(0, 'New low score ' + index);
    assert.equal(db.prepare('SELECT overall_tier FROM players WHERE id=?').get(id).overall_tier, 'A');
    assert.equal(db.prepare('SELECT overall_tier FROM assessments WHERE player_id=?').get(id).overall_tier, 'A');
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM players WHERE overall_tier='S'").get().count, 3);
});

test('deleting assessments restores the prior calculated tier and leaves an empty record at F', async t => {
    const {db, request, create} = await environment(t);
    const id = await create(1509, 'Deleting player', '2026-11-20');
    await request('/api/players/' + id, {method: 'PUT', body: {...assessment(1591, 'Deleting player'), new_assessment: true}});
    const ids = db.prepare('SELECT id FROM assessments WHERE player_id=? ORDER BY assessed_at DESC,id DESC').all(id).map(item => item.id);
    assert.equal(ids.length, 2);
    assert.equal((await request('/api/players/' + id + '/assessments/' + ids[0], {method: 'DELETE'})).status, 200);
    assert.equal(db.prepare('SELECT overall_tier FROM players WHERE id=?').get(id).overall_tier, 'A');
    assert.equal((await request('/api/players/' + id + '/assessments/' + ids[1], {method: 'DELETE'})).status, 200);
    assert.equal(db.prepare('SELECT overall_tier FROM players WHERE id=?').get(id).overall_tier, 'F');
});

test('public reads reclassify legacy player and assessment tiers without rewriting their records', async t => {
    const {db, request, create} = await environment(t);
    const id = await create(1427, 'Legacy player');
    db.prepare('UPDATE players SET overall_tier=\'F\',locked=1 WHERE id=?').run(id);
    db.prepare('UPDATE assessments SET overall_tier=\'F\' WHERE player_id=?').run(id);
    const directory = await (await request('/api/players', {authenticated: false})).json();
    assert.equal(directory.players.find(player => player.id === id).overall_tier, 'A');
    const profile = await (await request('/api/players/' + id, {authenticated: false})).json();
    assert.equal(profile.player.overall_tier, 'A');
    assert.equal(profile.history[0].overall_tier, 'A');
    const recent = await (await request('/api/recent-assessments', {authenticated: false})).json();
    assert.equal(recent.updates.find(player => player.id === id).overall_tier, 'A');
    assert.equal(db.prepare('SELECT overall_tier FROM players WHERE id=?').get(id).overall_tier, 'F');
    assert.equal(db.prepare('SELECT locked FROM players WHERE id=?').get(id).locked, 1);
});

test('the tier migration reclassifies locked records, history and drafts without changing scores or editorial metadata', async t => {
    const {db, request, create} = await environment(t);
    const id = await create(1400, 'Migration player', '2026-11-20');
    await request('/api/players/' + id, {method: 'PUT', body: {...assessment(1536, 'Migration player'), new_assessment: true}});
    db.prepare('UPDATE players SET overall_tier=\'F\',locked=1,updated_at=\'2026-11-01\' WHERE id=?').run(id);
    db.prepare('UPDATE assessments SET overall_tier=\'F\',notes=\'Keep these notes\' WHERE player_id=?').run(id);
    // A stored total must not override the six actual attributes used for classification.
    db.prepare('UPDATE assessments SET total=0 WHERE player_id=? AND assessed_at=\'2026-11-20\'').run(id);
    const draft = {...assessment(1279, 'Existing draft'), overall_tier: 'S', custom_note: 'Preserve unknown draft fields'};
    db.prepare('INSERT INTO player_drafts VALUES(?,?,?,?,?,?)').run('existing-draft', 'primary-zimble', 'Original author', JSON.stringify(draft), 7, '2026-10-25');
    db.prepare('INSERT INTO player_drafts VALUES(?,?,?,?,?,?)').run('partial-draft', 'primary-zimble', 'Original author', JSON.stringify({name: 'Incomplete', control: '200', overall_tier: 'S'}), 3, '2026-10-20');
    db.exec(readFileSync(new URL('../migrations/0015_percentile_tiers.sql', import.meta.url), 'utf8'));
    const beforePlayer = db.prepare('SELECT * FROM players WHERE id=?').get(id);
    const beforeHistory = db.prepare('SELECT * FROM assessments WHERE player_id=? ORDER BY id').all(id);
    const beforeDrafts = db.prepare('SELECT * FROM player_drafts ORDER BY id').all();
    const beforeLogs = db.prepare('SELECT * FROM activity_logs ORDER BY id').all();
    const migration = readFileSync(new URL('../migrations/0016_fixed_score_tiers.sql', import.meta.url), 'utf8');
    db.exec(migration);
    const afterPlayer = db.prepare('SELECT * FROM players WHERE id=?').get(id);
    assert.deepEqual({...afterPlayer, overall_tier: beforePlayer.overall_tier}, {...beforePlayer});
    assert.equal(afterPlayer.overall_tier, 'S');
    const afterHistory = db.prepare('SELECT * FROM assessments WHERE player_id=? ORDER BY id').all(id);
    assert.deepEqual(afterHistory.map((row, index) => ({...row, overall_tier: beforeHistory[index].overall_tier})), beforeHistory.map(row => ({...row})));
    assert.deepEqual(afterHistory.map(row => row.overall_tier), ['A', 'S']);
    const afterDrafts = db.prepare('SELECT * FROM player_drafts ORDER BY id').all();
    assert.deepEqual(afterDrafts.map((row, index) => ({...row, data: beforeDrafts[index].data})), beforeDrafts.map(row => ({...row})));
    assert.deepEqual(afterDrafts.map(row => JSON.parse(row.data).overall_tier), ['B', 'F']);
    for (let index = 0; index < afterDrafts.length; index++) {
        const original = JSON.parse(beforeDrafts[index].data), updated = JSON.parse(afterDrafts[index].data);
        assert.deepEqual({...updated, overall_tier: original.overall_tier}, original);
    }
    assert.deepEqual(db.prepare('SELECT * FROM activity_logs ORDER BY id').all(), beforeLogs);
    assert.equal(db.prepare('PRAGMA foreign_key_check').all().length, 0);
    db.exec(migration);
    assert.deepEqual(db.prepare('SELECT * FROM players WHERE id=?').get(id), afterPlayer);
    assert.deepEqual(db.prepare('SELECT * FROM player_drafts ORDER BY id').all(), afterDrafts);
});
