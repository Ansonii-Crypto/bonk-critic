export const ROCKET_TURN_TICKS = 900;

export const FOOTBALL_MODES = Object.freeze({
    balanced: Object.freeze({
        id: 'balanced',
        label: 'Balanced football',
        description: 'Balanced teams with up to four players on each side.',
        maxPerTeam: 4,
        maxPlayers: 8,
    }),
    rockets: Object.freeze({
        id: 'rockets',
        label: 'Rockets',
        description: 'Take turns to score the fastest goal in 30 seconds.',
        turnTicks: ROCKET_TURN_TICKS,
        maxPlayers: 64,
    }),
});

// Project-002/football-ball-speed.user.js:16-20 reads the current state's
// velocity directly. Box2D already reports metres/second; ppm is drawing only.
export function ballSpeed(state) {
    const ball = state?.ball;
    if (!ball || !Number.isFinite(ball.xv) || !Number.isFinite(ball.yv)) return null;
    return Math.hypot(ball.xv, ball.yv);
}

export function goalSpeed(beforeState, afterState) {
    const team = afterState?.lscr;
    if ((team !== 2 && team !== 3) || beforeState?.ftu !== -1 || beforeState?.fte !== -1
        || afterState?.ftu !== -1 || afterState?.fte !== 90
        || beforeState.goalHeight === 0 || afterState.goalHeight === 0) return null;
    const opponent = team === 2 ? 3 : 2;
    const before = beforeState.scores;
    const after = afterState.scores;
    if (!Array.isArray(before) || !Array.isArray(after)
        || !Number.isFinite(before[team]) || !Number.isFinite(before[opponent])
        || after[team] !== before[team] + 1 || after[opponent] !== before[opponent]) return null;
    // The userscript has no goal detector. Capture its metric from the new
    // scoring state, after the crossing tick's damping and physical contacts.
    return ballSpeed(afterState);
}

function joinOrder(a, b) {
    const aTime = Number.isFinite(a.joinedAt) ? a.joinedAt : Infinity;
    const bTime = Number.isFinite(b.joinedAt) ? b.joinedAt : Infinity;
    if (aTime !== bTime) return aTime < bTime ? -1 : 1;
    const aId = String(a.id);
    const bId = String(b.id);
    if (aId !== bId) return aId < bId ? -1 : 1;
    const aSlot = Number.isInteger(a.slot) ? a.slot : Infinity;
    const bSlot = Number.isInteger(b.slot) ? b.slot : Infinity;
    return aSlot === bSlot ? 0 : aSlot < bSlot ? -1 : 1;
}

function orderedMembers(members, eligibleOnly) {
    const seen = new Set();
    return (Array.isArray(members) ? members : []).filter(member => {
        if (!member || member.id === undefined || member.id === null || seen.has(member.id)) return false;
        if (eligibleOnly && (member.connected !== true || (member.team !== 2 && member.team !== 3 && member.queued !== true))) return false;
        seen.add(member.id);
        return true;
    }).sort(joinOrder);
}

export function rocketsRoster(members) {
    return orderedMembers(members, true).slice(0, FOOTBALL_MODES.rockets.maxPlayers);
}

export function balancedTeamAssignments(members, maxPerTeam = FOOTBALL_MODES.balanced.maxPerTeam) {
    if (!Number.isInteger(maxPerTeam) || maxPerTeam < 1 || maxPerTeam > 32) {
        throw new RangeError('Team capacity must be a whole number from 1 to 32.');
    }
    const candidates = orderedMembers(members, true);
    const selected = candidates.slice(0, maxPerTeam * 2);
    const count = selected.length;
    const existingBlue = selected.filter(member => member.team === 3).length;
    const existingRed = selected.filter(member => member.team === 2).length;
    const lower = Math.floor(count / 2);
    const upper = Math.ceil(count / 2);
    // Either side may have the odd player. Pick the option requiring the fewest
    // existing players to move, with Blue receiving the odd place on ties.
    const blueExtraCost = Math.max(0, existingBlue - upper) + Math.max(0, existingRed - lower);
    const redExtraCost = Math.max(0, existingBlue - lower) + Math.max(0, existingRed - upper);
    const target = blueExtraCost <= redExtraCost ? {3: upper, 2: lower} : {3: lower, 2: upper};
    const assigned = new Map();
    const sizes = {2: 0, 3: 0};
    for (const member of selected) {
        if ((member.team === 2 || member.team === 3) && sizes[member.team] < target[member.team]) {
            assigned.set(member.id, member.team);
            sizes[member.team]++;
        }
    }
    for (const member of selected) {
        if (assigned.has(member.id)) continue;
        const team = sizes[3] < target[3] && (sizes[2] === target[2] || sizes[3] <= sizes[2]) ? 3 : 2;
        assigned.set(member.id, team);
        sizes[team]++;
    }
    return {
        assignments: selected.map(member => ({id: member.id, team: assigned.get(member.id)})),
        queue: candidates.slice(selected.length).map(member => member.id),
    };
}

export function rocketsLeaderboard(members, records = {}) {
    const roster = orderedMembers(members, false);
    const entries = roster.map(member => {
        const record = records instanceof Map ? records.get(member.id)
            : records && Object.hasOwn(records, member.id) ? records[member.id] : null;
        const scored = record?.scored === true && Number.isFinite(record.speed) && record.speed >= 0;
        const speed = scored ? record.speed : null;
        return {
            id: member.id,
            name: member.name,
            speed,
            bestSpeed: speed,
            scored,
            timeTicks: Number.isFinite(record?.timeTicks) && record.timeTicks >= 0 ? record.timeTicks : null,
        };
    });
    // The input is already in join order; an explicit original index also
    // keeps ties deterministic across runtimes and after checkpoint replay.
    return entries.map((entry, order) => ({entry, order})).sort((a, b) => {
        if (a.entry.speed === null && b.entry.speed !== null) return 1;
        if (a.entry.speed !== null && b.entry.speed === null) return -1;
        return (b.entry.speed ?? 0) - (a.entry.speed ?? 0) || a.order - b.order;
    }).map(({entry}, index) => ({...entry, rank: index + 1}));
}
