import assert from 'node:assert/strict';
import test from 'node:test';
import {
    FOOTBALL_MODES,
    ROCKET_TURN_TICKS,
    ballSpeed,
    goalSpeed,
    balancedTeamAssignments,
    rocketsRoster,
    rocketsLeaderboard,
} from '../../football/modes.js';
import {FootballPhysics, createState} from '../../football/physics.js';

function member(id, joinedAt, team = 0, overrides = {}) {
    return {id, name: `Player ${id}`, joinedAt, team, queued: team === 0, connected: true, ...overrides};
}

function goalStates(team = 2, xv = 3, yv = 4) {
    const before = {scores: [0, 0, 1, 2], ftu: -1, fte: -1, goalHeight: 13, ball: {xv: 20, yv: 0}};
    const after = structuredClone(before);
    after.scores[team]++;
    Object.assign(after, {lscr: team, fte: 90, ball: {xv, yv}});
    return {before, after};
}

test('mode metadata distinguishes balanced teams from 900 active-tick rocket turns', () => {
    assert.deepEqual(Object.keys(FOOTBALL_MODES), ['balanced', 'rockets']);
    assert.equal(FOOTBALL_MODES.balanced.maxPerTeam, 4);
    assert.equal(FOOTBALL_MODES.balanced.maxPlayers, 8);
    assert.equal(FOOTBALL_MODES.rockets.maxPlayers, 64);
    assert.equal(ROCKET_TURN_TICKS, 30 * 30);
    assert.equal(FOOTBALL_MODES.rockets.turnTicks, ROCKET_TURN_TICKS);
    assert.ok(Object.isFrozen(FOOTBALL_MODES.balanced));
});

test('speed matches the supplied userscript numeric fixtures in metres per second', () => {
    for (const [xv, yv, expected] of [[3, 4, 5], [-5, 12, 13], [0, -24.5, 24.5], [0, 0, 0], [0.3, 0.4, 0.5]]) {
        for (const ppm of [undefined, 11, 1000]) assert.equal(ballSpeed({ball: {xv, yv}, ppm}), expected);
        for (const team of [2, 3]) {
            const {before, after} = goalStates(team, xv, yv);
            assert.equal(goalSpeed(before, after), expected);
        }
    }
    for (const state of [null, {}, {ball: {}}, {ball: {xv: NaN, yv: 0}}, {ball: {xv: 0, yv: Infinity}}, {ball: {xv: '3', yv: 4}}]) {
        assert.equal(ballSpeed(state), null);
    }
});

test('goal speed captures the scoring state after native physics damping, without rounding or unit conversion', () => {
    const physics = new FootballPhysics();
    const before = createState([], {kickoffTicks: -1});
    Object.assign(before.ball, {x: 3, xv: -20, yv: 0});
    const after = physics.step(before);
    assert.equal(after.scores[2], 1);
    assert.equal(ballSpeed(before), 20);
    assert.equal(goalSpeed(before, after), 19.6);
    assert.equal(goalSpeed(before, after) * 3.6, 70.56, 'kilometres/hour conversion belongs to the consumer');
    const precise = goalStates(3, 12.3456789, 0);
    assert.equal(goalSpeed(precise.before, precise.after), 12.3456789);
});

test('goal speed rejects stale celebrations, kickoff, disabled goals, and invalid score transitions', () => {
    const modifiers = [
        ({before}) => {before.fte = 90;},
        ({before}) => {before.ftu = 0;},
        ({after}) => {after.ftu = 0;},
        ({after}) => {after.fte = 89;},
        ({after}) => {after.lscr = 0;},
        ({after}) => {after.scores[2] = 1;},
        ({after}) => {after.scores[2] = 3;},
        ({after}) => {after.scores[3]++;},
        ({before}) => {before.scores[2] = NaN;},
        ({before}) => {before.scores = null;},
        ({before}) => {before.goalHeight = -1;},
        ({after}) => {after.goalHeight = -1;},
        ({after}) => {after.ball.xv = Infinity;},
    ];
    for (const modify of modifiers) {
        const pair = goalStates();
        modify(pair);
        assert.equal(goalSpeed(pair.before, pair.after), null);
    }
    assert.equal(goalSpeed(null, null), null);
});

test('balanced mode fills four per side in FIFO order and queues overflow without enrolling spectators', () => {
    const candidates = Array.from({length: 11}, (_, index) => member(`p${index}`, index));
    candidates.push(member('watcher', -2, 0, {queued: false}), member('offline', -1, 3, {connected: false}));
    const original = structuredClone(candidates);
    const result = balancedTeamAssignments([...candidates].reverse());
    assert.deepEqual(result.assignments.map(item => item.id), ['p0', 'p1', 'p2', 'p3', 'p4', 'p5', 'p6', 'p7']);
    assert.equal(result.assignments.filter(item => item.team === 3).length, 4);
    assert.equal(result.assignments.filter(item => item.team === 2).length, 4);
    assert.deepEqual(result.queue, ['p8', 'p9', 'p10']);
    assert.deepEqual(candidates, original);
});

test('balancing preserves existing teams whenever possible and moves the newest excess player', () => {
    const balanced = [member('a', 1, 3), member('b', 2, 2), member('c', 3, 3), member('d', 4, 2), member('e', 5)];
    assert.deepEqual(balancedTeamAssignments(balanced).assignments, [
        {id: 'a', team: 3}, {id: 'b', team: 2}, {id: 'c', team: 3}, {id: 'd', team: 2}, {id: 'e', team: 3},
    ]);
    const excess = [member('a', 1, 3), member('b', 2, 3), member('c', 3, 3), member('d', 4, 2)];
    assert.deepEqual(balancedTeamAssignments(excess).assignments, [
        {id: 'a', team: 3}, {id: 'b', team: 3}, {id: 'c', team: 2}, {id: 'd', team: 2},
    ]);
    const redMajority = [member('a', 1, 2), member('b', 2, 2), member('c', 3, 2), member('d', 4, 3), member('e', 5, 3)];
    assert.deepEqual(balancedTeamAssignments(redMajority).assignments.map(item => item.team), [2, 2, 2, 3, 3]);
});

test('all small roster distributions use a mathematically minimal number of team changes', () => {
    for (let count = 0; count <= 8; count++) {
        for (let blue = 0; blue <= count; blue++) {
            for (let red = 0; red <= count - blue; red++) {
                const roster = Array.from({length: count}, (_, index) => member(String(index), index, index < blue ? 3 : index < blue + red ? 2 : 0));
                let minimum = Infinity;
                for (let mask = 0; mask < 2 ** count; mask++) {
                    let blueSize = 0;
                    let changes = 0;
                    roster.forEach((person, index) => {
                        const team = mask & (1 << index) ? 3 : 2;
                        if (team === 3) blueSize++;
                        if (person.team && person.team !== team) changes++;
                    });
                    if (Math.abs(blueSize - (count - blueSize)) <= 1) minimum = Math.min(minimum, changes);
                }
                const result = balancedTeamAssignments(roster);
                const changes = result.assignments.filter((assignment, index) => roster[index].team && roster[index].team !== assignment.team).length;
                assert.equal(changes, minimum, `${count} participants, ${blue} blue and ${red} red`);
                const blueSize = result.assignments.filter(item => item.team === 3).length;
                assert.ok(Math.abs(blueSize - (count - blueSize)) <= 1);
                assert.ok(blueSize <= 4 && count - blueSize <= 4);
            }
        }
    }
});

test('join ties, small capacities, empty rosters, and repeated identities are deterministic', () => {
    const roster = [member('z', 1), member('b', 1), member('a', 1), member('c', 1)];
    const result = balancedTeamAssignments(roster, 1);
    assert.deepEqual(result.assignments, [{id: 'a', team: 3}, {id: 'b', team: 2}]);
    assert.deepEqual(result.queue, ['c', 'z']);
    assert.deepEqual(balancedTeamAssignments([]), {assignments: [], queue: []});
    assert.deepEqual(balancedTeamAssignments([roster[0], roster[0]]).assignments, [{id: 'z', team: 3}]);
    for (const capacity of [0, -1, 1.5, 33, NaN, '4']) assert.throws(() => balancedTeamAssignments(roster, capacity), RangeError);
});

test('rocket turns select connected active and queued participants in stable join order, capped at 64', () => {
    const a = member('a', 10, 3), b = member('b', 10, 2), c = member('c', 11);
    const watcher = member('watcher', 1, 0, {queued: false});
    const offline = member('offline', 0, 2, {connected: false});
    assert.deepEqual(rocketsRoster([c, b, watcher, offline, a]).map(item => item.id), ['a', 'b', 'c']);
    assert.equal(rocketsRoster([a])[0], a);
    const many = Array.from({length: 70}, (_, index) => member(String(index), index));
    assert.equal(rocketsRoster(many).length, 64);
    assert.equal(rocketsRoster(many).at(-1).id, '63');
});

test('rocket leaderboard ranks each best speed descending, breaks ties by join order, and retains precision', () => {
    const roster = [member('d', 4), member('b', 2), member('a', 1), member('c', 3), member('e', 5)];
    const records = {
        a: {speed: 90.123456, scored: true, timeTicks: 300},
        b: {speed: 110.75, scored: true, timeTicks: 100},
        c: {speed: 90.123456, scored: true, timeTicks: 50},
        d: {speed: null, scored: false, timeTicks: 900},
        e: {speed: 0, scored: true, timeTicks: 800},
        departed: {speed: 999, scored: true, timeTicks: 1},
    };
    const original = structuredClone(records);
    const result = rocketsLeaderboard(roster, records);
    assert.deepEqual(result.map(item => item.id), ['b', 'a', 'c', 'e', 'd']);
    assert.deepEqual(result.map(item => item.rank), [1, 2, 3, 4, 5]);
    assert.equal(result[1].speed, 90.123456);
    assert.equal(result[1].bestSpeed, result[1].speed);
    assert.equal(result[1].timeTicks, 300);
    assert.equal(result[4].speed, null);
    assert.equal(result[4].scored, false);
    assert.deepEqual(records, original);
    assert.deepEqual(rocketsLeaderboard(roster, new Map(Object.entries(records))), result);
});

test('leaderboard ignores invalid records and leaves participant departure/grace decisions to the caller', () => {
    const roster = [member('b', 1, 0, {connected: false}), member('a', 1), member('c', 2), member('d', 3)];
    const records = {
        a: {speed: Infinity, scored: true, timeTicks: -1},
        b: {speed: 50, scored: true, timeTicks: 500},
        c: {speed: -5, scored: true, timeTicks: NaN},
        d: {speed: 10, scored: false},
    };
    const result = rocketsLeaderboard(roster, records);
    assert.deepEqual(result.map(item => item.id), ['b', 'a', 'c', 'd']);
    assert.equal(result[0].speed, 50, 'a disconnected participant passed by the caller retains their score');
    assert.deepEqual(result.slice(1).map(item => item.speed), [null, null, null]);
    assert.equal(result[1].timeTicks, null);
    assert.equal(result[2].timeTicks, null);
    assert.deepEqual(rocketsLeaderboard([], records), []);
});
