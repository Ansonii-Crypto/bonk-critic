import {FootballPhysics, FOOTBALL_CONSTANTS as C, getPitchGeometry} from './physics.js?v=20261126-football-3';
import {DEFAULT_MATCH_SETTINGS, SETTING_RULES, validateMatchSettings} from './settings.js';
import {FOOTBALL_MODES} from './modes.js?v=20261126-football-5';

const $ = id => document.getElementById(id);
const canvas = $('footballCanvas');
const context = canvas.getContext('2d');
const API = (window.APP_CONFIG?.API_URL || '').replace(/\/$/, '');
const LOBBY_ID = 'footballdivision';
const controls = {left: 1, right: 2, up: 4, down: 8, action: 16, action2: 32};
const keys = new Map([
    ['ArrowLeft', 1], ['KeyA', 1], ['ArrowRight', 2], ['KeyD', 2],
    ['ArrowUp', 4], ['KeyW', 4], ['ArrowDown', 8], ['KeyS', 8],
    ['KeyX', 16], ['Space', 16], ['ShiftLeft', 16], ['ShiftRight', 16], ['KeyZ', 32]
]);
const held = new Set();
const touches = new Map();
const physics = new FootballPhysics();
let room = null, memberId = null, socket = null, ready = false, sequence = 0;
let flags = 0, busy = false, leaving = false, generation = 0, retries = 0, retryTimer;
let lastState = null, predicted = null, snapshots = [], lastInputs = [];
let lastSnapshotAt = 0, lastPredictionAt = 0, predictionSteps = 0, tick = 0;
let latency = 0, lastFrameAt = performance.now(), audio = null, muted = false;
let notice = '', noticeUntil = 0, latestStatus = '', lastScores = [0, 0, 0, 0];
let account = null, reconnecting = false;
let settingsDirty = false, settingsSignature = '', pendingSettingsSignature = null, geometrySignature = '';
let lastRoomStatus = '', lastRosterSignature = '';
let leaderboardSignature = '', serverClockOffset = 0;
const smoothing = new Map();
const seenChat = new Set();
const viewport = {width: 730, height: 500, scale: 1, x: 0, y: 0, ratio: 1};
const teamName = team => team === 3 ? 'Blue' : team === 2 ? 'Red' : 'Spectators';
const self = () => room?.members.find(member => member.id === memberId);
const isOpen = () => ready && socket?.readyState === WebSocket.OPEN;
const editable = target => target?.closest?.('input,textarea,select,button,summary,[contenteditable="true"]');
const clone = value => JSON.parse(JSON.stringify(value));
const settingsFingerprint = settings => JSON.stringify(Object.keys(SETTING_RULES).map(key => settings[key] ?? DEFAULT_MATCH_SETTINGS[key]));
const countdown = deadline => Math.max(0, Math.ceil((Number(deadline || 0) - Date.now() - serverClockOffset) / 1000));
const modeName = () => room?.mode === 'rockets' ? FOOTBALL_MODES.rockets.label : 'Balanced teams';
const predictionStops = state => state.fte === 0 && (room?.mode === 'rockets' || state.scores.some(score => score >= room.settings.scoreLimit));

function setText(node, text) {
    if (node && node.textContent !== String(text)) node.textContent = String(text);
    if (node?.id === 'connectionStatus') node.dataset.state = String(text).startsWith('Connected') ? 'connected' : 'error';
}

function showNotice(text) {
    notice = text;
    noticeUntil = performance.now() + 6500;
    updateMatchStatus();
}

function accountToken() {
    try {return sessionStorage.getItem('bonk_account_session') || '';} catch {return '';}
}

function savedSeat(id) {
    try {return JSON.parse(sessionStorage.getItem('football-seat:' + id) || 'null');} catch {return null;}
}

function storeSeat(id, member) {
    try {
        if (member) sessionStorage.setItem('football-seat:' + id, JSON.stringify(member));
        else sessionStorage.removeItem('football-seat:' + id);
    } catch {}
}

async function request(path, body) {
    if (!API) throw Error('Football is not configured yet.');
    const token = accountToken();
    let adminToken = '';
    try {adminToken = sessionStorage.getItem('admin_session_token') || '';} catch {}
    const response = await fetch(API + path, {
        method: body ? 'POST' : 'GET', credentials: 'include',
        headers: {'Content-Type': 'application/json', ...(token ? {'X-Account-Session': token} : {}), ...(adminToken ? {Authorization: 'Bearer ' + adminToken} : {})},
        ...(body ? {body: JSON.stringify(body)} : {}), signal: AbortSignal.timeout(12000)
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
        const error = Error(data.error || 'Unable to reach the room. Please try again.');
        error.status = response.status;
        throw error;
    }
    return data;
}

function setBusy(value) {
    busy = value;
    $('roomEntry').querySelectorAll('button[type="submit"]').forEach(button => button.disabled = value);
}

function send(message) {
    if (!isOpen()) return false;
    socket.send(JSON.stringify(message));
    return true;
}

function sendInput() {
    if (!isOpen()) return;
    send({type: 'input', seq: ++sequence, flags: room?.status === 'playing' && self()?.team ? flags : 0});
}

function updateInput() {
    let next = 0;
    for (const key of held) next |= keys.get(key) || 0;
    for (const control of touches.values()) next |= controls[control] || 0;
    if (next === flags) return;
    flags = next;
    sendInput();
}

function releaseInput() {
    held.clear(); touches.clear(); flags = 0;
    document.querySelectorAll('[data-control]').forEach(button => button.classList.remove('is-pressed'));
    sendInput();
}

function warmAudio() {
    if (muted) return;
    const Audio = window.AudioContext || window.webkitAudioContext;
    if (!Audio) return;
    audio ||= new Audio();
    audio.resume().catch(() => {});
}

function tone(frequency, duration = 0.06, volume = 0.035) {
    if (muted || !audio || audio.state !== 'running') return;
    const oscillator = audio.createOscillator(), gain = audio.createGain(), start = audio.currentTime;
    oscillator.type = 'sine'; oscillator.frequency.value = frequency;
    gain.gain.setValueAtTime(volume, start);
    gain.gain.exponentialRampToValueAtTime(0.0001, start + duration);
    oscillator.connect(gain); gain.connect(audio.destination);
    oscillator.start(start); oscillator.stop(start + duration);
}

function decodedInput(value = 0) {
    return {left: !!(value & 1), right: !!(value & 2), up: !!(value & 4), down: !!(value & 8), action: !!(value & 16), action2: !!(value & 32)};
}

function predictionInput() {
    const result = lastInputs.map(decodedInput);
    if (self()?.team && Number.isInteger(self().slot)) result[self().slot] = decodedInput(flags);
    return result;
}

function acceptState(state, serverTick = 0, inputs = []) {
    if (!state?.ball || !Array.isArray(state.discs)) return;
    syncPitch(state);
    const now = performance.now();
    const reset = state.ni || (lastState && state.ftu > lastState.ftu + 5);
    if (reset) {snapshots = []; smoothing.clear();}
    if (lastState && state.scores.some((score, index) => score > lastScores[index])) {
        tone(440, 0.18, 0.05);
        setTimeout(() => tone(660, 0.25, 0.04), 120);
    } else if (lastState && serverTick > tick && state.sts?.some(sound => sound.i === 'footKick' && sound.f === 10)) {
        tone(120, 0.06, 0.025);
    }
    lastScores = state.scores.slice(); lastState = state; tick = serverTick;
    snapshots.push({at: now, state});
    if (snapshots.length > 12) snapshots.shift();
    lastInputs = Array.isArray(inputs) ? inputs : [];
    lastSnapshotAt = now; lastPredictionAt = now; predictionSteps = 0;
    predicted = self()?.team && room?.status === 'playing' ? clone(state) : null;
    if (predicted) {
        const ahead = Math.min(3, Math.floor(latency / 2 / (1000 / C.TICK_RATE)));
        for (let index = 0; index < ahead; index++) {
            if (predictionStops(predicted)) break;
            predicted = physics.step(predicted, predictionInput()); predictionSteps++;
        }
    }
    setText($('scoreBlue'), state.scores[3]); setText($('scoreRed'), state.scores[2]);
    updateMatchStatus();
}

function addChat(message) {
    if (!message || seenChat.has(message.id)) return;
    seenChat.add(message.id);
    if (seenChat.size > 120) seenChat.delete(seenChat.values().next().value);
    const row = document.createElement('p'), author = document.createElement('strong');
    if (message.system) row.className = 'chat-system-message';
    author.textContent = message.system ? 'System: ' : message.name + ': ';
    row.append(author, document.createTextNode(message.text || ''));
    $('chatLog').append(row);
    while ($('chatLog').children.length > 40) $('chatLog').firstElementChild.remove();
    $('chatLog').scrollTop = $('chatLog').scrollHeight;
}

function addActivity(text) {
    const log = $('activityLog');
    if (!log || !text) return;
    const row = document.createElement('p'); row.textContent = text;
    log.append(row);
    while (log.children.length > 12) log.firstElementChild.remove();
    log.scrollTop = log.scrollHeight;
}

function renderRoster(team, target) {
    target.replaceChildren();
    for (const member of room.members.filter(member => member.team === team && (team || !member.queued))) {
        const row = document.createElement('li'), name = document.createElement('span');
        name.className = 'roster-name';
        name.textContent = member.name + (member.id === memberId ? ' (you)' : '') + (member.admin ? ' · admin' : '') + (!member.connected ? ' · reconnecting' : '');
        name.title = member.verified ? 'Verified Bonk account' : 'Guest';
        row.append(name);
        const identity = document.createElement('span'); identity.className = 'roster-identity';
        identity.textContent = member.verified ? 'Bonk' : 'Guest';
        identity.title = member.verified ? 'Verified Bonk account' : 'Guest name'; row.append(identity);
        if (team) {
            const check = document.createElement('span'); check.className = 'ready-indicator';
            check.dataset.ready = String(!!member.ready);
            check.textContent = member.ready ? '✓ Ready' : room.status === 'playing' ? 'Playing' : 'Not ready';
            row.append(check);
        }
        if (self()?.admin) {
            const actions = document.createElement('span'); actions.className = 'roster-actions';
            const select = document.createElement('select'); select.className = 'team-assignment';
            select.setAttribute('aria-label', 'Team for ' + member.name);
            for (const value of [3, 2, 0]) {
                const option = document.createElement('option'); option.value = value;
                option.textContent = teamName(value); select.append(option);
            }
            select.value = member.team; select.disabled = room.status !== 'lobby' || !isOpen();
            select.onchange = () => send({type: 'assign', memberId: member.id, team: Number(select.value)});
            actions.append(select);
            if (member.id !== memberId) {
                const remove = document.createElement('button'); remove.type = 'button';
                remove.className = 'roster-remove'; remove.textContent = 'Remove';
                remove.setAttribute('aria-label', 'Remove ' + member.name + ' from the room');
                remove.onclick = () => send({type: 'kick', memberId: member.id}); actions.append(remove);
            }
            row.append(actions);
        }
        target.append(row);
    }
    if (!target.children.length) {
        const empty = document.createElement('li'); empty.className = 'roster-empty';
        empty.textContent = team ? 'No players yet' : 'No spectators'; target.append(empty);
    }
}

function renderQueue() {
    const target = $('queueRoster'); target.replaceChildren();
    const queued = room.members.filter(member => member.queued).sort((a, b) => a.queuePosition - b.queuePosition);
    for (const member of queued) {
        const row = document.createElement('li'), name = document.createElement('span'), preference = document.createElement('span');
        name.className = 'roster-name'; preference.className = 'queue-preference';
        name.textContent = member.name + (member.id === memberId ? ' (you)' : '');
        preference.textContent = member.queueTeam ? teamName(member.queueTeam) : 'Either team';
        row.append(name, preference); target.append(row);
    }
    if (!queued.length) {
        const empty = document.createElement('li'); empty.className = 'roster-empty';
        empty.textContent = 'Nobody waiting'; target.append(empty);
    }
}

function renderGamePanels() {
    const voting = room?.status === 'voting' && !!room.vote;
    const results = room?.status === 'results' && !!room.results;
    const playing = room?.status === 'playing';
    const me = self(), eligible = !!(me?.connected && (me.team || me.queued));
    $('gameOverlay').hidden = !voting && !results;
    $('modeVotePanel').hidden = !voting;
    $('resultsPanel').hidden = !results;
    $('rebalanceNotice').hidden = !playing || !room?.rebalanceVote;
    $('rocketsHud').hidden = !playing || room?.mode !== 'rockets' || !room.rockets;
    $('votingWaiting').hidden = !voting;
    if (voting) {
        const vote = room.vote, selected = vote.votes?.[memberId];
        setText($('overlayTitle'), 'Choose the next game');
        setText($('overlayDescription'), 'Vote for balanced football or take turns in Rockets.');
        setText($('overlayCountdown'), countdown(vote.deadline) + 's left');
        setText($('balancedVoteCount'), vote.counts?.balanced || 0);
        setText($('rocketsVoteCount'), vote.counts?.rockets || 0);
        for (const button of document.querySelectorAll('[data-mode-vote]')) {
            button.disabled = !isOpen() || !eligible || countdown(vote.deadline) === 0;
            button.setAttribute('aria-pressed', String(selected === button.dataset.modeVote));
        }
        setText($('votingWaiting'), !eligible ? 'Join a team or the queue to vote. Spectators can watch.'
            : selected ? 'Your vote: ' + (selected === 'rockets' ? 'Rockets' : 'Balanced teams') + '. You can change it until voting ends.'
            : 'One vote per player. Voting closes when everyone has voted or time runs out.');
    } else if (results) {
        const result = room.results, rocketResults = result.mode === 'rockets';
        setText($('overlayTitle'), rocketResults ? 'Fastest goals' : room.winner ? teamName(room.winner) + ' wins' : 'Game complete');
        setText($('overlayDescription'), rocketResults ? 'Rockets results, ranked by ball speed as it crossed the goal.' : 'Get ready to vote for the next game.');
        setText($('overlayCountdown'), 'Next vote in ' + countdown(result.deadline) + 's');
        const scores = result.scores || [0, 0, 0, 0];
        setText($('resultsSummary'), rocketResults ? 'One turn per player, in join order. Speeds are measured in m/s.' : 'Blue ' + scores[3] + ' — ' + scores[2] + ' Red');
        $('rocketLeaderboard').hidden = !rocketResults;
        const signature = JSON.stringify(result.leaderboard || []);
        if (signature !== leaderboardSignature) {
            leaderboardSignature = signature; $('rocketLeaderboard').replaceChildren();
            for (const entry of result.leaderboard || []) {
                const row = document.createElement('li'), name = document.createElement('span'), speed = document.createElement('strong');
                row.dataset.scored = String(!!entry.scored);
                name.className = 'leaderboard-name'; speed.className = 'leaderboard-score';
                name.textContent = entry.name; speed.textContent = entry.scored && Number.isFinite(entry.speed) ? entry.speed.toFixed(1) + ' m/s' : 'No goal';
                row.append(name, speed); $('rocketLeaderboard').append(row);
            }
            if (!$('rocketLeaderboard').children.length) {
                const empty = document.createElement('li'); empty.className = 'leaderboard-empty'; empty.textContent = 'No completed goals this game.'; $('rocketLeaderboard').append(empty);
            }
        }
    }
    if (playing && room.rebalanceVote) {
        const vote = room.rebalanceVote, selected = vote.votes?.[memberId];
        setText($('rebalanceCountdown'), countdown(vote.deadline) + 's');
        setText($('rebalanceSummary'), 'A player left. Rebalance with a new kickoff, or keep playing with these teams? '
            + (vote.counts?.yes || 0) + ' yes · ' + (vote.counts?.no || 0) + ' no. A majority is required.');
        for (const [id, value] of [['rebalanceYes', true], ['rebalanceNo', false]]) {
            $(id).disabled = !isOpen() || !eligible || countdown(vote.deadline) === 0;
            $(id).setAttribute('aria-pressed', String(selected === value));
        }
    }
    if (playing && room.mode === 'rockets' && room.rockets) {
        const turn = room.rockets, attacker = room.members.find(member => member.id === turn.attackerId);
        setText($('rocketTurnName'), (attacker?.name || 'Next player') + ' · Turn ' + turn.turnIndex + '/' + turn.totalTurns);
        setText($('rocketTurnTimer'), Math.ceil(Math.max(0, turn.turnTicksLeft) / C.TICK_RATE) + 's');
    }
}

function buildSettingsFields() {
    const container = $('settingsFields');
    for (const [key, rule] of Object.entries(SETTING_RULES)) {
        const field = document.createElement('div'), title = document.createElement('span'), input = document.createElement('input');
        field.className = 'field setting-field'; title.className = 'setting-label'; title.id = 'label-' + key;
        title.textContent = rule.label; input.id = 'setting-' + key; input.name = key; input.type = 'number';
        input.min = rule.disabledValue ?? rule.min; input.max = rule.max; input.step = rule.step;
        input.value = DEFAULT_MATCH_SETTINGS[key]; input.required = true; input.setAttribute('aria-labelledby', title.id);
        field.append(title, input);
        const hint = document.createElement('small'); hint.className = 'setting-hint';
        hint.textContent = key === 'goalHeight' ? '13 by default. Use -1 to close both goals.' : rule.unit || '';
        field.append(hint); container.append(field);
    }
}

function updateSettings() {
    const signature = settingsFingerprint(room.settings);
    if (signature !== settingsSignature) {
        // An unchanged roster/chat update must not overwrite a form being edited.
        for (const key of Object.keys(SETTING_RULES)) $('setting-' + key).value = room.settings[key] ?? DEFAULT_MATCH_SETTINGS[key];
        settingsDirty = false; settingsSignature = signature;
    }
    const disabled = room.status !== 'lobby' || !isOpen() || !self()?.admin || pendingSettingsSignature !== null;
    $('matchSettingsForm').querySelectorAll('input,button').forEach(input => input.disabled = disabled);
    $('saveSettings').disabled = disabled || !settingsDirty;
    if ($('settingsStatus')) setText($('settingsStatus'), room.status !== 'lobby' ? 'Match settings are available in the lobby after voting.' : settingsDirty ? 'Unsaved changes' : 'Settings apply to the next game.');
}

function applyRoom(next) {
    if (!next) return;
    const oldStatus = room?.status, oldAttacker = room?.rockets?.attackerId; room = next;
    if (settingsFingerprint(room.settings) === pendingSettingsSignature) {settingsDirty = false; pendingSettingsSignature = null;}
    if (oldStatus !== room.status || oldAttacker !== room.rockets?.attackerId) {releaseInput(); snapshots = []; smoothing.clear(); predicted = null;}
    $('roomEntry').hidden = true; $('roomPanel').hidden = false;
    setText($('roomTitle'), room.name); setText($('roomCodeDisplay'), room.id);
    history.replaceState(null, '', location.pathname);
    renderRoster(3, $('blueRoster')); renderRoster(2, $('redRoster')); renderRoster(0, $('spectatorRoster'));
    renderQueue();
    const admin = !!self()?.admin, playing = room.status === 'playing', me = self();
    $('hostControls').hidden = !admin;
    $('adminMatchControls').hidden = !admin;
    updateSettings(); syncPitch(room.state);
    $('startMatch').hidden = room.status !== 'lobby';
    $('abortMatch').hidden = !playing;
    $('rematchMatch').hidden = room.status !== 'finished';
    const canStart = !!room.canStart;
    $('startMatch').disabled = !canStart || !isOpen(); $('rematchMatch').disabled = !canStart || !isOpen();
    setText($('modeLabel'), modeName());
    setText($('lobbyStateLabel'), room.status === 'playing' ? 'IN GAME' : room.status === 'voting' ? 'VOTING' : room.status === 'results' ? 'RESULTS' : 'LOBBY');
    for (const [id, team] of [['joinBlue', 3], ['joinRed', 2], ['spectate', 0]]) {
        $(id).disabled = !isOpen() || (team ? me?.team === team || (me?.queued && me.queueTeam === team) : !me?.team && !me?.queued);
        $(id).textContent = team ? playing ? 'Queue ' + teamName(team).toLowerCase() : 'Join ' + teamName(team).toLowerCase() : 'Spectate';
    }
    $('joinQueue').disabled = !isOpen() || !!me?.team || (!!me?.queued && !me.queueTeam);
    const readyEligible = !!(me?.connected && (me.team || (room.mode === 'rockets' && me.queued)));
    $('readyButton').disabled = !isOpen() || room.status !== 'lobby' || !readyEligible;
    $('readyButton').setAttribute('aria-pressed', String(!!me?.ready));
    setText($('readyButton'), me?.ready ? '✓ Ready — click to cancel' : 'Ready');
    const active = room.members.filter(member => member.connected && (member.team || (room.mode === 'rockets' && member.queued)));
    const waiting = active.filter(member => !member.ready).length;
    setText($('readySummary'), room.status === 'voting' ? 'Choose the next mode on the pitch, then ready up.'
        : room.status === 'results' ? 'Results are on the pitch. The next mode vote starts shortly.'
        : playing ? room.mode === 'rockets' ? (room.rockets?.participantIds?.includes(memberId) ? 'Your Rockets turn follows join order.' : 'New arrivals play in the next game.')
            : me?.queued ? 'You will join at the next kickoff with an available place.' : 'Players can vote to rebalance if someone leaves.'
        : !active.length ? 'Join the queue to play.' : waiting ? active.filter(member => member.ready).length + ' / ' + active.length + ' ready.' + (active.length === 1 ? ' You can practise solo.' : ' Everyone playing must be ready.') : 'Everyone is ready. Starting…');
    $('chatInput').disabled = !isOpen(); $('sendChat').disabled = !isOpen();
    const rosterSignature = room.members.map(member => member.id + ':' + member.team + ':' + !!member.queued).join('|');
    if (lastRoomStatus !== room.status) addActivity(room.status === 'playing' ? modeName() + ' started.'
        : room.status === 'results' ? 'Game complete. Results are on the pitch.' : room.status === 'voting' ? 'Vote for the next game on the pitch.' : 'Lobby open. Mark yourself ready to play.');
    else if (lastRosterSignature && lastRosterSignature !== rosterSignature) addActivity('Teams and the next-kickoff queue have been updated.');
    lastRoomStatus = room.status; lastRosterSignature = rosterSignature;
    for (const message of room.chat || []) addChat(message);
    if (room.state) acceptState(room.state, tick, lastInputs);
    else {
        lastState = null; predicted = null; snapshots = []; lastScores = [0, 0, 0, 0];
        setText($('scoreBlue'), 0); setText($('scoreRed'), 0);
    }
    if ((oldStatus !== room.status || oldAttacker !== room.rockets?.attackerId) && room.status === 'playing' && self()?.team
        && !document.activeElement?.matches('input,textarea,select,[contenteditable="true"]')) {
        canvas.focus({preventScroll: true});
    }
    renderGamePanels(); updateMatchStatus();
}

function updateMatchStatus() {
    let text = 'Join football to play or watch the shared game.';
    if (room) {
        const me = self();
        const role = me?.team ? 'Playing for ' + teamName(me.team) : me?.queued ? 'Queue position ' + me.queuePosition : 'Spectating';
        if (!ready) text = reconnecting ? 'Connection interrupted. Reconnecting…' : 'Connecting to room…';
        else if (room.status === 'voting') text = 'Vote for the next game on the pitch. ' + countdown(room.vote?.deadline) + 's remaining.';
        else if (room.status === 'results') text = modeName() + ' complete. Results are on the pitch.';
        else if (room.status === 'lobby') text = role + '. Ready up when you want to play.';
        else if (room.status === 'finished') text = teamName(room.winner) + ' wins. Ready up for the next game.';
        else if (lastState?.ftu >= 0) text = 'Kickoff in ' + Math.ceil(lastState.ftu / 30) + '. ' + role + '.';
        else if (lastState?.fte >= 0) text = teamName(lastState.lscr) + ' scores!';
        else if (room.mode === 'rockets' && room.rockets) {
            const attacker = room.members.find(member => member.id === room.rockets.attackerId);
            text = (attacker?.name || 'Next player') + ' is shooting. ' + Math.ceil(room.rockets.turnTicksLeft / 30) + 's left.';
        } else text = role + '. ' + (room.settings.goalHeight < 0 ? 'Goals closed — practice mode.' : 'First to ' + room.settings.scoreLimit + '.');
    }
    if (notice && performance.now() < noticeUntil) text = notice;
    if (text !== latestStatus) {latestStatus = text; setText($('matchStatus'), text);}
    renderGamePanels();
}

async function connectSession(joined) {
    const ownGeneration = ++generation;
    clearTimeout(retryTimer); retryTimer = null;
    socket?.close(1000, 'Replaced connection');
    ready = false; sequence = 0; memberId = joined.member.id;
    storeSeat(joined.room.id, joined.member);
    applyRoom(joined.room);
    const address = new URL(joined.socketPath, API);
    address.protocol = address.protocol === 'https:' ? 'wss:' : 'ws:';
    const connection = new WebSocket(address); socket = connection;
    setText($('connectionStatus'), reconnecting ? 'Reconnecting…' : 'Connecting…');
    await new Promise((resolve, reject) => {
        let settled = false;
        const timeout = setTimeout(() => {if (!settled) {settled = true; reject(Error('The room took too long to connect.')); connection.close();}}, 12000);
        connection.addEventListener('message', event => {
            if (ownGeneration !== generation || typeof event.data !== 'string') return;
            let message; try {message = JSON.parse(event.data);} catch {return;}
            if (message.type === 'welcome') {
                ready = true; leaving = false; reconnecting = false; retries = 0; memberId = message.memberId;
                applyRoom(message.room); setText($('connectionStatus'), 'Connected'); sendInput();
                if (!settled) {settled = true; clearTimeout(timeout); resolve();}
            } else if (message.type === 'room') applyRoom(message.room);
            else if (message.type === 'snapshot') {
                if (room) {
                    room.status = message.status || room.status; room.mode = message.mode || room.mode; room.winner = message.winner ?? room.winner;
                    if (Object.hasOwn(message, 'rockets')) room.rockets = message.rockets;
                    if (Object.hasOwn(message, 'rebalanceVote')) room.rebalanceVote = message.rebalanceVote;
                }
                if (Number.isFinite(message.serverTime)) serverClockOffset = message.serverTime - Date.now();
                acceptState(message.state, message.tick, message.inputs);
            } else if (message.type === 'chat') addChat(message);
            else if (message.type === 'notice') {showNotice(message.text || 'Lobby updated.'); addActivity(message.text);}
            else if (message.type === 'removed') {
                storeSeat(room?.id, null); returnToEntry(message.reason || 'You left the room.');
            }
            else if (message.type === 'pong') {
                latency = Math.max(0, Math.min(2000, performance.now() - message.sentAt));
                if (Number.isFinite(message.serverTime)) serverClockOffset = message.serverTime + latency / 2 - Date.now();
                setText($('connectionStatus'), 'Connected · ' + Math.round(latency) + ' ms');
            } else if (message.type === 'error') {
                const settingsPending = pendingSettingsSignature !== null; pendingSettingsSignature = null;
                if (room && settingsPending) {updateSettings(); setText($('settingsStatus'), message.error || 'Settings could not be saved.');}
                showNotice(message.error || 'That action could not be completed.');
            }
        });
        connection.addEventListener('close', event => {
            if (ownGeneration !== generation) return;
            clearTimeout(timeout); ready = false; predicted = null; releaseInput();
            if (room) applyRoom(room);
            if (!settled) {settled = true; reject(Error('The room connection closed. Please join again.'));}
            if (leaving) return;
            if ([1008, 4001, 4002, 4003].includes(event.code)) {
                storeSeat(room?.id, null); returnToEntry(event.reason || 'You were removed from the room.');
            } else scheduleReconnect();
        });
        connection.addEventListener('error', () => setText($('connectionStatus'), 'Connection interrupted'));
    });
}

async function join(id, resume = false) {
    const seat = resume ? savedSeat(id) : null;
    const joined = await request('/api/football/lobby', {
        displayName: $('displayName').value.trim(), ...(seat?.resumeToken ? {resumeToken: seat.resumeToken} : {})
    });
    await connectSession(joined);
}

function scheduleReconnect() {
    if (!room || leaving || retryTimer || retries >= 5) {
        if (retries >= 5) returnToEntry('Connection lost. Join the room again to continue.');
        return;
    }
    reconnecting = true; retries++;
    setText($('connectionStatus'), 'Reconnecting…'); updateMatchStatus();
    const id = room.id;
    retryTimer = setTimeout(async () => {
        retryTimer = null;
        try {await join(id, true);} catch (error) {
            if (error.status === 404 || error.status === 403) {storeSeat(id, null); returnToEntry(error.message);}
            else scheduleReconnect();
        }
    }, Math.min(5000, 500 * 2 ** retries));
}

function returnToEntry(message = '') {
    leaving = true; ready = false; reconnecting = false; generation++;
    retries = 0;
    clearTimeout(retryTimer); retryTimer = null;
    releaseInput(); socket?.close(1000, 'Left room'); socket = null;
    $('roomPanel').hidden = true; $('roomEntry').hidden = false;
    $('entryStatus').textContent = message; setText($('connectionStatus'), 'Not connected');
    room = null; memberId = null; lastState = null; predicted = null; snapshots = []; smoothing.clear();
    seenChat.clear(); $('chatLog').replaceChildren(); $('activityLog').replaceChildren();
    $('hostControls').hidden = true; $('adminMatchControls').hidden = true; $('chatInput').disabled = true; $('sendChat').disabled = true;
    lastRoomStatus = ''; lastRosterSignature = ''; settingsSignature = ''; settingsDirty = false; pendingSettingsSignature = null; leaderboardSignature = '';
    syncPitch(null); setBusy(false); renderGamePanels(); updateMatchStatus();
}

async function entryAction(action) {
    if (busy) return;
    setBusy(true); $('entryStatus').textContent = ''; warmAudio();
    try {
        try {localStorage.setItem('football-display-name', $('displayName').value.trim());} catch {}
        await action(); canvas.focus({preventScroll: true});
    } catch (error) {returnToEntry(error.message);}
    finally {setBusy(false);}
}

$('joinRoomForm').addEventListener('submit', event => {event.preventDefault(); entryAction(() => join(LOBBY_ID, true));});
$('leaveRoom').addEventListener('click', () => {send({type: 'leave'}); storeSeat(room?.id, null); returnToEntry(); history.replaceState(null, '', location.pathname);});
for (const [id, team] of [['joinBlue', 3], ['joinRed', 2], ['spectate', 0]]) $(id).addEventListener('click', () => send({type: 'team', team}));
$('joinQueue').addEventListener('click', () => send({type: 'queue', team: 0}));
$('readyButton').addEventListener('click', () => {warmAudio(); send({type: 'ready', ready: !self()?.ready});});
for (const button of document.querySelectorAll('[data-mode-vote]')) button.addEventListener('click', () => {
    releaseInput(); send({type: 'modeVote', mode: button.dataset.modeVote});
});
for (const [id, yes] of [['rebalanceYes', true], ['rebalanceNo', false]]) $(id).addEventListener('click', () => {
    releaseInput(); send({type: 'rebalanceVote', yes}); canvas.focus({preventScroll: true});
});
for (const [id, type] of [['startMatch', 'start'], ['abortMatch', 'abort'], ['rematchMatch', 'rematch']]) $(id).addEventListener('click', () => {warmAudio(); send({type}); canvas.focus({preventScroll: true});});
buildSettingsFields();
$('matchSettingsForm').addEventListener('input', () => {settingsDirty = true; if (room) updateSettings();});
$('matchSettingsForm').addEventListener('submit', event => {
    event.preventDefault();
    if (!self()?.admin || room.status !== 'lobby') return;
    const patch = Object.fromEntries(Object.keys(SETTING_RULES).map(key => [key, Number($('setting-' + key).value)]));
    const checked = validateMatchSettings(patch, room.settings);
    if (checked.error) {setText($('settingsStatus'), checked.error); return;}
    pendingSettingsSignature = settingsFingerprint(checked.settings);
    if (send({type: 'settings', settings: checked.settings})) {updateSettings(); setText($('settingsStatus'), 'Applying settings…');}
    else pendingSettingsSignature = null;
});
$('copyRoomLink').addEventListener('click', async () => {
    if (!room) return;
    const url = new URL(location.pathname, location.origin);
    try {await navigator.clipboard.writeText(url.href); showNotice('Football link copied.');} catch {
        let input = $('shareLink');
        if (!input) {input = document.createElement('input'); input.id = 'shareLink'; input.readOnly = true; input.setAttribute('aria-label', 'Football link'); $('roomPanel').prepend(input);}
        input.value = url.href; input.focus(); input.select(); showNotice('Copy the selected football link.');
    }
});
$('chatForm').addEventListener('submit', event => {
    event.preventDefault(); const text = $('chatInput').value.trim();
    if (text && send({type: 'chat', text})) {$('chatInput').value = ''; canvas.focus({preventScroll: true});}
});
$('fullscreenToggle').addEventListener('click', async () => {
    try {if (document.fullscreenElement) await document.exitFullscreen(); else await $('footballApp').requestFullscreen(); canvas.focus({preventScroll: true});}
    catch {showNotice('Fullscreen is unavailable in this browser.');}
});
document.addEventListener('fullscreenchange', () => setText($('fullscreenToggle'), document.fullscreenElement ? 'Exit fullscreen' : 'Fullscreen'));
$('muteSound').addEventListener('click', () => {muted = !muted; $('muteSound').setAttribute('aria-pressed', String(muted)); setText($('muteSound'), muted ? 'Sound off' : 'Sound on'); if (!muted) warmAudio();});
canvas.addEventListener('pointerdown', () => {canvas.focus({preventScroll: true}); warmAudio();});
window.addEventListener('keydown', event => {
    if (event.code === 'Escape') releaseInput();
    if (event.code === 'Enter' && !editable(event.target) && room) {event.preventDefault(); releaseInput(); $('chatInput').focus(); return;}
    if (event.code === 'Escape' && event.target === $('chatInput')) {releaseInput(); canvas.focus({preventScroll: true}); return;}
    if (!keys.has(event.code) || editable(event.target) || !isOpen() || !self()?.team) return;
    event.preventDefault(); held.add(event.code); updateInput(); warmAudio();
});
window.addEventListener('keyup', event => {if (held.delete(event.code)) {event.preventDefault(); updateInput();}});
window.addEventListener('blur', releaseInput);
document.addEventListener('visibilitychange', () => {if (document.hidden) releaseInput();});
document.addEventListener('focusin', event => {if (editable(event.target)) releaseInput();});
document.querySelectorAll('[data-control]').forEach(button => {
    button.addEventListener('pointerdown', event => {
        event.preventDefault(); if (!isOpen() || !self()?.team) return;
        button.setPointerCapture(event.pointerId); touches.set(event.pointerId, button.dataset.control);
        button.classList.add('is-pressed'); updateInput(); warmAudio();
    });
    const release = event => {
        touches.delete(event.pointerId);
        if (![...touches.values()].includes(button.dataset.control)) button.classList.remove('is-pressed');
        updateInput();
    };
    button.addEventListener('pointerup', release); button.addEventListener('pointercancel', release); button.addEventListener('lostpointercapture', release);
});
setInterval(sendInput, 100);
setInterval(() => send({type: 'ping', sentAt: performance.now()}), 2000);

const pitch = document.createElement('canvas');
const paint = pitch.getContext('2d');
let geometry;

function syncPitch(state) {
    const next = getPitchGeometry(state || {settings: room?.settings || DEFAULT_MATCH_SETTINGS});
    const signature = JSON.stringify(next.pixels);
    if (signature === geometrySignature) return;
    geometry = next; geometrySignature = signature;
    const g = geometry.pixels;
    pitch.width = g.width; pitch.height = g.height;
    canvas.parentElement.style.setProperty('--pitch-ratio', g.width + ' / ' + g.height);
    canvas.parentElement.style.setProperty('--pitch-ratio-value', String(g.width / g.height));
    paint.fillStyle = '#5a7f64'; paint.fillRect(0, 0, g.width, g.height);
    paint.save(); paint.beginPath(); paint.rect(g.left, g.top, g.right - g.left, g.bottom - g.top); paint.clip();
    paint.strokeStyle = 'rgba(255,255,255,.025)'; paint.lineWidth = 24;
    for (let x = -g.height; x < g.width + g.height; x += 64) {paint.beginPath(); paint.moveTo(x, g.height); paint.lineTo(x + g.height, 0); paint.stroke();}
    paint.restore(); paint.strokeStyle = 'rgba(255,255,255,.5)'; paint.lineWidth = 1;
    paint.strokeRect(g.left, g.top, g.right - g.left, g.bottom - g.top);
    paint.beginPath(); paint.moveTo(g.centerX, g.top); paint.lineTo(g.centerX, g.bottom); paint.stroke();
    paint.beginPath(); paint.arc(g.centerX, g.centerY, Math.min(50, (g.bottom - g.top) / 4), 0, Math.PI * 2); paint.stroke();
    const boxHeight = Math.min(270, g.bottom - g.top - 30), boxWidth = Math.min(55, (g.right - g.left) / 5);
    paint.strokeRect(g.left, g.centerY - boxHeight / 2, boxWidth, boxHeight);
    paint.strokeRect(g.right - boxWidth, g.centerY - boxHeight / 2, boxWidth, boxHeight);
    for (const post of g.posts) {
        paint.beginPath(); paint.arc(post.x, post.y, post.radius, 0, Math.PI * 2);
        paint.fillStyle = post.x < g.centerX ? '#448aff' : '#d32f2f'; paint.fill(); paint.stroke();
    }
    resizeCanvas();
}

function resizeCanvas() {
    const bounds = canvas.getBoundingClientRect(), ratio = Math.min(2, window.devicePixelRatio || 1);
    canvas.width = Math.max(1, Math.round(bounds.width * ratio)); canvas.height = Math.max(1, Math.round(bounds.height * ratio));
    viewport.width = bounds.width; viewport.height = bounds.height; viewport.ratio = ratio;
    const g = geometry?.pixels || {width: C.WIDTH, height: C.HEIGHT};
    viewport.scale = Math.min(bounds.width / g.width, bounds.height / g.height);
    viewport.x = (bounds.width - g.width * viewport.scale) / 2; viewport.y = (bounds.height - g.height * viewport.scale) / 2;
}
new ResizeObserver(resizeCanvas).observe(canvas);

function interpolated(now) {
    if (!snapshots.length) return lastState;
    const target = now - 80;
    let before = snapshots[0], after = snapshots[snapshots.length - 1];
    for (const snapshot of snapshots) {if (snapshot.at <= target) before = snapshot; if (snapshot.at >= target) {after = snapshot; break;}}
    const factor = Math.max(0, Math.min(1, (target - before.at) / Math.max(1, after.at - before.at)));
    const position = (a, b) => a && b ? {...b, x: a.x + (b.x - a.x) * factor, y: a.y + (b.y - a.y) * factor} : b;
    return {...after.state, ball: position(before.state.ball, after.state.ball), discs: after.state.discs.map((disc, slot) => position(before.state.discs[slot], disc))};
}

function smoothed(id, target, dt) {
    const previous = smoothing.get(id);
    if (!previous || Math.hypot(previous.x - target.x, previous.y - target.y) > 5) {smoothing.set(id, {...target}); return target;}
    const blend = 1 - Math.exp(-dt * 28);
    const current = {...target, x: previous.x + (target.x - previous.x) * blend, y: previous.y + (target.y - previous.y) * blend};
    smoothing.set(id, current); return current;
}

function draw(now) {
    const dt = Math.min(0.05, (now - lastFrameAt) / 1000); lastFrameAt = now;
    if (predicted && room?.status === 'playing' && isOpen() && now - lastSnapshotAt < 500) {
        let steps = 0;
        while (now - lastPredictionAt >= 1000 / C.TICK_RATE && predictionSteps < 7 && steps++ < 3) {
            if (predictionStops(predicted)) break;
            predicted = physics.step(predicted, predictionInput()); lastPredictionAt += 1000 / C.TICK_RATE; predictionSteps++;
        }
    }
    context.setTransform(viewport.ratio, 0, 0, viewport.ratio, 0, 0);
    context.fillStyle = '#5a7f64'; context.fillRect(0, 0, viewport.width, viewport.height);
    context.translate(viewport.x, viewport.y); context.scale(viewport.scale, viewport.scale);
    context.drawImage(pitch, 0, 0);
    const g = geometry.pixels;
    const display = interpolated(now), authoritative = lastState;
    const scores = authoritative?.scores || [0, 0, 0, 0];
    context.fillStyle = '#ffffff'; context.textBaseline = 'middle';
    context.shadowColor = 'rgba(0,0,0,.35)'; context.shadowBlur = 4; context.shadowOffsetY = 2;
    context.font = '40px "Trebuchet MS", sans-serif'; context.textAlign = 'right'; context.fillText(scores[3], g.centerX - 7, 30);
    context.textAlign = 'left'; context.fillText(scores[2], g.centerX + 9, 30);
    context.font = '17px "Trebuchet MS", sans-serif'; context.textAlign = 'right'; context.fillText('Blue', g.centerX - 8, 55);
    context.textAlign = 'left'; context.fillText('Red', g.centerX + 10, 55); context.shadowBlur = 0; context.shadowOffsetY = 0;
    if (display) {
        const ownSlot = self()?.slot;
        display.discs.forEach((source, slot) => {
            if (!source) return;
            const disc = predicted?.discs[slot] && slot === ownSlot ? smoothed('self', predicted.discs[slot], dt) : source;
            const x = disc.x * geometry.ppm, y = disc.y * geometry.ppm, blue = disc.team === 3;
            context.beginPath(); context.arc(x, y, g.playerRadius, 0, Math.PI * 2);
            context.fillStyle = blue ? '#2d69b2' : '#ad3636'; context.fill();
            const action = slot === ownSlot ? flags & 16 : (lastInputs[slot] || 0) & 16;
            context.strokeStyle = action ? '#ffffff' : blue ? '#448aff' : '#d32f2f'; context.lineWidth = 2.5; context.stroke();
            const member = room?.members.find(member => member.slot === slot);
            context.fillStyle = '#ffffff'; context.font = 'bold 9px Arial, sans-serif'; context.textAlign = 'center';
            context.fillText(Array.from(member?.name || '?')[0].toUpperCase(), x, y + 0.5);
            context.font = '9px Arial, sans-serif'; context.fillStyle = 'rgba(255,255,255,.9)';
            context.fillText(member?.name || authoritative.players[slot]?.name || 'Player', x, y + g.playerRadius + 11, 105);
            if (slot === ownSlot) {context.beginPath(); context.moveTo(x - 3, y + g.playerRadius + 18); context.lineTo(x + 3, y + g.playerRadius + 18); context.lineTo(x, y + g.playerRadius + 14); context.closePath(); context.fill();}
        });
        const ball = predicted?.ball && self()?.team ? smoothed('ball', predicted.ball, dt) : display.ball;
        context.beginPath(); context.arc(ball.x * geometry.ppm, ball.y * geometry.ppm, g.ballRadius, 0, Math.PI * 2);
        context.fillStyle = '#ffffff'; context.fill();
    }
    let banner = '', caption = '';
    if (!room) {banner = 'FOOTBALL'; caption = 'One pitch. Join the lobby and play.';}
    else if (!ready) {banner = reconnecting ? 'RECONNECTING' : 'CONNECTING'; caption = 'Waiting for the room…';}
    else if (room.status === 'voting' || room.status === 'results') {banner = ''; caption = '';}
    else if (room.status === 'lobby') {banner = 'LOBBY'; caption = 'Join a team. Ready up to start.';}
    else if (room.status === 'finished') {banner = teamName(room.winner).toUpperCase() + ' TEAM WINS'; caption = 'Ready up for the next game.';}
    else if (authoritative?.ftu >= 0) {banner = String(Math.ceil(authoritative.ftu / 30)); caption = 'ROUND STARTS IN';}
    else if (authoritative?.fte >= 0) {banner = teamName(authoritative.lscr).toUpperCase() + ' TEAM SCORES'; caption = 'Next kickoff shortly';}
    if (banner) {
        context.fillStyle = '#ffffff'; context.textAlign = 'center'; context.shadowColor = 'rgba(0,0,0,.35)'; context.shadowBlur = 6;
        context.font = /^\d+$/.test(banner) ? '72px "Trebuchet MS", sans-serif' : 'bold 28px "Trebuchet MS", sans-serif';
        context.fillText(banner, g.centerX, g.centerY - 13, g.width - 100); context.font = '14px "Trebuchet MS", sans-serif'; context.fillText(caption, g.centerX, g.centerY + 31, g.width - 100);
        context.shadowBlur = 0;
    }
    updateMatchStatus(); requestAnimationFrame(draw);
}
syncPitch(null); resizeCanvas(); requestAnimationFrame(draw);

if (!$('displayName').value.trim()) {
    try {$('displayName').value = localStorage.getItem('football-display-name') || 'Guest ' + Math.floor(Math.random() * 1000);} catch {$('displayName').value = 'Guest';}
}
setBusy(false);
$('chatInput').disabled = true; $('sendChat').disabled = true;
setText($('connectionStatus'), 'Not connected');
$('footballApp').dataset.ready = 'true';
(async () => {
    try {
        const session = await request('/api/session');
        if (session.user) {account = session.user; $('displayName').value = account.username; $('displayName').readOnly = true; $('displayName').title = 'Using your verified Bonk account';}
    } catch {}
    if (savedSeat(LOBBY_ID)?.resumeToken) {
        try {
            await entryAction(() => join(LOBBY_ID, true));
        } catch (error) {$('entryStatus').textContent = error.message;}
    }
})();
