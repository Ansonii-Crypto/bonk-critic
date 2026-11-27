import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import test from 'node:test';
import {FootballPhysics, FOOTBALL_CONSTANTS as C, createState, getPitchGeometry, getPlayerBounds} from '../../football/physics.js';
import {DEFAULT_MATCH_SETTINGS, SETTING_RULES, validateMatchSettings, goalHeightLimit} from '../../football/settings.js';

const players = [{id: 0, team: 3, name: 'Blue'}, {id: 1, team: 2, name: 'Red'}];
const approximately = (actual, expected, tolerance = 1e-9) => {
    assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} should equal ${expected} (±${tolerance})`);
};

test('lobby practice accepts movement and kicks without kickoff freezes, goals or round resets', () => {
    const physics = new FootballPhysics(), state = kickingState();
    state.ftu = 120; state.fte = 0;
    const next = physics.step(state, [{right: true, action: true}], {practice: true});
    assert.ok(next.discs[0].x > state.discs[0].x);
    assert.ok(next.ball.xv > 24);
    assert.equal(next.ftu, -1); assert.equal(next.fte, -1);
    assert.deepEqual(next.scores, [0, 0, 0, 0]);
    assert.ok(next.sts.some(sound => sound.i === 'footKick'));
    Object.assign(next.ball, {x: 29 / C.PPM, y: 250 / C.PPM, xv: -20, yv: 0});
    const throughGoal = physics.step(next, [], {practice: true});
    assert.deepEqual(throughGoal.scores, [0, 0, 0, 0]);
    assert.equal(throughGoal.ftu, -1); assert.equal(throughGoal.fte, -1);
    assert.equal(throughGoal.sts.some(sound => sound.i === 'footGoal'), false);
});

test('legacy practice ball recovery respects the default visible game box', () => {
    const physics = new FootballPhysics(); let state = active([players[0]]);
    Object.assign(state.ball, {x: 0.1, y: 250 / C.PPM, xv: -30, yv: 0});
    Object.assign(state.discs[0], {x: 0.5, y: 1.1, xv: -5, yv: -5});
    state = physics.step(state, [{left: true, up: true}], {practice: true});
    assert.equal(state.ball.x, C.BALL_RADIUS); assert.ok(state.ball.xv > 0);
    assert.equal(state.discs[0].x, C.PLAYER_RADIUS); assert.equal(state.discs[0].y, C.PLAYER_RADIUS);
    for (let index = 0; index < 600; index++) state = physics.step(state, [{right: true, down: true}], {practice: true});
    assert.equal(state.discs[0].x, C.WIDTH / C.PPM - C.PLAYER_RADIUS);
    assert.equal(state.discs[0].y, C.HEIGHT / C.PPM - C.PLAYER_RADIUS);
    assert.ok(state.ball.x >= C.BALL_RADIUS && state.ball.x <= C.WIDTH / C.PPM - C.BALL_RADIUS);
    assert.deepEqual(state.scores, [0, 0, 0, 0]);
});

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

test('match setting bounds, score integers, signed goals, and dependent geometry are checked', () => {
    for (const [key, rule] of Object.entries(SETTING_RULES)) {
        assert.equal(typeof rule.label, 'string');
        assert.equal(typeof rule.unit, 'string');
        assert.ok(rule.step > 0 && rule.min < rule.max);
        for (const value of [rule.min - 10, rule.max + 10]) {
            assert.ok(validateMatchSettings({[key]: value}).error, `${key} rejects ${value}`);
        }
    }
    assert.ok(validateMatchSettings({scoreLimit: 2.5}).error);
    for (const goalHeight of [-2, -0.5, 0, 0.5]) assert.equal(validateMatchSettings({goalHeight}).error, null);
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

test('custom pitch dimensions set geometry, proportional spawns, visible bounds and goal boundaries', () => {
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
    approximately(next.discs[0].x, getPlayerBounds(state, 0).right);
    approximately(next.discs[0].y, getPlayerBounds(state, 0).bottom);
    approximately(next.discs[0].xv, 0);
    approximately(next.discs[0].yv, 0);
});

test('goal height zero closes both side walls and disables all scoring', () => {
    const physics = new FootballPhysics();
    for (const side of ['left', 'right']) {
        const state = createState([], {settings: {goalHeight: 0}, kickoffTicks: -1});
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
    const geometry = getPitchGeometry({settings: {pitchWidth: 900, pitchHeight: 600, goalHeight: 0}});
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

test('signed goal height accepts the exact full playable height for every supported pitch size', () => {
    for (const pitchHeight of [300, 500, 600, 1000]) {
        const maximum = goalHeightLimit({pitchHeight});
        approximately(maximum * C.PPM, pitchHeight - 150);
        for (const goalHeight of [-maximum, 0, maximum]) {
            assert.equal(validateMatchSettings({pitchHeight, goalHeight}).error, null);
            const state = createState([], {settings: {pitchHeight, goalHeight}, kickoffTicks: -1});
            const next = new FootballPhysics().step(state);
            for (const value of Object.values(next.ball)) assert.ok(Number.isFinite(value));
        }
        assert.ok(validateMatchSettings({pitchHeight, goalHeight: maximum + 0.01}).error);
        assert.ok(validateMatchSettings({pitchHeight, goalHeight: -maximum - 0.01}).error);
    }
    assert.equal(SETTING_RULES.moveForce.min, -128);
    assert.equal(SETTING_RULES.ballRadius.step, 0.1);
    assert.equal(SETTING_RULES.playerRadius.step, 0.1);
    assert.equal(validateMatchSettings({ballRadius: 0.725, playerRadius: 1.125}).error, null, 'older fine-grained radius values remain valid');
    for (const goalHeight of [-Number.MIN_VALUE, -1e-200, -1e-12, Number.MIN_VALUE]) {
        const next = new FootballPhysics().step(createState([], {settings: {goalHeight}, kickoffTicks: -1}));
        assert.ok(Object.values(next.ball).every(Number.isFinite), 'tiny signed values cannot create degenerate Box2D fixtures');
    }
});

test('negative goal geometry has complete side walls without openings or posts', () => {
    const geometry = getPitchGeometry({settings: {goalHeight: -13}});
    const g = geometry.pixels;
    assert.equal(geometry.goalEnabled, false);
    assert.equal(geometry.goalInverted, false);
    assert.equal(geometry.goalMode, 'closed');
    assert.equal(g.goalTop, 250);
    assert.equal(g.goalBottom, 250);
    assert.deepEqual(g.goalOpenings, []);
    assert.deepEqual(g.sideWalls, [{top: 75, bottom: 425}]);
    assert.ok(g.wallSegments.some(segment => segment.x1 === 30 && segment.y1 === 75 && segment.y2 === 425));
    assert.equal(g.posts.length, 0);
    for (let i = 0; i < g.wallSegments.length; i++) {
        for (const key of ['x1', 'y1', 'x2', 'y2']) approximately(geometry.world.wallSegments[i][key] * C.PPM, g.wallSegments[i][key]);
    }
});

test('all nonpositive goal heights bounce the ball at every height band on both sides and never score', () => {
    const physics = new FootballPhysics();
    for (const goalHeight of [0, -Number.MIN_VALUE, -1e-12, -0.5, -1, -13, -goalHeightLimit()]) {
        for (const side of ['left', 'right']) {
            const state = createState([], {settings: {goalHeight}, kickoffTicks: -1});
            const g = getPitchGeometry(state).world;
            const direction = side === 'left' ? -1 : 1;
            for (const y of [g.top + 3, g.centerY, g.bottom - 3]) {
                const shot = structuredClone(state);
                Object.assign(shot.ball, {x: g[side] - direction, y, xv: direction * 40});
                const rebound = physics.step(shot);
                assert.ok(rebound.ball.xv * direction < 0, 'the full side wall reflects the ball inward');
                assert.deepEqual(rebound.scores, [0, 0, 0, 0]);
                assert.equal(rebound.fte, -1);
                assert.ok(Object.values(rebound.ball).every(Number.isFinite));
            }
            for (const y of [g.top - 3, g.top + 3, g.centerY, g.bottom - 3, g.bottom + 3]) {
                const restored = structuredClone(state);
                Object.assign(restored.ball, {x: g[side] + direction * 2, y, xv: 0, yv: 0});
                assert.deepEqual(physics.step(restored).scores, [0, 0, 0, 0], 'outside checkpoints cannot score at any height');
            }
        }
    }
});

test('positive full-height goals open the entire side while negative full height closes it', () => {
    const maximum = goalHeightLimit();
    const physics = new FootballPhysics();
    for (const goalHeight of [maximum, -maximum]) {
        const state = createState([], {settings: {goalHeight}, kickoffTicks: -1});
        const geometry = getPitchGeometry(state), g = geometry.world;
        Object.assign(state.ball, {x: g.left + 1, y: g.centerY, xv: -40});
        const next = physics.step(state);
        if (goalHeight > 0) {
            assert.equal(geometry.goalEnabled, true);
            assert.deepEqual(g.sideWalls, []);
            assert.equal(g.wallSegments.length, 2);
            assert.equal(next.scores[2], 1);
        } else {
            assert.equal(geometry.goalEnabled, false);
            assert.deepEqual(g.goalOpenings, []);
            assert.equal(g.posts.length, 0);
            assert.ok(next.ball.xv > 0);
            assert.equal(next.scores[2], 0);
        }
    }
});

test('negative movement force reverses both control axes without changing native damping', () => {
    const physics = new FootballPhysics();
    const state = createState([players[0]], {settings: {moveForce: -32}, kickoffTicks: -1});
    const next = physics.step(state, [{right: true, down: true}]);
    const expected = -32 / C.PLAYER_MASS / 30 * 0.92;
    approximately(next.discs[0].xv, expected);
    approximately(next.discs[0].yv, expected);
    const opposite = physics.step(state, [{left: true, up: true}]);
    approximately(opposite.discs[0].xv, -expected);
    approximately(opposite.discs[0].yv, -expected);
});

test('players can traverse letterbox margins and stop at their own visible game box edges', () => {
    const physics = new FootballPhysics();
    const cases = [
        {x: 0.2, y: 2, input: {left: true}, aspect: 2, axis: 'x', edge: 'left', boundary: 0, sign: -1},
        {x: C.WIDTH / C.PPM - 0.2, y: 2, input: {right: true}, aspect: 2, axis: 'x', edge: 'right', boundary: C.WIDTH / C.PPM, sign: 1},
        {x: 20, y: 0.2, input: {up: true}, aspect: 1, axis: 'y', edge: 'top', boundary: 0, sign: -1},
        {x: 20, y: C.HEIGHT / C.PPM - 0.2, input: {down: true}, aspect: 1, axis: 'y', edge: 'bottom', boundary: C.HEIGHT / C.PPM, sign: 1},
    ];
    for (const example of cases) {
        let state = active([players[0]]);
        state.players[0].viewportAspect = example.aspect;
        Object.assign(state.discs[0], {x: example.x, y: example.y});
        for (let tick = 0; tick < 12; tick++) state = physics.step(state, [example.input]);
        assert.ok((state.discs[0][example.axis] - example.boundary) * example.sign > 0);
        assert.ok(state.discs[0][example.axis + 'v'] * example.sign > 0);
        for (let tick = 0; tick < 120; tick++) state = physics.step(state, [example.input]);
        approximately(state.discs[0][example.axis], getPlayerBounds(state, 0)[example.edge]);
        approximately(state.discs[0][example.axis + 'v'], 0);
    }
});

test('visible bounds are per player, radius-aware, validated, and preserved through JSON and kickoffs', () => {
    const state = createState([
        {...players[0], viewportAspect: 2},
        {...players[1], viewportAspect: 1},
    ], {settings: {playerRadius: 1.5}, kickoffTicks: -1});
    const wide = getPlayerBounds(state, 0), tall = getPlayerBounds(state, 1);
    assert.ok(wide.left < 0 && wide.right > C.WIDTH / C.PPM);
    approximately(wide.top, 1.5);
    approximately(wide.bottom, C.HEIGHT / C.PPM - 1.5);
    assert.ok(tall.top < 0 && tall.bottom > C.HEIGHT / C.PPM);
    approximately(tall.left, 1.5);
    approximately(tall.right, C.WIDTH / C.PPM - 1.5);
    const fallback = {left: 1.5, right: C.WIDTH / C.PPM - 1.5, top: 1.5, bottom: C.HEIGHT / C.PPM - 1.5};
    for (const invalid of [undefined, null, NaN, Infinity, 0, -1, 0.124, 8.001, '2']) {
        state.players[0].viewportAspect = invalid;
        assert.deepEqual(getPlayerBounds(state, 0), fallback);
    }
    state.players[0].viewportAspect = 2;
    const physics = new FootballPhysics();
    let next = physics.step(JSON.parse(JSON.stringify(state)));
    assert.equal(next.players[0].viewportAspect, 2);
    assert.equal(next.players[1].viewportAspect, 1);
    next.fte = 0;
    next = physics.step(next);
    assert.equal(next.players[0].viewportAspect, 2);
    assert.deepEqual(getPlayerBounds(next, 0), wide);
    // Shrinking a viewport clamps the body while preserving velocity already
    // pointing back into the new visible area.
    next.ftu = -1;
    next.players[0].viewportAspect = C.WIDTH / C.HEIGHT;
    Object.assign(next.discs[0], {x: -3, y: 2, xv: 4, yv: 0});
    next = physics.step(next, [], {coast: true});
    approximately(next.discs[0].x, 1.5 + 4 * 0.92 / 30);
    approximately(next.discs[0].xv, 4 * 0.92);
});

test('reused worlds match fresh worlds through default, resized, closed, and restored pitch contacts', () => {
    const reused = new FootballPhysics();
    const large = {pitchWidth: 1000, pitchHeight: 700};
    const maximum = {pitchWidth: 1460, pitchHeight: 1000, goalHeight: 26.7};
    const posts = [
        ...getPitchGeometry(createState()).world.posts,
        ...getPitchGeometry(createState([], {settings: large})).world.posts,
        ...getPitchGeometry(createState([], {settings: maximum})).world.posts,
    ];
    const sizes = [{}, large, maximum, {pitchWidth: 400, pitchHeight: 300, goalHeight: 6}, {pitchWidth: 900, pitchHeight: 600, goalHeight: -13}, {}];
    for (const settings of sizes) {
        for (const kind of ['ball', 'player']) {
            for (const post of posts) {
                let expected = createState([players[0]], {settings, kickoffTicks: -1});
                const g = getPitchGeometry(expected).world;
                const body = kind === 'ball' ? expected.ball : expected.discs[0];
                Object.assign(body, {x: post.x - 2.3, y: post.y, xv: 18, yv: 0});
                if (kind === 'ball') Object.assign(expected.discs[0], {x: g.centerX, y: g.height - 2});
                else Object.assign(expected.ball, {x: g.centerX, y: g.centerY});
                let actual = structuredClone(expected);
                for (let tick = 0; tick < 8; tick++) {
                    actual = reused.step(actual, [], {coast: true});
                    expected = new FootballPhysics().step(expected, [], {coast: true});
                    assert.deepEqual(actual, expected);
                }
                assert.equal(reused.world.GetBodyCount(), 1);
            }
        }
    }
});

test('old posts are empty after pitch growth and new posts collide with both ball and player', () => {
    const physics = new FootballPhysics();
    physics.step(active(players));
    const oldPost = getPitchGeometry(createState()).world.posts[1];
    const settings = {pitchWidth: 1460, pitchHeight: 1000, goalHeight: 26.7};
    for (const kind of ['ball', 'player']) {
        let state = createState([players[0]], {settings, kickoffTicks: -1});
        const body = kind === 'ball' ? state.ball : state.discs[0];
        Object.assign(body, {x: oldPost.x - 2.3, y: oldPost.y, xv: 18, yv: 0});
        if (kind === 'ball') state.discs[0].y = 50;
        else state.ball.y = 50;
        for (let tick = 1; tick <= 8; tick++) {
            state = physics.step(state, [], {coast: true});
            approximately((kind === 'ball' ? state.ball : state.discs[0]).xv, 18 * (kind === 'ball' ? 0.98 : 0.92) ** tick);
        }
        const contact = createState([players[0]], {settings, kickoffTicks: -1});
        const post = getPitchGeometry(contact).world.posts[1];
        Object.assign(kind === 'ball' ? contact.ball : contact.discs[0], {x: post.x - (kind === 'ball' ? 1.6 : 2), y: post.y, xv: 18, yv: 0});
        const next = physics.step(contact, [], {coast: true});
        assert.ok((kind === 'ball' ? next.ball : next.discs[0]).xv < 0, 'only the new post reflects the body');
    }
});

test('viewport shrink starts player contacts at the new edge rather than the hidden old position', () => {
    const physics = new FootballPhysics();
    const examples = [
        {axis: 'x', velocity: 'xv', player: -5, ball: -6.8, speed: -18, edge: 'left'},
        {axis: 'x', velocity: 'xv', player: 75, ball: 76.8, speed: 18, edge: 'right'},
        {axis: 'y', velocity: 'yv', player: -5, ball: -6.8, speed: -18, edge: 'top'},
        {axis: 'y', velocity: 'yv', player: 53, ball: 54.8, speed: 18, edge: 'bottom'},
    ];
    for (const example of examples) {
        const state = active([{...players[0], viewportAspect: C.WIDTH / C.HEIGHT}]);
        Object.assign(state.discs[0], {x: 20, y: 22, [example.axis]: example.player, [example.velocity]: example.speed});
        Object.assign(state.ball, {x: 20, y: 22, [example.axis]: example.ball, xv: 0, yv: 0});
        const next = physics.step(state, [], {coast: true});
        approximately(next.discs[0][example.axis], getPlayerBounds(state, 0)[example.edge]);
        approximately(next.discs[0][example.velocity], 0);
        approximately(next.ball.xv, 0);
        approximately(next.ball.yv, 0);
        approximately(next.ball[example.axis], example.ball);
        assert.equal(state.discs[0][example.axis], example.player, 'source checkpoint is not mutated');
        assert.equal(state.discs[0][example.velocity], example.speed);
        const nativeFallback = structuredClone(state);
        delete nativeFallback.players[0].viewportAspect;
        const legacy = physics.step(nativeFallback, [], {coast: true});
        assert.ok(Math.abs(legacy.ball[example.velocity]) > 1, 'without resize metadata the old native post-step clamp would allow this contact');
    }
});
