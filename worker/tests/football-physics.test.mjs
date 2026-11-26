import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import test from 'node:test';
import {FootballPhysics, FOOTBALL_CONSTANTS as C, createState} from '../../football/physics.js';

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
