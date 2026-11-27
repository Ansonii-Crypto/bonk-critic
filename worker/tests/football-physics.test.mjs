import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import test from 'node:test';
import {FootballPhysics, FOOTBALL_CONSTANTS as C, createState, getPitchGeometry} from '../../football/physics.js';
import {DEFAULT_MATCH_SETTINGS, SETTING_RULES, validateMatchSettings} from '../../football/settings.js';

const players = [{id: 0, team: 3, name: 'Blue'}, {id: 1, team: 2, name: 'Red'}];
const approximately = (actual, expected, tolerance = 1e-9) => {
    assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} should equal ${expected} (±${tolerance})`);
};

function active(roster = players) {
    return createState(roster, {kickoffTicks: -1, seed: 42});
}

function kickingState(velocity = 0) {
    const state = active([players[0]]);
    Object.assign(state.discs[0], {x: 20, y: 22, xv: 0, yv: 0});
    Object.assign(state.ball, {x: 22.1, y: 22, xv: velocity, yv: 0});
    return state;
}

test('native kickoff geometry, opposing spawns, and alternating team rows', () => {
    const roster = [2, 3, 2, 3, 2, 3, 0].map((team, id) => ({id, team, name: String(id)}));
    const state = createState(roster);
    assert.equal(state.ftu, 120);
    assert.equal(state.fte, -1);
    assert.deepEqual(state.scores, [0, 0, 0, 0]);
    approximately(state.ball.x * state.ppm, 365);
    approximately(state.ball.y * state.ppm, 250);
    assert.deepEqual(state.discs.slice(0, 6).map(disc => Math.round(disc.x * C.PPM)), [615, 115, 615, 115, 615, 115]);
    assert.deepEqual(state.discs.slice(0, 6).map(disc => Math.round(disc.y * C.PPM)), [250, 250, 330, 170, 170, 330]);
    assert.equal(state.discs[6], undefined);
    assert.notEqual(state.players[0], roster[0]);
});

test('30 Hz force integration, unnormalized diagonals, action slowdown, and special braking', () => {
    const physics = new FootballPhysics();
    const state = active([players[0]]);
    const normal = physics.step(state, [{right: true, down: true}]);
    const expected = C.MOVE_FORCE / C.PLAYER_MASS * C.DT * (1 - C.PLAYER_LINEAR_DAMPING * C.DT);
    approximately(normal.discs[0].xv, expected);
    approximately(normal.discs[0].yv, expected);
    approximately(normal.discs[0].x, state.discs[0].x + expected * C.DT);
    const action = physics.step(state, [{right: true, action: true}]);
    approximately(action.discs[0].xv, expected * 0.7);
    const braking = structuredClone(state);
    braking.discs[0].xv = 8;
    const braked = physics.step(braking, [{left: true, action2: true}]);
    approximately(braked.discs[0].xv, 8 * 0.92);
    const contradictory = physics.step(state, [{left: true, right: true, up: true, down: true}]);
    approximately(contradictory.discs[0].xv, -expected);
    approximately(contradictory.discs[0].yv, -expected);
});

test('kick adds native impulse to existing ball momentum and uses ball damping', () => {
    const physics = new FootballPhysics();
    for (const velocity of [-8, 0, 8]) {
        const state = kickingState(velocity);
        const next = physics.step(state, [{action: true}]);
        approximately(next.ball.xv, (velocity + 25) * 0.98);
        approximately(next.ball.yv, 0);
        assert.equal(next.discs[0].kickReady, false);
        assert.equal(next.sts.filter(sound => sound.i === 'footKick').length, 1);
        assert.equal(state.discs[0].kickReady, true);
        assert.equal(state.ball.xv, velocity);
    }
});

test('successful held kick latches until a release tick; unused held kick remains ready', () => {
    const physics = new FootballPhysics();
    let state = physics.step(kickingState(), [{action: true}]);
    Object.assign(state.ball, {x: state.discs[0].x + 2.1, y: state.discs[0].y, xv: 0, yv: 0});
    state = physics.step(state, [{action: true}]);
    approximately(state.ball.xv, 0);
    assert.equal(state.discs[0].kickReady, false);
    state = physics.step(state, [{}]);
    assert.equal(state.discs[0].kickReady, true);
    state = physics.step(state, [{action: true}]);
    approximately(state.ball.xv, 24.5);
    const outOfRange = kickingState();
    outOfRange.ball.x = outOfRange.discs[0].x + 2.31;
    const waiting = physics.step(outOfRange, [{action: true}]);
    approximately(waiting.ball.xv, 0);
    assert.equal(waiting.discs[0].kickReady, true);
});

test('modified Box2D reflects the ball from walls while players pass through inner walls', () => {
    const physics = new FootballPhysics();
    const state = active([players[0]]);
    const top = 75 / C.PPM;
    Object.assign(state.discs[0], {x: 20, y: top + 0.08, xv: 0, yv: -8});
    Object.assign(state.ball, {x: 40, y: top + C.BALL_RADIUS + 0.06, xv: 0, yv: -15});
    const next = physics.step(state, [{}]);
    assert.ok(next.discs[0].y < top, 'player crosses the inner wall');
    approximately(next.discs[0].yv, -8 * 0.92);
    assert.ok(next.ball.y >= top + C.BALL_RADIUS - 0.03, 'ball stays inside the wall');
    assert.ok(next.ball.yv > 0, 'ball reflects inward');
    approximately(next.ball.yv, 15 * 0.98 * 0.8, 1e-6);
});

test('round goal posts reflect both players and ball with restitution 0.9', () => {
    const physics = new FootballPhysics();
    const postX = 30 / C.PPM;
    const postY = 250 / C.PPM - C.GOAL_HEIGHT / 2;
    const playerContact = active([players[0]]);
    Object.assign(playerContact.discs[0], {x: postX + 2, y: postY, xv: -12, yv: 0});
    const playerNext = physics.step(playerContact, [{}]);
    assert.ok(playerNext.discs[0].xv > 0, 'player reflects from post');
    approximately(playerNext.discs[0].xv, 12 * 0.92 * 0.9, 1e-6);
    const ballContact = active([]);
    Object.assign(ballContact.ball, {x: postX + 1.6, y: postY, xv: -12, yv: 0});
    const ballNext = physics.step(ballContact);
    assert.ok(ballNext.ball.xv > 0, 'ball reflects from post');
    approximately(ballNext.ball.xv, 12 * 0.98 * 0.9, 1e-6);
});

test('physical player collisions transfer momentum according to the native unequal masses', () => {
    const physics = new FootballPhysics();
    const state = active([players[0]]);
    Object.assign(state.discs[0], {x: 22.15, y: 22, xv: 0, yv: 0});
    Object.assign(state.ball, {x: 20, y: 22, xv: 25, yv: 0});
    const next = physics.step(state, [{}]);
    assert.ok(next.discs[0].xv > 0, 'ball pushes the movable player');
    assert.ok(next.ball.xv > 0 && next.ball.xv < 5, 'ball transfers momentum rather than reflecting from a static obstacle');
    approximately(next.ball.xv * C.BALL_MASS + next.discs[0].xv * C.PLAYER_MASS, 25 * 0.98 * C.BALL_MASS, 1e-6);
});

test('left goal credits red, right goal credits blue, and celebration does not score twice', () => {
    for (const [x, xv, team] of [[3, -20, 2], [C.WIDTH / C.PPM - 3, 20, 3]]) {
        const physics = new FootballPhysics();
        const state = active([]);
        Object.assign(state.ball, {x, xv});
        let next = physics.step(state);
        assert.equal(next.scores[team], 1);
        assert.equal(next.lscr, team);
        assert.equal(next.fte, 90);
        assert.equal(next.sts.filter(sound => sound.i === 'footGoal').length, 1);
        next = physics.step(next);
        assert.equal(next.scores[team], 1);
        assert.equal(next.fte, 89);
        assert.notEqual(next.ball.x, state.ball.x, 'physics continues during celebration');
        for (let i = 0; i < 89; i++) next = physics.step(next);
        assert.equal(next.fte, 0);
        next = physics.step(next);
        assert.equal(next.fte, -1);
        assert.equal(next.ftu, 120);
        assert.equal(next.scores[team], 1);
        approximately(next.ball.x, C.WIDTH / 2 / C.PPM);
        approximately(next.ball.xv, 0);
    }
});

test('native kickoff freezes inputs and physics until the tick after countdown reaches -1', () => {
    const physics = new FootballPhysics();
    let state = createState([players[0]], {kickoffTicks: 1});
    state.ball.xv = 10;
    const startX = state.ball.x;
    state = physics.step(state, [{right: true, action: true}]);
    assert.equal(state.ftu, 0);
    approximately(state.ball.x, startX);
    approximately(state.discs[0].xv, 0);
    state = physics.step(state, [{right: true}]);
    assert.equal(state.ftu, -1);
    approximately(state.ball.x, startX);
    state = physics.step(state, [{right: true}]);
    assert.ok(state.ball.x > startX);
    assert.ok(state.discs[0].xv > 0);
});

test('JSON checkpoints, sparse slots, player departures, and independent worlds stay deterministic', () => {
    const roster = [];
    roster[2] = {id: 2, team: 3, name: 'Third slot'};
    roster[7] = {id: 7, team: 2, name: 'Eighth slot'};
    const first = new FootballPhysics();
    const second = new FootballPhysics();
    let a = active(roster);
    let b = JSON.parse(JSON.stringify(a));
    for (let i = 0; i < 60; i++) {
        const inputs = {2: {right: true, down: i < 30}, 7: {left: true, action: i % 3 === 0}};
        a = first.step(a, inputs);
        second.step(kickingState(), [{action: true}]);
        b = second.step(b, inputs);
        assert.deepEqual(JSON.parse(JSON.stringify(a)), JSON.parse(JSON.stringify(b)));
    }
    const next = first.step(a, {}, {playersLeft: [2]});
    assert.equal(next.players[2], null);
    assert.equal(next.discs[2], undefined);
    assert.ok(next.discs[7]);
    assert.equal(first.world.GetBodyCount(), 1, 'tick body cleanup leaves only the ground body');
    assert.equal(second.world.GetBodyCount(), 1);
});

test('coincident kick centres never create NaN or infinite state', () => {
    const physics = new FootballPhysics();
    const state = kickingState();
    state.ball.x = state.discs[0].x;
    const next = physics.step(state, [{action: true}]);
    for (const body of [next.ball, ...next.discs]) {
        for (const key of ['x', 'y', 'xv', 'yv']) assert.ok(Number.isFinite(body[key]), `${key} is finite`);
    }
    assert.equal(next.discs[0].kickReady, false);
});

// State-only fixtures were captured by executing the original supplied football
// functions, independently of this wrapper. They also pin contact ordering,
// native sound events, and complete round transitions over multiple ticks.
const nativeFixtures = JSON.parse(readFileSync(new URL('./fixtures/football-native-parity.json', import.meta.url), 'utf8'));
for (const scenario of nativeFixtures.scenarios) {
    test(`original client parity: ${scenario.name}`, () => {
        const physics = new FootballPhysics();
        let state = structuredClone(scenario.initial);
        for (const segment of scenario.segments) {
            for (let tick = 0; tick < segment.ticks; tick++) state = physics.step(state, segment.inputs);
        }
        assert.deepEqual(JSON.parse(JSON.stringify(state)), scenario.expected);
    });
}

test('match settings validate finite numeric patches atomically and preserve current values', () => {
    const current = {...DEFAULT_MATCH_SETTINGS, scoreLimit: 5, maxPerTeam: 8};
    const patch = {kickImpulse: 22.5, moveForce: 64};
    const result = validateMatchSettings(patch, current);
    assert.equal(result.error, null);
    assert.deepEqual(result.settings, {...DEFAULT_MATCH_SETTINGS, scoreLimit: 5, kickImpulse: 22.5, moveForce: 64});
    assert.equal(current.maxPerTeam, 8);
    assert.equal(current.kickImpulse, 15);
    assert.deepEqual(patch, {kickImpulse: 22.5, moveForce: 64});
    for (const invalid of [null, [], 2, 'settings']) assert.equal(validateMatchSettings(invalid).settings, null);
    assert.match(validateMatchSettings({maxPerTeam: 8}).error, /Unknown match setting/);
    assert.match(validateMatchSettings({moveForce: 64, secret: 1}).error, /Unknown match setting/);
    for (const key of Object.keys(DEFAULT_MATCH_SETTINGS)) {
        for (const invalid of [NaN, Infinity, -Infinity, null, '12', true]) {
            const rejected = validateMatchSettings({[key]: invalid});
            assert.equal(rejected.settings, null, `${key} rejects ${String(invalid)}`);
            assert.match(rejected.error, /finite number/);
        }
    }
});

test('match setting bounds, score integers, disabled goals, and dependent geometry are checked', () => {
    for (const [key, rule] of Object.entries(SETTING_RULES)) {
        assert.equal(typeof rule.label, 'string');
        assert.equal(typeof rule.unit, 'string');
        assert.ok(rule.step > 0 && rule.min < rule.max);
        for (const value of [rule.min - 10, rule.max + 10]) {
            assert.ok(validateMatchSettings({[key]: value}).error, `${key} rejects ${value}`);
        }
    }
    assert.ok(validateMatchSettings({scoreLimit: 2.5}).error);
    for (const goalHeight of [-2, -0.5, 0, 0.5]) assert.ok(validateMatchSettings({goalHeight}).error);
    assert.equal(validateMatchSettings({goalHeight: -1}).error, null);
    assert.ok(validateMatchSettings({goalHeight: 40}).error, 'opening cannot exceed the current inner height');
    assert.equal(validateMatchSettings({goalHeight: 40, pitchHeight: 700}).error, null);
    assert.equal(validateMatchSettings({pitchHeight: 300}).error, null);
    assert.throws(() => createState(players, {settings: {ballRadius: -1}}), RangeError);
    assert.deepEqual(createState(players, {settings: DEFAULT_MATCH_SETTINGS}), createState(players));
});

test('custom radii scale kick reach while custom movement force and kick impulse are applied', () => {
    const physics = new FootballPhysics();
    const settings = {playerRadius: 1.5, ballRadius: 1.2, moveForce: 64, kickImpulse: 18};
    const state = createState([players[0]], {settings, kickoffTicks: -1});
    Object.assign(state.discs[0], {x: 20, y: 22, xv: 0, yv: 0});
    Object.assign(state.ball, {x: 23, y: 22, xv: 0, yv: 0});
    const next = physics.step(state, [{right: true, action: true}]);
    approximately(next.ball.xv, 18 / C.BALL_MASS * 0.98);
    approximately(next.discs[0].xv, 64 * 0.7 / C.PLAYER_MASS * C.DT * 0.92);
    assert.equal(next.discs[0].kickReady, false);
    const outside = structuredClone(state);
    outside.ball.x = 23.31;
    const missed = physics.step(outside, [{action: true}]);
    approximately(missed.ball.xv, 0);
    assert.equal(missed.discs[0].kickReady, true);
    const geometry = getPitchGeometry(next);
    approximately(geometry.world.ballRadius, 1.2);
    approximately(geometry.world.playerRadius, 1.5);
    approximately(geometry.pixels.ballRadius, 13.2);
});

test('custom ball and player radii change real Box2D wall and post contacts', () => {
    const physics = new FootballPhysics();
    const settings = {ballRadius: 1.2, playerRadius: 1.5};
    const state = createState([players[0]], {settings, kickoffTicks: -1});
    const geometry = getPitchGeometry(state).world;
    Object.assign(state.ball, {x: 40, y: geometry.top + 1.2 + 0.06, xv: 0, yv: -15});
    Object.assign(state.discs[0], {x: geometry.posts[0].x + 2.5, y: geometry.posts[0].y, xv: -12, yv: 0});
    const next = physics.step(state, [{}]);
    assert.ok(next.ball.yv > 0, 'larger ball meets the top wall sooner');
    assert.ok(next.ball.y >= geometry.top + 1.2 - 0.03);
    assert.ok(next.discs[0].xv > 0, 'larger player meets the circular post sooner');
});

test('custom pitch dimensions set geometry, proportional spawns, player clamps, and goal boundaries', () => {
    const physics = new FootballPhysics();
    const settings = {pitchWidth: 1000, pitchHeight: 700, goalHeight: 18, playerRadius: 1.5};
    const state = createState(players, {settings, kickoffTicks: -1});
    const geometry = getPitchGeometry(state);
    assert.equal(geometry.pixels.width, 1000);
    assert.equal(geometry.pixels.height, 700);
    assert.equal(geometry.pixels.right, 970);
    assert.equal(geometry.pixels.bottom, 625);
    assert.equal(geometry.pixels.goalTop, 251);
    assert.equal(geometry.pixels.goalBottom, 449);
    approximately(state.ball.x, 500 / C.PPM);
    approximately(state.ball.y, 350 / C.PPM);
    approximately(state.discs[0].x * C.PPM, 115 * (1000 / 730));
    Object.assign(state.discs[0], {x: 200, y: 200, xv: 8, yv: 8});
    Object.assign(state.ball, {x: geometry.world.right - 0.1, xv: 20, yv: 0});
    const next = physics.step(state);
    assert.equal(next.scores[3], 1, 'blue scores at the custom right goal');
    approximately(next.discs[0].x, 1000 / C.PPM - 1.5);
    approximately(next.discs[0].y, 700 / C.PPM - 1.5);
    approximately(next.discs[0].xv, 0);
    approximately(next.discs[0].yv, 0);
});

test('goal height -1 closes both side walls and disables all scoring', () => {
    const physics = new FootballPhysics();
    for (const side of ['left', 'right']) {
        const state = createState([], {settings: {goalHeight: -1}, kickoffTicks: -1});
        const geometry = getPitchGeometry(state);
        assert.equal(geometry.goalEnabled, false);
        assert.deepEqual(geometry.pixels.posts, []);
        assert.equal(geometry.pixels.goalTop, 250);
        const direction = side === 'left' ? -1 : 1;
        Object.assign(state.ball, {x: geometry.world[side] - direction, xv: direction * 25});
        const next = physics.step(state);
        assert.ok(next.ball.xv * direction < 0, `${side} former goal mouth reflects the ball`);
        assert.deepEqual(next.scores, [0, 0, 0, 0]);
        assert.equal(next.fte, -1);
        assert.equal(next.sts.some(sound => sound.i === 'footGoal'), false);
        // Even an externally restored checkpoint outside the pitch must not
        // accidentally trigger native x-only goal detection in this mode.
        next.ball.x = side === 'left' ? 0 : C.WIDTH / C.PPM;
        const restored = physics.step(next);
        assert.deepEqual(restored.scores, [0, 0, 0, 0]);
        assert.equal(restored.fte, -1);
    }
});

test('custom goal opening changes physical side-wall and post locations', () => {
    const physics = new FootballPhysics();
    const state = createState([], {settings: {goalHeight: 6}, kickoffTicks: -1});
    const geometry = getPitchGeometry(state).world;
    Object.assign(state.ball, {x: geometry.left + 1, y: 250 / C.PPM - 5, xv: -25, yv: 0});
    const next = physics.step(state);
    assert.ok(next.ball.xv > 0, 'ball reflects where the smaller opening has a side wall');
    assert.equal(next.scores[2], 0);
    approximately(geometry.posts[0].y, 250 / C.PPM - 3);
});

test('custom settings survive JSON checkpoints and automatic kickoffs without leaking between worlds', () => {
    const settings = {scoreLimit: 7, goalHeight: 9, moveForce: 48, kickImpulse: 20, ballRadius: 0.9, playerRadius: 1.2, pitchWidth: 900, pitchHeight: 600};
    const physics = new FootballPhysics();
    let state = createState(players, {settings, seed: 77, kickoffTicks: -1});
    const expected = {...DEFAULT_MATCH_SETTINGS, ...settings};
    state.scores[2] = 2;
    state = physics.step(JSON.parse(JSON.stringify(state)), [{right: true}]);
    assert.deepEqual(state.settings, expected);
    const originalVelocity = state.discs[0].xv;
    const native = physics.step(active([players[0]]), [{right: true}]);
    approximately(native.discs[0].xv, originalVelocity * (32 / 48));
    assert.equal(native.settings, undefined);
    state.fte = 0;
    state = physics.step(state);
    assert.deepEqual(state.settings, expected);
    assert.equal(state.ftu, 120);
    assert.equal(state.seed, 77);
    assert.equal(state.scores[2], 2);
    approximately(state.ball.x, 450 / C.PPM);
    approximately(state.ball.y, 300 / C.PPM);
    assert.equal(state.goalHeight, 9);
});

test('geometry previews accept settings-only states and zero-strength kicks stay finite', () => {
    const geometry = getPitchGeometry({settings: {pitchWidth: 900, pitchHeight: 600, goalHeight: -1}});
    assert.equal(geometry.ppm, 11);
    assert.equal(geometry.pixels.width, 900);
    assert.equal(geometry.pixels.top, 75);
    assert.equal(geometry.goalEnabled, false);
    assert.equal(getPitchGeometry().pixels.width, 730);
    const state = createState([players[0]], {settings: {moveForce: 0, kickImpulse: 0}, kickoffTicks: -1});
    Object.assign(state.ball, {...state.discs[0]});
    const next = new FootballPhysics().step(state, [{right: true, action: true}]);
    for (const body of [next.ball, ...next.discs]) {
        for (const key of ['x', 'y', 'xv', 'yv']) assert.ok(Number.isFinite(body[key]));
    }
    approximately(next.ball.xv, 0);
    approximately(next.discs[0].xv, 0);
});

test('coasting keeps native momentum and damping while ignoring controls and preserving round state', () => {
    const physics = new FootballPhysics();
    let state = createState([players[0]], {settings: {moveForce: 64, kickImpulse: 30}, kickoffTicks: 120});
    state.fte = 0;
    state.scores = [0, 0, 3, 2];
    state.lscr = 2;
    Object.assign(state.discs[0], {x: 20, y: 22, xv: 4, yv: 0});
    Object.assign(state.ball, {x: 22.1, y: 22, xv: 8, yv: 0});
    const settings = structuredClone(state.settings);
    for (let tick = 1; tick <= 30; tick++) {
        state = physics.step(state, [{right: true, down: true, action: true}], {coast: true});
        approximately(state.discs[0].xv, 4 * 0.92 ** tick);
        approximately(state.discs[0].yv, 0);
        approximately(state.ball.xv, 8 * 0.98 ** tick);
        assert.deepEqual(state.scores, [0, 0, 3, 2]);
        assert.equal(state.ftu, 120);
        assert.equal(state.fte, 0);
        assert.equal(state.lscr, 2);
        assert.equal(state.discs[0].kickReady, true);
        assert.equal(state.sts.some(sound => sound.i === 'footKick'), false);
        assert.deepEqual(state.settings, settings);
    }
    assert.ok(state.ball.x > 22.1 && state.discs[0].x > 20, 'the bodies move rather than freezing or respawning');
});

test('coasting resolves native wall, post, and moving-player contacts', () => {
    const physics = new FootballPhysics();
    const wallAndPost = active([players[0]]);
    const geometry = getPitchGeometry(wallAndPost).world;
    Object.assign(wallAndPost.ball, {x: 40, y: geometry.top + C.BALL_RADIUS + 0.06, xv: 0, yv: -15});
    Object.assign(wallAndPost.discs[0], {x: geometry.posts[0].x + 2, y: geometry.posts[0].y, xv: -12, yv: 0});
    const movingContact = active([players[0]]);
    Object.assign(movingContact.discs[0], {x: 22.15, y: 22, xv: 0, yv: 0});
    Object.assign(movingContact.ball, {x: 20, y: 22, xv: 25, yv: 0});
    for (const state of [wallAndPost, movingContact]) {
        const normal = physics.step(state, [{}]);
        const coast = physics.step(state, [{right: true, action: true}], {coast: true});
        assert.deepEqual(coast.ball, normal.ball);
        assert.deepEqual(coast.discs, normal.discs);
    }
    const reflected = physics.step(wallAndPost, [], {coast: true});
    assert.ok(reflected.ball.yv > 0);
    assert.ok(reflected.discs[0].xv > 0);
    const transferred = physics.step(movingContact, [], {coast: true});
    assert.ok(transferred.discs[0].xv > 0);
    assert.ok(transferred.ball.xv > 0 && transferred.ball.xv < 5);
});

test('coasting never scores through an open goal and still removes departed players', () => {
    const physics = new FootballPhysics();
    const state = active(players);
    state.discs[1].kickReady = false;
    Object.assign(state.ball, {x: 3, xv: -20, yv: 0});
    const coast = physics.step(state, [{action: true}, {}], {coast: true, playersLeft: [0]});
    assert.ok(coast.ball.x < 30 / C.PPM, 'the ball has crossed the native goal plane');
    assert.deepEqual(coast.scores, state.scores);
    assert.equal(coast.lscr, -1);
    assert.equal(coast.fte, -1);
    assert.equal(coast.ftu, -1);
    assert.equal(coast.sts.some(sound => sound.i === 'footGoal'), false);
    assert.equal(coast.players[0], null);
    assert.equal(coast.discs[0], undefined);
    assert.equal(coast.discs[1].kickReady, false, 'coasting does not rearm a released action');
});
