import {FootballPhysics, FOOTBALL_CONSTANTS as C} from './physics.js';

const $ = id => document.getElementById(id);
const canvas = $('footballCanvas');
const context = canvas.getContext('2d');
const API = (window.APP_CONFIG?.API_URL || '').replace(/\/$/, '');
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
const smoothing = new Map();
const seenChat = new Set();
const viewport = {width: 730, height: 500, scale: 1, x: 0, y: 0, ratio: 1};
const teamName = team => team === 3 ? 'Blue' : team === 2 ? 'Red' : 'Spectators';
const self = () => room?.members.find(member => member.id === memberId);
const isOpen = () => ready && socket?.readyState === WebSocket.OPEN;
const editable = target => target?.closest?.('input,textarea,select,button,summary,[contenteditable="true"]');
const clone = value => JSON.parse(JSON.stringify(value));

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
    const response = await fetch(API + path, {
        method: body ? 'POST' : 'GET', credentials: 'include',
        headers: {'Content-Type': 'application/json', ...(token ? {'X-Account-Session': token} : {})},
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

function roomIdFrom(value) {
    let id = String(value || '').trim();
    if (/^https?:\/\//i.test(id)) {
        try {id = new URL(id).searchParams.get('room') || '';} catch {id = '';}
    }
    if (!/^[A-Za-z0-9_-]{16}$/.test(id)) throw Error('Paste a room code or a football room link. Room codes are case-sensitive.');
    return id;
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
            if (predicted.fte === 0 && predicted.scores.some(score => score >= room.settings.scoreLimit)) break;
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
    author.textContent = message.name + ': ';
    row.append(author, document.createTextNode(message.text || ''));
    $('chatLog').append(row);
    while ($('chatLog').children.length > 40) $('chatLog').firstElementChild.remove();
    $('chatLog').scrollTop = $('chatLog').scrollHeight;
}

function renderRoster(team, target) {
    target.replaceChildren();
    for (const member of room.members.filter(member => member.team === team)) {
        const row = document.createElement('li'), name = document.createElement('span');
        name.className = 'roster-name';
        name.textContent = member.name + (member.id === memberId ? ' (you)' : '') + (member.host ? ' · host' : '') + (!member.connected ? ' · reconnecting' : '');
        name.title = member.verified ? 'Verified Bonk account' : 'Guest';
        row.append(name);
        const identity = document.createElement('span'); identity.className = 'roster-identity';
        identity.textContent = member.verified ? 'Bonk' : 'Guest';
        identity.title = member.verified ? 'Verified Bonk account' : 'Guest name'; row.append(identity);
        if (self()?.host) {
            const actions = document.createElement('span'); actions.className = 'roster-actions';
            const select = document.createElement('select'); select.className = 'team-assignment';
            select.setAttribute('aria-label', 'Team for ' + member.name);
            for (const value of [3, 2, 0]) {
                const option = document.createElement('option'); option.value = value;
                option.textContent = teamName(value); select.append(option);
            }
            select.value = member.team; select.disabled = room.status === 'playing' || !isOpen();
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

function applyRoom(next) {
    if (!next) return;
    const oldStatus = room?.status; room = next;
    if (oldStatus !== room.status) {releaseInput(); snapshots = []; smoothing.clear(); predicted = null;}
    $('roomEntry').hidden = true; $('roomPanel').hidden = false;
    setText($('roomTitle'), room.name); setText($('roomCodeDisplay'), room.id);
    $('roomCode').value = room.id;
    const url = new URL(location.href); url.search = ''; url.searchParams.set('room', room.id);
    history.replaceState(null, '', url);
    renderRoster(3, $('blueRoster')); renderRoster(2, $('redRoster')); renderRoster(0, $('spectatorRoster'));
    const host = !!self()?.host, playing = room.status === 'playing';
    $('hostControls').hidden = !host;
    $('roundsToWin').value = room.settings.scoreLimit;
    $('roundsToWin').disabled = playing || !isOpen();
    $('startMatch').hidden = room.status !== 'lobby';
    $('abortMatch').hidden = !playing;
    $('rematchMatch').hidden = room.status !== 'finished';
    const both = [2, 3].every(team => room.members.some(member => member.team === team && member.connected));
    $('startMatch').disabled = !both || !isOpen(); $('rematchMatch').disabled = !both || !isOpen();
    for (const [id, team] of [['joinBlue', 3], ['joinRed', 2], ['spectate', 0]]) {
        $(id).disabled = !isOpen() || playing || self()?.team === team
            || (team && room.members.filter(member => member.team === team).length >= room.settings.maxPerTeam);
    }
    for (const message of room.chat || []) addChat(message);
    if (room.state) acceptState(room.state, tick, lastInputs);
    else {
        lastState = null; predicted = null; snapshots = []; lastScores = [0, 0, 0, 0];
        setText($('scoreBlue'), 0); setText($('scoreRed'), 0);
    }
    if (oldStatus !== room.status && room.status === 'playing' && self()?.team
        && !document.activeElement?.matches('input,textarea,select,[contenteditable="true"]')) {
        canvas.focus({preventScroll: true});
    }
    updateMatchStatus();
}

function updateMatchStatus() {
    let text = 'Create a room or join a friend to play.';
    if (room) {
        const role = self()?.team ? 'Playing for ' + teamName(self().team) : 'Spectating';
        if (!ready) text = reconnecting ? 'Connection interrupted. Reconnecting…' : 'Connecting to room…';
        else if (room.status === 'lobby') text = role + '. ' + (self()?.host ? 'Put players on both teams, then start.' : 'Waiting for the host to start.');
        else if (room.status === 'finished') text = teamName(room.winner) + ' wins. Waiting for a rematch.';
        else if (lastState?.ftu >= 0) text = 'Kickoff in ' + Math.ceil(lastState.ftu / 30) + '. ' + role + '.';
        else if (lastState?.fte >= 0) text = teamName(lastState.lscr) + ' scores!';
        else text = role + '. First to ' + room.settings.scoreLimit + '.';
    }
    if (notice && performance.now() < noticeUntil) text = notice;
    if (text !== latestStatus) {latestStatus = text; setText($('matchStatus'), text);}
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
                if (room) {room.status = message.status || room.status; room.winner = message.winner ?? room.winner;}
                acceptState(message.state, message.tick, message.inputs);
            } else if (message.type === 'chat') addChat(message);
            else if (message.type === 'notice') showNotice(message.text || 'Room updated.');
            else if (message.type === 'removed') {
                storeSeat(room?.id, null); returnToEntry(message.reason || 'You left the room.');
            }
            else if (message.type === 'pong') {
                latency = Math.max(0, Math.min(2000, performance.now() - message.sentAt));
                setText($('connectionStatus'), 'Connected · ' + Math.round(latency) + ' ms');
            } else if (message.type === 'error') showNotice(message.error || 'That action could not be completed.');
        });
        connection.addEventListener('close', event => {
            if (ownGeneration !== generation) return;
            clearTimeout(timeout); ready = false; predicted = null; releaseInput();
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
    const joined = await request('/api/football/rooms/' + encodeURIComponent(id) + '/join', {
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
    seenChat.clear(); $('chatLog').replaceChildren(); setBusy(false); updateMatchStatus();
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

$('createRoomForm').addEventListener('submit', event => {
    event.preventDefault(); entryAction(async () => {
        const joined = await request('/api/football/rooms', {name: $('roomName').value.trim(), displayName: $('displayName').value.trim()});
        await connectSession(joined);
    });
});
$('joinRoomForm').addEventListener('submit', event => {event.preventDefault(); entryAction(() => join(roomIdFrom($('roomCode').value), true));});
$('leaveRoom').addEventListener('click', () => {send({type: 'leave'}); storeSeat(room?.id, null); returnToEntry(); history.replaceState(null, '', location.pathname);});
for (const [id, team] of [['joinBlue', 3], ['joinRed', 2], ['spectate', 0]]) $(id).addEventListener('click', () => send({type: 'team', team}));
for (const [id, type] of [['startMatch', 'start'], ['abortMatch', 'abort'], ['rematchMatch', 'rematch']]) $(id).addEventListener('click', () => {warmAudio(); send({type}); canvas.focus({preventScroll: true});});
$('roundsToWin').addEventListener('change', event => send({type: 'settings', scoreLimit: Number(event.target.value)}));
$('copyRoomLink').addEventListener('click', async () => {
    if (!room) return;
    const url = new URL(location.pathname, location.origin); url.searchParams.set('room', room.id);
    try {await navigator.clipboard.writeText(url.href); showNotice('Room link copied.');} catch {
        $('roomCode').value = url.href; $('roomEntry').hidden = false; $('roomCode').focus(); $('roomCode').select();
        showNotice('Copy the selected room link.');
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

const pitch = document.createElement('canvas'); pitch.width = C.WIDTH; pitch.height = C.HEIGHT;
const paint = pitch.getContext('2d');
paint.fillStyle = '#5a7f64'; paint.fillRect(0, 0, 730, 500);
paint.save(); paint.beginPath(); paint.rect(30, 75, 670, 350); paint.clip();
paint.strokeStyle = 'rgba(255,255,255,.025)'; paint.lineWidth = 24;
for (let x = -500; x < 1250; x += 64) {paint.beginPath(); paint.moveTo(x, 500); paint.lineTo(x + 500, 0); paint.stroke();}
paint.restore(); paint.strokeStyle = 'rgba(255,255,255,.5)'; paint.lineWidth = 1;
paint.strokeRect(30, 75, 670, 350); paint.beginPath(); paint.moveTo(365, 75); paint.lineTo(365, 425); paint.stroke();
paint.beginPath(); paint.arc(365, 250, 50, 0, Math.PI * 2); paint.stroke();
paint.strokeRect(30, 115, 55, 270); paint.strokeRect(645, 115, 55, 270);
for (const [x, colour] of [[30, '#448aff'], [700, '#d32f2f']]) for (const y of [178.5, 321.5]) {
    paint.beginPath(); paint.arc(x, y, 8, 0, Math.PI * 2); paint.fillStyle = colour; paint.fill(); paint.stroke();
}

function resizeCanvas() {
    const bounds = canvas.getBoundingClientRect(), ratio = Math.min(2, window.devicePixelRatio || 1);
    canvas.width = Math.max(1, Math.round(bounds.width * ratio)); canvas.height = Math.max(1, Math.round(bounds.height * ratio));
    viewport.width = bounds.width; viewport.height = bounds.height; viewport.ratio = ratio;
    viewport.scale = Math.min(bounds.width / C.WIDTH, bounds.height / C.HEIGHT);
    viewport.x = (bounds.width - C.WIDTH * viewport.scale) / 2; viewport.y = (bounds.height - C.HEIGHT * viewport.scale) / 2;
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
            if (predicted.fte === 0 && predicted.scores.some(score => score >= room.settings.scoreLimit)) break;
            predicted = physics.step(predicted, predictionInput()); lastPredictionAt += 1000 / C.TICK_RATE; predictionSteps++;
        }
    }
    context.setTransform(viewport.ratio, 0, 0, viewport.ratio, 0, 0);
    context.fillStyle = '#5a7f64'; context.fillRect(0, 0, viewport.width, viewport.height);
    context.translate(viewport.x, viewport.y); context.scale(viewport.scale, viewport.scale);
    context.drawImage(pitch, 0, 0);
    const display = interpolated(now), authoritative = lastState;
    const scores = authoritative?.scores || [0, 0, 0, 0];
    context.fillStyle = '#ffffff'; context.textBaseline = 'middle';
    context.shadowColor = 'rgba(0,0,0,.35)'; context.shadowBlur = 4; context.shadowOffsetY = 2;
    context.font = '40px "Trebuchet MS", sans-serif'; context.textAlign = 'right'; context.fillText(scores[3], 358, 30);
    context.textAlign = 'left'; context.fillText(scores[2], 374, 30);
    context.font = '17px "Trebuchet MS", sans-serif'; context.textAlign = 'right'; context.fillText('Blue', 357, 55);
    context.textAlign = 'left'; context.fillText('Red', 375, 55); context.shadowBlur = 0; context.shadowOffsetY = 0;
    if (display) {
        const ownSlot = self()?.slot;
        display.discs.forEach((source, slot) => {
            if (!source) return;
            const disc = predicted?.discs[slot] && slot === ownSlot ? smoothed('self', predicted.discs[slot], dt) : source;
            const x = disc.x * C.PPM, y = disc.y * C.PPM, blue = disc.team === 3;
            context.beginPath(); context.arc(x, y, 11, 0, Math.PI * 2);
            context.fillStyle = blue ? '#2d69b2' : '#ad3636'; context.fill();
            const action = slot === ownSlot ? flags & 16 : (lastInputs[slot] || 0) & 16;
            context.strokeStyle = action ? '#ffffff' : blue ? '#448aff' : '#d32f2f'; context.lineWidth = 2.5; context.stroke();
            const member = room?.members.find(member => member.slot === slot);
            context.fillStyle = '#ffffff'; context.font = 'bold 9px Arial, sans-serif'; context.textAlign = 'center';
            context.fillText(Array.from(member?.name || '?')[0].toUpperCase(), x, y + 0.5);
            context.font = '9px Arial, sans-serif'; context.fillStyle = 'rgba(255,255,255,.9)';
            context.fillText(member?.name || authoritative.players[slot]?.name || 'Player', x, y + 22, 105);
            if (slot === ownSlot) {context.beginPath(); context.moveTo(x - 3, y + 29); context.lineTo(x + 3, y + 29); context.lineTo(x, y + 25); context.closePath(); context.fill();}
        });
        const ball = predicted?.ball && self()?.team ? smoothed('ball', predicted.ball, dt) : display.ball;
        context.beginPath(); context.arc(ball.x * C.PPM, ball.y * C.PPM, 7.7, 0, Math.PI * 2);
        context.fillStyle = '#ffffff'; context.fill();
    }
    let banner = '', caption = '';
    if (!room) {banner = 'FOOTBALL'; caption = 'Create a room and share the link with a friend.';}
    else if (!ready) {banner = reconnecting ? 'RECONNECTING' : 'CONNECTING'; caption = 'Waiting for the room…';}
    else if (room.status === 'lobby') {banner = 'WAITING FOR PLAYERS'; caption = 'Blue attacks right. Red attacks left.';}
    else if (room.status === 'finished') {banner = teamName(room.winner).toUpperCase() + ' TEAM WINS'; caption = 'First to ' + room.settings.scoreLimit;}
    else if (authoritative?.ftu >= 0) {banner = String(Math.ceil(authoritative.ftu / 30)); caption = 'ROUND STARTS IN';}
    else if (authoritative?.fte >= 0) {banner = teamName(authoritative.lscr).toUpperCase() + ' TEAM SCORES'; caption = 'Next kickoff shortly';}
    if (banner) {
        context.fillStyle = '#ffffff'; context.textAlign = 'center'; context.shadowColor = 'rgba(0,0,0,.35)'; context.shadowBlur = 6;
        context.font = /^\d+$/.test(banner) ? '72px "Trebuchet MS", sans-serif' : 'bold 28px "Trebuchet MS", sans-serif';
        context.fillText(banner, 365, 237, 600); context.font = '14px "Trebuchet MS", sans-serif'; context.fillText(caption, 365, 281, 600);
        context.shadowBlur = 0;
    }
    updateMatchStatus(); requestAnimationFrame(draw);
}
resizeCanvas(); requestAnimationFrame(draw);

try {$('displayName').value = localStorage.getItem('football-display-name') || 'Guest ' + Math.floor(Math.random() * 1000);} catch {$('displayName').value = 'Guest';}
const initialRoom = new URL(location.href).searchParams.get('room');
if (initialRoom) $('roomCode').value = initialRoom;
(async () => {
    try {
        const session = await request('/api/session');
        if (session.user) {account = session.user; $('displayName').value = account.username; $('displayName').readOnly = true; $('displayName').title = 'Using your verified Bonk account';}
    } catch {}
    if (initialRoom) {
        try {
            const id = roomIdFrom(initialRoom);
            if (savedSeat(id)?.resumeToken) await entryAction(() => join(id, true));
            else {
                const data = await request('/api/football/rooms/' + id);
                $('entryStatus').textContent = 'Join ' + (data.room?.name || data.name || 'this room') + ' using the form below.';
            }
        } catch (error) {$('entryStatus').textContent = error.message;}
    }
})();
