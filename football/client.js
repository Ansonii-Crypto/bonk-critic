import {FootballPhysics, FOOTBALL_CONSTANTS as C, getPitchGeometry} from './physics.js?v=20261127-football-15';
import {DEFAULT_MATCH_SETTINGS, SETTING_RULES, validateMatchSettings, goalHeightLimit} from './settings.js?v=20261127-football-13';
import {FOOTBALL_MODES, ballSpeed} from './modes.js?v=20261127-football-14';
import {maskProfanity} from './chat-filter.js?v=20261127-football-6';
import {DEFAULT_KEYBINDS, BINDING_ACTIONS, validateKeybinds, canonicalBindingCode} from './keybinds.js?v=20261127-football-6';
import {initFootballAccount} from './account-menu.js?v=20261127-football-11';
import {FootballWatcher} from './watcher.js?v=20261127-football-8';
import {FootballPredictor} from './prediction.js?v=20261127-football-15';

const $ = id => document.getElementById(id);
const canvas = $('footballCanvas');
const context = canvas.getContext('2d');
const API = (window.APP_CONFIG?.API_URL || '').replace(/\/$/, '');
const LOBBY_ID = 'footballdivision';
const controls = {left: 1, right: 2, up: 4, down: 8, action: 16};
const gameplayActions = BINDING_ACTIONS.filter(action => action !== 'action2');
const keys = new Map();
const held = new Set();
const touches = new Map();
const physics = new FootballPhysics();
const predictor = new FootballPredictor({physics});
let room = null, memberId = null, socket = null, ready = false, sequence = 0;
let flags = 0, busy = false, leaving = false, generation = 0, retries = 0, retryTimer;
let lastState = null, predicted = null, snapshots = [], lastInputs = [];
let lastSnapshotAt = 0, tick = 0;
let latency = 0, audio = null, muted = false;
let notice = '', noticeUntil = 0, latestStatus = '', lastScores = [0, 0, 0, 0];
let account = null, reconnecting = false;
let settingsDirty = false, settingsSignature = '', pendingSettingsSignature = null, geometrySignature = '';
let leaderboardSignature = '', serverClockOffset = 0;
let sentViewportAspect = null;
let gameUiHidden = false, chatEnterHeld = false, joinAfterLogin = false, selectedPreference = 0, accountLoaded = false;
let restoreTouch = null;
let settingsDrawerOpen = false, toolbarHideTimer = null, pointerInToolbarCorner = false;
let activeBindings = copyBindings(DEFAULT_KEYBINDS), draftBindings = copyBindings(DEFAULT_KEYBINDS), capturingKey = null;
const bindingLabels = {left: 'Left', right: 'Right', up: 'Up', down: 'Down', action: 'Kick'};
const chatMessages = [];
const seenChat = new Set();
const viewport = {width: 730, height: 500, scale: 1, x: 0, y: 0, ratio: 1};
const teamName = team => team === 3 ? 'Blue' : team === 2 ? 'Red' : 'Spectators';
const self = () => room?.members.find(member => member.id === memberId);
const isOpen = () => ready && socket?.readyState === WebSocket.OPEN;
const movementPhase = () => room?.status === 'playing';
const editable = target => target?.closest?.('input,textarea,select,button,summary,[contenteditable="true"]');
const gameInputBlocked = target => target?.closest?.('input,textarea,select,[contenteditable="true"],[role="menu"],[role="menubar"],.user-account-menu[open]') || !!document.querySelector('dialog[open]');
const settingsFingerprint = settings => JSON.stringify(Object.keys(SETTING_RULES).map(key => settings[key] ?? DEFAULT_MATCH_SETTINGS[key]));
const countdown = deadline => Math.max(0, Math.ceil((Number(deadline || 0) - Date.now() - serverClockOffset) / 1000));
const modeName = () => room?.mode === 'rockets' ? FOOTBALL_MODES.rockets.label : 'Balanced teams';

function copyBindings(value) {
    return Object.fromEntries(BINDING_ACTIONS.map(action => [action, [...(value[action] || [])]]));
}

function keyLabel(code) {
    if (!code) return '—';
    return ({ArrowLeft: '←', ArrowRight: '→', ArrowUp: '↑', ArrowDown: '↓', ShiftLeft: 'Shift', ControlLeft: 'Ctrl', AltLeft: 'Alt', Space: 'Space'})[code]
        || code.replace(/^Key/, '').replace(/^Digit/, '').replace(/^Numpad/, 'Num ');
}

function bindingStorageKey() {
    return 'football-keybinds:' + (account?.id || 'guest');
}

function applyBindings(value) {
    // Keep the provider's legacy shape readable, but football has no brake.
    const checked = validateKeybinds({...value, action2: []});
    if (checked.error) return false;
    releaseInput(); activeBindings = copyBindings(checked.bindings); keys.clear();
    for (const action of gameplayActions) for (const code of activeBindings[action]) keys.set(code, controls[action]);
    for (const [id, actions] of [['moveKeyHelp', ['left', 'up', 'down', 'right']], ['kickKeyHelp', ['action']]]) {
        const node = $(id); if (!node) continue;
        const labels = [...new Set(actions.flatMap(action => activeBindings[action]))].map(keyLabel);
        node.textContent = labels.length ? labels.join(' · ') : 'Unbound';
    }
    return true;
}

function renderBindingFields() {
    const container = $('keybindFields'); container.replaceChildren();
    for (const action of gameplayActions) {
        const row = document.createElement('div'), label = document.createElement('strong');
        row.className = 'keybind-row'; label.textContent = bindingLabels[action]; row.append(label);
        for (let slot = 0; slot < 3; slot++) {
            const button = document.createElement('button'); button.type = 'button'; button.className = 'button-secondary';
            button.dataset.bindingAction = action; button.dataset.bindingSlot = slot;
            button.setAttribute('aria-label', bindingLabels[action] + ' key ' + (slot + 1));
            const capturing = capturingKey?.action === action && capturingKey?.slot === slot;
            button.setAttribute('aria-pressed', String(capturing));
            button.textContent = capturing ? 'Press key…' : keyLabel(draftBindings[action][slot]);
            button.onclick = () => {
                releaseInput(); capturingKey = {action, slot}; renderBindingFields();
                container.querySelector(`[data-binding-action="${action}"][data-binding-slot="${slot}"]`)?.focus();
                setText($('keybindStatus'), 'Press a key for ' + bindingLabels[action].toLowerCase() + '. Backspace clears; Escape cancels.');
            };
            row.append(button);
        }
        container.append(row);
    }
}

function loadAccountPreferences(user) {
    const provider = user?.football_controls, providerBindings = provider?.bindings;
    let saved = null;
    try {saved = JSON.parse(localStorage.getItem(bindingStorageKey()) || 'null');} catch {}
    const validSaved = saved && !validateKeybinds({...saved, action2: []}).error;
    const validProvider = providerBindings && !validateKeybinds({...providerBindings, action2: []}).error;
    applyBindings(validSaved ? saved : validProvider ? providerBindings : DEFAULT_KEYBINDS);
    draftBindings = copyBindings(activeBindings); capturingKey = null; renderBindingFields();
    setText($('keybindStatus'), validSaved ? 'Using your saved football controls for this browser.'
        : validProvider ? 'Using the controls saved on your Bonk account.'
        : user ? 'Sign in again to import your Bonk controls, or set your keys here.' : 'Default controls. Sign in to load your Bonk account controls.');
    let filter = typeof provider?.filterProfanity === 'boolean' ? provider.filterProfanity : true;
    try {const savedFilter = localStorage.getItem('football-profanity-filter'); if (savedFilter !== null) filter = savedFilter === 'true';} catch {}
    $('filterProfanity').checked = filter; renderChat();
    try {selectedPreference = Number(localStorage.getItem('football-preferred-team:' + (user?.id || 'viewer')) || 0);} catch {selectedPreference = 0;}
    if (![0, 2, 3].includes(selectedPreference)) selectedPreference = 0;
}

function setGameUiHidden(hidden) {
    gameUiHidden = hidden; restoreTouch = null;
    if (capturingKey) {capturingKey = null; renderBindingFields();}
    $('pitchWrap').classList.toggle('hide-game-ui', hidden);
    clearTimeout(toolbarHideTimer); pointerInToolbarCorner = false; $('pitchWrap').classList.remove('reveal-hidden-toolbar');
    if (hidden) setSettingsDrawer(false);
    for (const id of ['toggleGameUi', 'toggleFullscreenUi']) {
        const button = $(id); if (!button) continue;
        setText(button, hidden ? 'Show game UI' : 'Hide game UI');
        button.setAttribute('aria-pressed', String(hidden));
        button.title = hidden ? 'Hover the top-right corner to reveal controls. Escape or double-tap also restores the UI.' : 'Hide overlays inside the pitch. Side panels remain visible.';
    }
    releaseInput();
    if (hidden) canvas.focus({preventScroll: true});
    else requestAnimationFrame(renderChat);
}

function syncSidebarPresentation() {
    const fullscreen = document.fullscreenElement === $('pitchWrap'), admin = !!self()?.admin;
    const chatParent = fullscreen ? $('pitchWrap') : $('chatDock');
    if ($('footballChat').parentElement !== chatParent) chatParent.append($('footballChat'));
    const settingsParent = fullscreen ? $('pitchWrap') : $('settingsDock');
    if ($('hostControls').parentElement !== settingsParent) settingsParent.append($('hostControls'));
    if (!fullscreen || !admin) settingsDrawerOpen = false;
    $('settingsEmpty').hidden = admin;
    $('chatEmpty').hidden = !!memberId;
    $('hostControls').hidden = !admin;
    $('fullscreenSettingsToggle').hidden = !fullscreen || !admin;
    $('fullscreenSettingsToggle').setAttribute('aria-expanded', String(settingsDrawerOpen));
    $('fullscreenSettingsToggle').setAttribute('aria-label', settingsDrawerOpen ? 'Close pitch settings' : 'Open pitch settings');
    setText($('fullscreenSettingsToggle').querySelector('span'), settingsDrawerOpen ? '\u203a' : '\u2039');
    $('pitchWrap').classList.toggle('settings-drawer-open', fullscreen && admin && settingsDrawerOpen);
}

function setSettingsDrawer(open) {
    settingsDrawerOpen = !!open && document.fullscreenElement === $('pitchWrap') && !!self()?.admin;
    if (settingsDrawerOpen) {$('hostControls').open = true; releaseInput();}
    syncSidebarPresentation();
}

function revealHiddenToolbar() {
    if (!gameUiHidden) return;
    clearTimeout(toolbarHideTimer); $('pitchWrap').classList.add('reveal-hidden-toolbar');
}

function scheduleToolbarHide(delay = 250) {
    clearTimeout(toolbarHideTimer);
    toolbarHideTimer = setTimeout(() => {
        if (pointerInToolbarCorner || $('fieldToolbar').matches(':hover,:focus-within')) return;
        $('pitchWrap').classList.remove('reveal-hidden-toolbar');
    }, delay);
}

function setText(node, text) {
    if (node && node.textContent !== String(text)) node.textContent = String(text);
    if (node?.id === 'connectionStatus') node.dataset.state = /^(Connected|Watching)/.test(String(text)) ? 'connected' : 'error';
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
    const inputFlags = movementPhase() && self()?.team ? flags : 0, seq = ++sequence, at = performance.now();
    if (send({type: 'input', seq, flags: inputFlags})) predictor.recordInput(seq, inputFlags, at);
}

function syncViewport() {
    const bounds = canvas.getBoundingClientRect();
    if (!bounds.width || !bounds.height) return;
    const aspect = Math.max(.125, Math.min(8, Math.round(bounds.width / bounds.height * 10000) / 10000));
    predictor.setViewportAspect(aspect);
    if (isOpen() && aspect !== sentViewportAspect && send({type: 'viewport', aspect})) sentViewportAspect = aspect;
}

function updateInput() {
    let next = 0;
    for (const key of held) next |= keys.get(canonicalBindingCode(key)) || 0;
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

function acceptState(state, serverTick = 0, inputs = [], ackSeq) {
    if (!state?.ball || !Array.isArray(state.discs)) return;
    const geometryChanged = syncPitch(state);
    const now = performance.now();
    const reset = geometryChanged || state.ni || (lastState && state.ftu > lastState.ftu + 5);
    if (geometryChanged) {predictor.reset(); predicted = null;}
    if (reset) snapshots = [];
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
    lastSnapshotAt = now;
    predicted = self()?.team && movementPhase() ? predictor.acceptSnapshot({state, tick: serverTick, inputs: lastInputs, ackSeq}, {
        now, rtt: latency, slot: self().slot,
        phaseKey: [room.status, room.rockets?.attackerId || '', self().team].join(':'),
    }) : null;
    setText($('scoreBlue'), state.scores[3]); setText($('scoreRed'), state.scores[2]);
    updateMatchStatus();
}

function acceptSnapshot(message) {
    if (room) {
        room.status = message.status || room.status; room.mode = message.mode || room.mode; room.winner = message.winner ?? room.winner;
        if (Object.hasOwn(message, 'rockets')) room.rockets = message.rockets;
        if (Object.hasOwn(message, 'rebalanceVote')) room.rebalanceVote = message.rebalanceVote;
        if (Object.hasOwn(message, 'transition')) room.transition = message.transition;
        if (Object.hasOwn(message, 'phaseKind')) room.phaseKind = message.phaseKind;
    }
    if (Number.isFinite(message.serverTime)) serverClockOffset = message.serverTime + latency / 2 - Date.now();
    acceptState(message.state, message.tick, message.inputs, message.ackSeq);
}

const watcher = new FootballWatcher({
    api: API,
    onRoom: next => {if (!memberId) applyRoom(next);},
    onSnapshot: message => {if (!memberId) acceptSnapshot(message);},
    onStatus: connected => {if (!memberId) setText($('connectionStatus'), connected ? 'Watching live' : 'Live view · reconnecting…');},
});

function addChat(message) {
    if (!memberId || !message || seenChat.has(message.id)) return;
    seenChat.add(message.id);
    if (seenChat.size > 400) seenChat.delete(seenChat.values().next().value);
    chatMessages.push(message);
    if (chatMessages.length > 200) chatMessages.shift();
    renderChat();
}

function renderChat() {
    const log = $('chatLog'), previousScroll = log.scrollTop, nearBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 45;
    log.replaceChildren();
    for (const message of chatMessages) {
        const row = document.createElement('p'), author = document.createElement('strong');
        if (message.system) row.className = 'chat-system-message';
        author.textContent = message.system ? 'System: ' : message.name + ': ';
        const text = $('filterProfanity').checked ? maskProfanity(message.text || '') : message.text || '';
        row.append(author, document.createTextNode(text)); log.append(row);
    }
    if (log.clientWidth) {
        const lineCounts = [...log.children].map(row => {
            const style = getComputedStyle(row), lineHeight = parseFloat(style.lineHeight) || parseFloat(style.fontSize) * 1.5;
            const inset = ['paddingTop', 'paddingBottom', 'borderTopWidth', 'borderBottomWidth'].reduce((sum, key) => sum + (parseFloat(style[key]) || 0), 0);
            return Math.max(1, Math.round((row.getBoundingClientRect().height - inset) / lineHeight));
        });
        let total = lineCounts.reduce((sum, value) => sum + value, 0), removed = 0;
        while (total > 200 && removed < lineCounts.length) total -= lineCounts[removed++];
        chatMessages.splice(0, removed);
        for (let index = 0; index < removed; index++) log.firstElementChild.remove();
    }
    log.scrollTop = nearBottom ? log.scrollHeight : previousScroll;
}

let chatWidth = 0;
new ResizeObserver(() => {
    const width = $('chatLog').clientWidth;
    if (!width || width === chatWidth) return;
    chatWidth = width;
    if (chatMessages.length) renderChat();
}).observe($('chatLog'));

function renderRoster(team, target) {
    target.replaceChildren();
    for (const member of room.members.filter(member => member.team === team)) {
        const row = document.createElement('li'), name = document.createElement('span');
        name.className = 'roster-name';
        name.textContent = member.name + (member.id === memberId ? ' (you)' : '') + (member.admin ? ' · admin' : '') + (!member.connected ? ' · reconnecting' : '');
        name.title = member.verified ? 'Verified Bonk account' : 'Guest';
        row.append(name);
        const identity = document.createElement('span'); identity.className = 'roster-identity';
        identity.textContent = member.verified ? 'Bonk' : 'Guest';
        identity.title = member.verified ? 'Verified Bonk account' : 'Guest name'; row.append(identity);
        if (team || member.queued) {
            const check = document.createElement('span'); check.className = 'ready-indicator';
            check.dataset.ready = String(!!member.ready);
            check.textContent = member.ready ? '✓ Ready' : room.status === 'playing' ? member.team ? 'Playing' : 'Next game' : 'Not ready';
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

function renderGamePanels() {
    const joined = !!memberId;
    const voting = joined && room?.status === 'voting' && !!room.vote;
    const results = joined && room?.status === 'results' && !!room.results;
    const playing = room?.status === 'playing';
    const me = self(), eligible = !!(me?.connected && (me.team || me.queued));
    $('roomEntry').hidden = joined;
    $('roomPanel').hidden = !joined;
    $('teamsOverlay').hidden = !joined || voting || results || playing && !!me?.team;
    $('pitchWrap').classList.toggle('showing-teams', !$('teamsOverlay').hidden);
    $('touchControls').hidden = !joined || !movementPhase() || !me?.team;
    $('footballChat').hidden = !joined;
    $('chatEmpty').hidden = joined;
    $('leaveRoom').hidden = !joined;
    $('pitchWrap').classList.toggle('is-in-room', joined);
    setText($('entryTitle'), account ? 'Join the game' : 'Sign in to play');
    setText($('entryDescription'), account ? 'Join the lobby, or watch the current match until the next game.' : 'Sign in to take your place on the shared pitch.');
    setText($('joinGameButton'), account ? 'Join game' : 'Sign in to join');
    $('joinGameButton').disabled = busy;
    $('gameOverlay').hidden = !voting && !results;
    $('gameOverlay').classList.toggle('is-leaving', (voting || results) && !!room?.transition);
    $('gameOverlay').dataset.phase = voting ? 'selection' : results ? 'leaderboard' : '';
    $('modeVotePanel').hidden = !voting;
    $('resultsPanel').hidden = !results;
    $('rebalanceNotice').hidden = !joined || !playing || !room?.rebalanceVote;
    $('rocketsHud').hidden = !playing || room?.mode !== 'rockets' || !room.rockets;
    $('rocketSideControls').hidden = !joined || !playing || room?.mode !== 'rockets' || room.rockets?.attackerId !== memberId;
    for (const [id, team] of [['rocketSideBlue', 3], ['rocketSideRed', 2]]) {
        $(id).setAttribute('aria-pressed', String(room?.rockets?.attackerTeam === team));
        $(id).disabled = !isOpen() || !!room?.rockets?.sideChangeUsed;
    }
    $('votingWaiting').hidden = !voting;
    if (voting) {
        const vote = room.vote, selected = vote.votes?.[memberId];
        const continuing = !!vote.continuation, resolved = !!vote.resolved || !!room.transition;
        const selectedMode = room.transition?.nextMode || vote.selectedMode;
        const nextName = selectedMode === 'rockets' ? FOOTBALL_MODES.rockets.label : 'Balanced teams';
        const scores = vote.scores || room.lastResult?.scores || [0, 0, 0, 0];
        setText($('gameOverlay').querySelector('.overlay-heading .eyebrow'), continuing ? 'MATCH COMPLETE' : 'CHOOSE A MODE');
        setText($('overlayTitle'), resolved ? 'Starting ' + nextName : continuing ? 'Choose the next game' : 'Choose a game mode');
        setText($('overlayDescription'), continuing
            ? (vote.winner ? teamName(vote.winner) + ' wins. ' : '') + 'Blue ' + scores[3] + ' · ' + scores[2] + ' Red. The next game starts automatically after voting.'
            : 'Choose balanced football or Rockets, then ready up in the lobby.');
        setText($('overlayCountdown'), resolved ? 'Starting…' : countdown(vote.deadline) + 's left');
        setText($('balancedVoteCount'), vote.counts?.balanced || 0);
        setText($('rocketsVoteCount'), vote.counts?.rockets || 0);
        for (const button of document.querySelectorAll('[data-mode-vote]')) {
            button.disabled = resolved || !isOpen() || !eligible || countdown(vote.deadline) === 0;
            button.setAttribute('aria-pressed', String(selected === button.dataset.modeVote));
        }
        setText($('votingWaiting'), resolved ? 'Starting ' + nextName + '…'
            : !eligible ? 'Spectating. Players choose the next game.'
            : selected ? 'Your vote: ' + (selected === 'rockets' ? 'Rockets' : 'Balanced teams') + '. You can change it until voting ends.'
            : 'One vote per player. Voting closes when everyone has voted or time runs out.');
    } else if (results) {
        const result = room.results, rocketResults = result.mode === 'rockets';
        setText($('gameOverlay').querySelector('.overlay-heading .eyebrow'), rocketResults ? 'ROCKETS COMPLETE' : 'GAME COMPLETE');
        setText($('overlayTitle'), rocketResults ? 'Fastest goals' : room.winner ? teamName(room.winner) + ' wins' : 'Game complete');
        setText($('overlayDescription'), rocketResults ? 'Ranked by ball speed as it crossed the goal.' : 'The game has finished.');
        setText($('overlayCountdown'), room.transition ? 'Returning to lobby…' : 'Lobby in ' + countdown(result.deadline) + 's');
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
        setText($('rocketTurnName'), (attacker?.name || 'Next player') + ' · ' + teamName(turn.attackerTeam || 3) + ' · Turn ' + turn.turnIndex + '/' + turn.totalTurns);
        setText($('rocketTurnTimer'), Math.ceil(Math.max(0, turn.turnTicksLeft) / C.TICK_RATE) + 's');
    }
}

function buildSettingsFields() {
    const container = $('settingsFields');
    for (const [key, rule] of Object.entries(SETTING_RULES)) {
        const field = document.createElement('div'), title = document.createElement('span'), input = document.createElement('input');
        field.className = 'field setting-field'; title.className = 'setting-label'; title.id = 'label-' + key;
        const slider = ['goalHeight', 'ballRadius', 'playerRadius'].includes(key);
        title.textContent = rule.label + ':'; input.id = 'setting-' + key; input.name = key; input.type = slider ? 'range' : 'number';
        input.min = rule.min; input.max = rule.max; input.step = key === 'goalHeight' ? 'any' : slider ? 0.1 : rule.step;
        input.value = DEFAULT_MATCH_SETTINGS[key]; input.required = true; input.setAttribute('aria-labelledby', title.id);
        const row = document.createElement('div'), reset = document.createElement('button');
        row.className = 'setting-input-row' + (slider ? ' setting-slider-row' : '');
        row.append(input);
        if (slider) {
            const value = document.createElement('output'); value.id = 'value-' + key; value.className = 'setting-value'; value.htmlFor = input.id;
            row.append(value);
        }
        reset.type = 'button'; reset.className = 'setting-reset button-secondary button-small'; reset.dataset.resetSetting = key;
        reset.title = 'Reset ' + rule.label.toLowerCase() + ' to ' + DEFAULT_MATCH_SETTINGS[key]; reset.setAttribute('aria-label', reset.title);
        const icon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        icon.setAttribute('viewBox', '0 0 24 24'); icon.setAttribute('aria-hidden', 'true'); icon.setAttribute('fill', 'none'); icon.setAttribute('stroke', 'currentColor'); icon.setAttribute('stroke-width', '1.8'); icon.setAttribute('stroke-linecap', 'round'); icon.setAttribute('stroke-linejoin', 'round');
        for (const d of ['M20 7v5h-5M20 12a8 8 0 0 0-13.7-5.7', 'M4 17v-5h5M4 12a8 8 0 0 0 13.7 5.7']) {
            const path = document.createElementNS('http://www.w3.org/2000/svg', 'path'); path.setAttribute('d', d); icon.append(path);
        }
        reset.append(icon);
        reset.addEventListener('click', () => {
            input.value = DEFAULT_MATCH_SETTINGS[key];
            settingsDirty = settingsFingerprint(readSettingsFields()) !== settingsFingerprint(room?.pendingSettings || room?.settings || DEFAULT_MATCH_SETTINGS);
            if (room) updateSettings();
        });
        row.append(reset); field.append(title, row);
        if (key === 'goalHeight' || key === 'moveForce') {
            const hint = document.createElement('small'); hint.className = 'setting-hint'; hint.id = 'hint-' + key;
            hint.textContent = key === 'goalHeight' ? 'Zero or negative: closed goals. The ball bounces back.' : 'Negative values reverse the movement controls.';
            input.setAttribute('aria-describedby', hint.id); field.append(hint);
        }
        container.append(field);
        if (key === 'goalHeight') {
            input.addEventListener('input', () => {
                const limit = goalHeightLimit({pitchHeight: Number($('setting-pitchHeight')?.value) || DEFAULT_MATCH_SETTINGS.pitchHeight});
                const value = Number(input.value), endpoint = Math.abs(Math.abs(value) - limit) < 1e-7;
                input.value = Math.max(-limit, Math.min(limit, endpoint ? value : Math.round(value * 10) / 10));
            });
            input.addEventListener('keydown', event => {
                const value = Number(input.value), limit = Number(input.max);
                let next;
                if (event.key === 'Home') next = -limit;
                else if (event.key === 'End') next = limit;
                else if (event.key === 'ArrowLeft' || event.key === 'ArrowDown') next = (Math.ceil(value * 10 - 1e-7) - 1) / 10;
                else if (event.key === 'ArrowRight' || event.key === 'ArrowUp') next = (Math.floor(value * 10 + 1e-7) + 1) / 10;
                else return;
                event.preventDefault(); input.value = Math.max(-limit, Math.min(limit, next)); input.dispatchEvent(new Event('input', {bubbles: true}));
            });
        }
    }
    syncSettingSliders();
}

function syncSettingSliders() {
    const goal = $('setting-goalHeight');
    const value = Number(goal.value), limit = goalHeightLimit({pitchHeight: Number($('setting-pitchHeight').value) || DEFAULT_MATCH_SETTINGS.pitchHeight});
    goal.min = -limit; goal.max = limit; goal.value = Math.max(-limit, Math.min(limit, value));
    for (const key of ['goalHeight', 'ballRadius', 'playerRadius']) {
        const input = $('setting-' + key), value = Number(input.value);
        $('value-' + key).value = Number(value.toFixed(2)) + ' m';
        input.setAttribute('aria-valuetext', Number(value.toFixed(2)) + ' metres');
    }
}

function readSettingsFields() {
    syncSettingSliders();
    return Object.fromEntries(Object.keys(SETTING_RULES).map(key => [key, Number($('setting-' + key).value)]));
}

function updateSettings() {
    const target = room.pendingSettings || room.settings, signature = settingsFingerprint(target);
    if (signature !== settingsSignature && !settingsDirty) {
        // An unchanged roster/chat update must not overwrite a form being edited.
        for (const key of Object.keys(SETTING_RULES).filter(key => key !== 'goalHeight')) $('setting-' + key).value = target[key] ?? DEFAULT_MATCH_SETTINGS[key];
        syncSettingSliders(); $('setting-goalHeight').value = target.goalHeight ?? DEFAULT_MATCH_SETTINGS.goalHeight;
        settingsDirty = false; settingsSignature = signature;
    }
    syncSettingSliders();
    const disabled = !isOpen() || !self()?.admin || pendingSettingsSignature !== null;
    $('matchSettingsForm').querySelectorAll('input,button').forEach(input => input.disabled = disabled);
    $('saveSettings').disabled = disabled || !settingsDirty;
    setText($('saveSettings'), room.status === 'playing' ? 'Apply next round' : room.status === 'lobby' ? 'Apply settings' : 'Apply next game');
    if ($('settingsStatus')) setText($('settingsStatus'), settingsDirty ? 'Unsaved changes. Apply when ready.'
        : room.pendingSettings ? 'Changes are queued for the next kickoff or Rockets turn.'
        : room.status === 'lobby' ? 'Applies when the next game starts.' : 'Applied changes take effect at the next kickoff or Rockets turn.');
}

function applyRoom(next) {
    if (!next) return;
    const oldStatus = room?.status, oldAttacker = room?.rockets?.attackerId;
    const oldVoteId = room?.vote?.id, oldResultTime = room?.results?.finishedAt;
    room = next;
    if (settingsFingerprint(room.pendingSettings || room.settings) === pendingSettingsSignature) {settingsDirty = false; pendingSettingsSignature = null;}
    if (oldStatus !== room.status || oldAttacker !== room.rockets?.attackerId) {releaseInput(); snapshots = []; predictor.reset(); predicted = null;}
    setText($('roomTitle'), room.name); setText($('roomCodeDisplay'), room.id);
    history.replaceState(null, '', location.pathname);
    renderRoster(3, $('blueRoster')); renderRoster(2, $('redRoster')); renderRoster(0, $('spectatorRoster'));
    const admin = !!self()?.admin, playing = room.status === 'playing', me = self();
    if (me && [0, 2, 3].includes(me.preferredTeam)) selectedPreference = me.preferredTeam;
    $('hostControls').hidden = !admin;
    $('adminMatchControls').hidden = !admin;
    syncSidebarPresentation();
    updateSettings();
    $('startMatch').hidden = room.status !== 'lobby';
    $('abortMatch').hidden = !playing || !admin;
    $('abortMatch').disabled = !isOpen();
    $('rematchMatch').hidden = room.status !== 'finished';
    const canStart = !!room.canStart;
    $('startMatch').disabled = !canStart || !isOpen(); $('rematchMatch').disabled = !canStart || !isOpen();
    setText($('modeLabel'), modeName());
    setText($('lobbyStateLabel'), room.status === 'playing' ? 'IN GAME' : room.status === 'voting' ? 'VOTING' : room.status === 'results' ? 'RESULTS' : 'LOBBY');
    $('spectate').disabled = !isOpen() || !me?.team && !me?.queued;
    for (const [id, team] of [['joinBlue', 3], ['joinRed', 2]]) {
        $(id).disabled = !isOpen() || me?.team === team && room.status === 'lobby';
        setText($(id), playing && !me?.team ? 'Join ' + teamName(team) + ' next game' : 'Join ' + teamName(team));
    }
    const readyEligible = !!(me?.connected && (me.team || (room.mode === 'rockets' && me.queued)));
    $('readyButton').disabled = !isOpen() || room.status !== 'lobby' || !readyEligible;
    $('readyButton').setAttribute('aria-pressed', String(!!me?.ready));
    setText($('readyButton'), me?.ready ? '✓ Ready — click to cancel' : 'Ready');
    const active = room.members.filter(member => member.connected && (member.team || (room.mode === 'rockets' && member.queued)));
    const waiting = active.filter(member => !member.ready).length;
    setText($('readySummary'), room.status === 'voting' ? room.vote?.continuation ? 'Choose the next game. It starts automatically after voting.' : 'Choose a mode on the pitch, then ready up.'
        : room.status === 'results' ? 'Fastest goals are on the pitch. Returning to the lobby shortly.'
        : playing ? room.mode === 'rockets' ? (room.rockets?.participantIds?.includes(memberId) ? 'Your Rockets turn follows join order.' : 'New arrivals play in the next game.')
            : me?.queued ? 'Spectating until the next game.' : 'Players can vote to rebalance if someone leaves.'
        : !active.length ? 'Join a team to play.' : waiting ? active.filter(member => member.ready).length + ' / ' + active.length + ' ready.' + (active.length === 1 ? ' You can practise solo.' : ' Everyone playing must be ready.') : 'Everyone is ready. Starting…');
    $('chatInput').disabled = !isOpen(); $('sendChat').disabled = !isOpen();
    if (room.state) acceptState(room.state, tick, lastInputs);
    else {
        lastState = null; predicted = null; snapshots = []; lastScores = [0, 0, 0, 0];
        syncPitch(null);
        setText($('scoreBlue'), 0); setText($('scoreRed'), 0);
    }
    if ((oldStatus !== room.status || oldAttacker !== room.rockets?.attackerId) && room.status === 'playing' && self()?.team
        && !document.activeElement?.matches('input,textarea,select,[contenteditable="true"]')) {
        canvas.focus({preventScroll: true});
    }
    renderGamePanels(); updateMatchStatus();
    if ((room.status === 'voting' || room.status === 'results')
        && (oldStatus !== room.status || oldVoteId !== room.vote?.id || oldResultTime !== room.results?.finishedAt)) {
        $('gameOverlay').firstElementChild.scrollTop = 0;
    }
    if (oldStatus !== room.status && room.status !== 'playing') requestAnimationFrame(() => {$('roomPanel').scrollTop = 0;});
}

function updateMatchStatus() {
    let text = 'Join football to play or watch the shared game.';
    if (!memberId) text = account ? 'Watching the pitch. Join when you are ready.' : 'Watch the pitch, then sign in to join.';
    else if (room) {
        const me = self();
        const role = me?.team ? (room.status === 'lobby' ? 'Assigned to ' : 'Playing for ') + teamName(me.team) : me?.queued ? 'Spectating until the next game' : 'Spectating';
        if (!ready) text = reconnecting ? 'Connection interrupted. Reconnecting…' : 'Connecting to room…';
        else if (room.status === 'voting') text = room.transition ? 'The selected game is starting.'
            : room.vote?.continuation ? 'Vote to continue. The selected game starts automatically.'
            : 'Choose a mode, then ready up in the lobby.';
        else if (room.status === 'results') text = room.transition ? 'Returning to the lobby.' : 'Rockets complete. Fastest goals are on the pitch.';
        else if (room.status === 'lobby') text = role + '. Ready up to start the game.';
        else if (room.status === 'finished') text = teamName(room.winner) + ' wins. Ready up for the next game.';
        else if (lastState?.ftu >= 0) text = 'Kickoff in ' + Math.ceil(lastState.ftu / 30) + '. ' + role + '.';
        else if (lastState?.fte >= 0) text = teamName(lastState.lscr) + ' scores!';
        else if (room.mode === 'rockets' && room.rockets) {
            const attacker = room.members.find(member => member.id === room.rockets.attackerId);
            text = (attacker?.name || 'Next player') + ' is shooting. ' + Math.ceil(room.rockets.turnTicksLeft / 30) + 's left.';
        } else text = role + '. ' + (!geometry.goalEnabled ? 'Goals closed — practice mode.' : 'First to ' + room.settings.scoreLimit + '.');
    }
    if (notice && performance.now() < noticeUntil) text = notice;
    if (text !== latestStatus) {latestStatus = text; setText($('matchStatus'), text);}
    renderGamePanels();
}

async function connectSession(joined) {
    watcher.stop();
    const ownGeneration = ++generation;
    clearTimeout(retryTimer); retryTimer = null;
    socket?.close(1000, 'Replaced connection');
    ready = false; sequence = 0; predictor.reset(); sentViewportAspect = null; memberId = joined.member.id;
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
                applyRoom(message.room); setText($('connectionStatus'), 'Connected'); syncViewport(); sendInput(); send({type: 'ping', sentAt: performance.now()});
                if (!settled) {settled = true; clearTimeout(timeout); resolve();}
            } else if (message.type === 'room') applyRoom(message.room);
            else if (message.type === 'snapshot') {
                acceptSnapshot(message);
            } else if (message.type === 'chat') addChat(message);
            else if (message.type === 'notice') showNotice(message.text || 'Lobby updated.');
            else if (message.type === 'removed') {
                storeSeat(room?.id, null); returnToEntry(message.reason || 'You left the room.');
            }
            else if (message.type === 'pong') {
                const measured = Math.max(0, Math.min(2000, performance.now() - message.sentAt));
                latency = latency ? latency * .7 + measured * .3 : measured;
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
            clearTimeout(timeout); ready = false; predicted = null; predictor.reset(); releaseInput();
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
        displayName: account?.username || $('displayName').value.trim(), preferredTeam: selectedPreference, ...(seat?.resumeToken ? {resumeToken: seat.resumeToken} : {})
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
            if ([401, 403, 404].includes(error.status)) {
                storeSeat(id, null); returnToEntry(error.status === 401 ? 'Sign in again to rejoin the game.' : error.message);
                if (error.status === 401) {account = null; accountLoaded = false; void accountMenu.refresh();}
            }
            else scheduleReconnect();
        }
    }, Math.min(5000, 500 * 2 ** retries));
}

function returnToEntry(message = '') {
    leaving = true; ready = false; reconnecting = false; generation++;
    retries = 0;
    clearTimeout(retryTimer); retryTimer = null;
    releaseInput(); socket?.close(1000, 'Left room'); socket = null;
    $('entryStatus').textContent = message; setText($('connectionStatus'), 'Not connected');
    memberId = null; predicted = null; predictor.reset(); setGameUiHidden(false);
    syncSidebarPresentation();
    seenChat.clear(); chatMessages.length = 0; $('chatLog').replaceChildren();
    $('hostControls').hidden = true; $('adminMatchControls').hidden = true; $('chatInput').disabled = true; $('sendChat').disabled = true;
    settingsSignature = ''; settingsDirty = false; pendingSettingsSignature = null; leaderboardSignature = '';
    syncPitch(room?.state || null); setBusy(false); renderGamePanels(); updateMatchStatus(); watcher.start();
}

async function entryAction(action) {
    if (busy) return;
    setBusy(true); $('entryStatus').textContent = ''; warmAudio();
    try {
        try {localStorage.setItem('football-display-name', $('displayName').value.trim());} catch {}
        await action(); canvas.focus({preventScroll: true});
    } catch (error) {
        if ([403, 404].includes(error.status)) storeSeat(LOBBY_ID, null);
        if (error.status === 401) {account = null; accountLoaded = false; void accountMenu.refresh();}
        returnToEntry(error.message);
    }
    finally {setBusy(false);}
}

async function joinFromEntry() {
    if (!accountLoaded) await accountMenu.refresh('join-check');
    if (!account) {joinAfterLogin = true; accountMenu.openLogin(); return;}
    joinAfterLogin = false;
    await entryAction(async () => {
        try {await join(LOBBY_ID, true);}
        catch (error) {if ([403, 404].includes(error.status)) {storeSeat(LOBBY_ID, null); await join(LOBBY_ID, false);} else throw error;}
    });
}
$('joinRoomForm').addEventListener('submit', event => {event.preventDefault(); void joinFromEntry();});
$('leaveRoom').addEventListener('click', () => {send({type: 'leave'}); storeSeat(room?.id, null); returnToEntry(); history.replaceState(null, '', location.pathname);});
$('spectate').addEventListener('click', () => {send({type: 'spectate'}); canvas.focus({preventScroll: true});});
for (const [id, team] of [['rocketSideBlue', 3], ['rocketSideRed', 2]]) $(id).addEventListener('click', () => {
    send({type: 'preference', team}); canvas.focus({preventScroll: true});
});
for (const [id, team] of [['joinBlue', 3], ['joinRed', 2]]) $(id).addEventListener('click', () => {
    selectedPreference = team;
    try {localStorage.setItem('football-preferred-team:' + (account?.id || 'viewer'), String(team));} catch {}
    send({type: 'team', team}); canvas.focus({preventScroll: true});
});
for (const id of ['toggleGameUi', 'toggleFullscreenUi']) $(id).addEventListener('click', () => setGameUiHidden(!gameUiHidden));
$('readyButton').addEventListener('click', () => {warmAudio(); send({type: 'ready', ready: !self()?.ready}); canvas.focus({preventScroll: true});});
for (const button of document.querySelectorAll('[data-mode-vote]')) button.addEventListener('click', () => {
    releaseInput(); send({type: 'modeVote', mode: button.dataset.modeVote});
});
for (const [id, yes] of [['rebalanceYes', true], ['rebalanceNo', false]]) $(id).addEventListener('click', () => {
    releaseInput(); send({type: 'rebalanceVote', yes}); canvas.focus({preventScroll: true});
});
for (const [id, type] of [['startMatch', 'start'], ['abortMatch', 'abort'], ['rematchMatch', 'rematch']]) $(id).addEventListener('click', () => {warmAudio(); send({type}); canvas.focus({preventScroll: true});});
buildSettingsFields();
$('matchSettingsForm').addEventListener('input', () => {
    settingsDirty = settingsFingerprint(readSettingsFields()) !== settingsFingerprint(room?.pendingSettings || room?.settings || DEFAULT_MATCH_SETTINGS);
    if (room) updateSettings();
});
$('matchSettingsForm').addEventListener('submit', event => {
    event.preventDefault();
    if (!self()?.admin) return;
    const checked = validateMatchSettings(readSettingsFields(), room.pendingSettings || room.settings);
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
    if (text && send({type: 'chat', text})) $('chatInput').value = '';
    canvas.focus({preventScroll: true});
});
$('chatInput').addEventListener('keydown', event => {
    if (!['Enter', 'NumpadEnter'].includes(event.code) || event.isComposing) return;
    event.preventDefault(); event.stopPropagation();
    if (!event.repeat && !chatEnterHeld) {chatEnterHeld = true; $('chatForm').requestSubmit();}
});
$('fullscreenToggle').addEventListener('click', async () => {
    try {if (document.fullscreenElement) await document.exitFullscreen(); else await $('pitchWrap').requestFullscreen({navigationUI: 'hide'}); updateFullscreenPresentation(); canvas.focus({preventScroll: true});}
    catch {showNotice('Fullscreen is unavailable in this browser.');}
});
$('exitFullscreen').addEventListener('click', async () => {
    try {if (document.fullscreenElement) await document.exitFullscreen(); updateFullscreenPresentation(); canvas.focus({preventScroll: true});}
    catch {showNotice('Unable to exit fullscreen. Use Escape to return to the page.');}
});
function updateFullscreenPresentation() {
    setText($('fullscreenToggle'), document.fullscreenElement ? 'Exit fullscreen' : 'Fullscreen');
    $('exitFullscreen').hidden = !document.fullscreenElement;
    syncSidebarPresentation();
    requestAnimationFrame(() => {resizeCanvas(); renderChat();});
}
document.addEventListener('fullscreenchange', updateFullscreenPresentation);
$('fullscreenSettingsToggle').addEventListener('click', () => setSettingsDrawer(!settingsDrawerOpen));
$('closeFullscreenSettings').addEventListener('click', () => {setSettingsDrawer(false); canvas.focus({preventScroll: true});});
for (const id of ['gameUiHotspot', 'fieldToolbar']) {
    const target = $(id);
    target.addEventListener('pointerenter', revealHiddenToolbar);
    target.addEventListener('pointerleave', () => scheduleToolbarHide());
    target.addEventListener('focusin', revealHiddenToolbar);
    target.addEventListener('focusout', () => scheduleToolbarHide());
}
$('gameUiHotspot').addEventListener('click', () => {revealHiddenToolbar(); scheduleToolbarHide(3000);});
$('fieldToolbar').addEventListener('click', event => {
    if (event.target.closest('button')) canvas.focus({preventScroll: true});
});
$('pitchWrap').addEventListener('pointermove', event => {
    if (!gameUiHidden || event.pointerType === 'touch') return;
    const bounds = $('pitchWrap').getBoundingClientRect();
    pointerInToolbarCorner = event.clientX >= bounds.right - Math.min(230, bounds.width * .65) && event.clientY <= bounds.top + 58;
    if (pointerInToolbarCorner) revealHiddenToolbar();
    else scheduleToolbarHide();
});
$('pitchWrap').addEventListener('pointerleave', () => {pointerInToolbarCorner = false; scheduleToolbarHide();});
$('muteSound').addEventListener('click', () => {muted = !muted; $('muteSound').setAttribute('aria-pressed', String(muted)); setText($('muteSound'), muted ? 'Sound off' : 'Sound on'); if (!muted) warmAudio();});
canvas.addEventListener('pointerdown', () => {canvas.focus({preventScroll: true}); warmAudio();});
canvas.addEventListener('pointerup', event => {
    if (!gameUiHidden || event.pointerType !== 'touch') return;
    const now = performance.now();
    if (restoreTouch && now - restoreTouch.at < 400 && Math.hypot(event.clientX - restoreTouch.x, event.clientY - restoreTouch.y) < 35) setGameUiHidden(false);
    else restoreTouch = {at: now, x: event.clientX, y: event.clientY};
});
window.addEventListener('keydown', event => {
    if (!capturingKey) return;
    event.preventDefault(); event.stopImmediatePropagation();
    if (event.code === 'Escape') {capturingKey = null; renderBindingFields(); setText($('keybindStatus'), 'Key capture cancelled.'); return;}
    const code = canonicalBindingCode(event.code);
    if (!code) {setText($('keybindStatus'), 'Choose another key. Enter and Escape are reserved for chat and menus.'); return;}
    const {action, slot} = capturingKey;
    draftBindings[action][slot] = event.code === 'Backspace' || event.code === 'Delete' ? null : code;
    capturingKey = null; renderBindingFields(); setText($('keybindStatus'), 'Unsaved controls. Save to apply them to football.');
}, true);
window.addEventListener('keydown', event => {
    if (event.code === 'Escape') {releaseInput(); if (settingsDrawerOpen) setSettingsDrawer(false); if (gameUiHidden) setGameUiHidden(false);}
    if (['Enter', 'NumpadEnter'].includes(event.code) && !editable(event.target) && memberId) {
        event.preventDefault();
        if (!event.repeat && !chatEnterHeld) {chatEnterHeld = true; releaseInput(); if (gameUiHidden && document.fullscreenElement === $('pitchWrap')) setGameUiHidden(false); $('chatInput').focus();}
        return;
    }
    if (event.code === 'Escape' && event.target === $('chatInput')) {releaseInput(); canvas.focus({preventScroll: true}); return;}
    if (!keys.has(canonicalBindingCode(event.code)) || gameInputBlocked(event.target) || !movementPhase() || !isOpen() || !self()?.team) return;
    event.preventDefault();
    if (document.activeElement !== canvas) canvas.focus({preventScroll: true});
    held.add(event.code); updateInput(); warmAudio();
});
window.addEventListener('keyup', event => {if (['Enter', 'NumpadEnter'].includes(event.code)) chatEnterHeld = false; if (held.delete(event.code)) {event.preventDefault(); updateInput();}});
window.addEventListener('blur', () => {chatEnterHeld = false; releaseInput();});
$('filterProfanity').addEventListener('change', () => {
    try {localStorage.setItem('football-profanity-filter', String($('filterProfanity').checked));} catch {}
    renderChat();
});
$('resetKeybinds').addEventListener('click', () => {
    capturingKey = null; draftBindings = copyBindings({...DEFAULT_KEYBINDS, action2: []}); renderBindingFields();
    setText($('keybindStatus'), 'Default keys restored. Save to apply them.');
});
$('saveKeybinds').addEventListener('click', () => {
    capturingKey = null;
    const draft = Object.fromEntries(BINDING_ACTIONS.map(action => [action, draftBindings[action].filter(Boolean)]));
    const checked = validateKeybinds(draft);
    if (checked.error) {renderBindingFields(); setText($('keybindStatus'), checked.error); return;}
    applyBindings(checked.bindings); draftBindings = copyBindings(activeBindings); renderBindingFields();
    try {localStorage.setItem(bindingStorageKey(), JSON.stringify(activeBindings));} catch {}
    setText($('keybindStatus'), 'Saved for football in this browser. Your Bonk settings are unchanged.');
});
$('footballControls').addEventListener('toggle', () => {if (!$('footballControls').open && capturingKey) {capturingKey = null; renderBindingFields();}});
document.addEventListener('visibilitychange', () => {if (document.hidden) releaseInput();});
document.addEventListener('focusin', event => {if (editable(event.target)) releaseInput();});
document.querySelectorAll('[data-control]').forEach(button => {
    button.addEventListener('pointerdown', event => {
        event.preventDefault(); if (!movementPhase() || !isOpen() || !self()?.team) return;
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
    if (signature === geometrySignature) return false;
    geometry = next; geometrySignature = signature;
    const g = geometry.pixels;
    canvas.parentElement.style.setProperty('--pitch-ratio', g.width + ' / ' + g.height);
    canvas.parentElement.style.setProperty('--pitch-ratio-value', String(g.width / g.height));
    resizeCanvas();
    return true;
}

function redrawPitch() {
    if (!geometry) return;
    const g = geometry.pixels;
    // Rasterize vectors at the final display resolution. The frame renderer
    // copies this buffer one physical pixel to one physical pixel.
    pitch.width = canvas.width; pitch.height = canvas.height;
    paint.fillStyle = '#5a7f64'; paint.fillRect(0, 0, pitch.width, pitch.height);
    paint.setTransform(viewport.ratio, 0, 0, viewport.ratio, 0, 0);
    paint.translate(viewport.x, viewport.y); paint.scale(viewport.scale, viewport.scale);
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
}

function resizeCanvas() {
    const bounds = canvas.getBoundingClientRect(), ratio = Math.min(4, window.devicePixelRatio || 1);
    const width = Math.max(1, Math.round(bounds.width * ratio)), height = Math.max(1, Math.round(bounds.height * ratio));
    if (canvas.width !== width) canvas.width = width;
    if (canvas.height !== height) canvas.height = height;
    viewport.width = bounds.width; viewport.height = bounds.height; viewport.ratio = ratio;
    const g = geometry?.pixels || {width: C.WIDTH, height: C.HEIGHT};
    viewport.scale = Math.min(bounds.width / g.width, bounds.height / g.height);
    viewport.x = (bounds.width - g.width * viewport.scale) / 2; viewport.y = (bounds.height - g.height * viewport.scale) / 2;
    syncViewport();
    redrawPitch();
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

function drawNameLabel(label, x, y, maxWidth = 105) {
    context.font = '9px Arial, sans-serif'; context.fillStyle = 'rgba(255,255,255,.9)'; context.textAlign = 'center';
    context.fillText(label, x, y, maxWidth);
}

function draw(now) {
    if (predicted && movementPhase() && isOpen() && now - lastSnapshotAt < 500) {
        predicted = predictor.advance(now);
    }
    // Both members and public viewers render the same server state. A stalled
    // stream freezes the last real frame rather than replacing it with bots.
    const display = interpolated(now), authoritative = lastState;
    context.setTransform(1, 0, 0, 1, 0, 0);
    context.drawImage(pitch, 0, 0);
    context.setTransform(viewport.ratio, 0, 0, viewport.ratio, 0, 0);
    context.translate(viewport.x, viewport.y); context.scale(viewport.scale, viewport.scale);
    const g = geometry.pixels;
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
            const disc = predicted?.discs[slot] && slot === ownSlot ? predictor.renderBody('self', predicted.discs[slot], now) : source;
            const x = disc.x * geometry.ppm, y = disc.y * geometry.ppm, blue = disc.team === 3;
            context.beginPath(); context.arc(x, y, g.playerRadius, 0, Math.PI * 2);
            context.fillStyle = blue ? '#2d69b2' : '#ad3636'; context.fill();
            const action = slot === ownSlot ? flags & 16 : (lastInputs[slot] || 0) & 16;
            context.strokeStyle = action ? '#ffffff' : blue ? '#448aff' : '#d32f2f'; context.lineWidth = 2.5; context.stroke();
            const member = room?.members.find(member => member.slot === slot);
            context.fillStyle = '#ffffff'; context.font = 'bold 9px Arial, sans-serif'; context.textAlign = 'center';
            context.fillText(Array.from(member?.name || display.players?.[slot]?.name || '?')[0].toUpperCase(), x, y + 0.5);
            drawNameLabel(member?.name || display.players?.[slot]?.name || 'Player', x, y + g.playerRadius + 11);
            if (slot === ownSlot) {context.beginPath(); context.moveTo(x - 3, y + g.playerRadius + 18); context.lineTo(x + 3, y + g.playerRadius + 18); context.lineTo(x, y + g.playerRadius + 14); context.closePath(); context.fill();}
        });
        const ball = predicted?.ball && self()?.team ? predictor.renderBody('ball', predicted.ball, now) : display.ball;
        context.beginPath(); context.arc(ball.x * geometry.ppm, ball.y * geometry.ppm, g.ballRadius, 0, Math.PI * 2);
        context.fillStyle = '#ffffff'; context.fill();
        if (room?.mode === 'rockets') {
            const speed = ballSpeed({ball});
            if (speed !== null) {
                drawNameLabel(speed.toFixed(1) + ' m/s', ball.x * geometry.ppm, ball.y * geometry.ppm + g.ballRadius + 11);
            }
        }
    }
    let banner = '', caption = '';
    if (!memberId) {banner = ''; caption = '';}
    else if (!room) {banner = 'FOOTBALL'; caption = 'Join the lobby and play.';}
    else if (!ready) {banner = reconnecting ? 'RECONNECTING' : 'CONNECTING'; caption = 'Waiting for the room…';}
    else if (room.status === 'voting' || room.status === 'results') {banner = ''; caption = '';}
    else if (room.status === 'lobby') {banner = ''; caption = '';}
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
loadAccountPreferences(null);
syncSidebarPresentation();
const accountMenu = initFootballAccount({
    request,
    onSession: async (session, reason) => {
        const previousId = account?.id; account = session?.user || null; accountLoaded = true;
        if (reason === 'initial' || reason === 'login' || previousId !== account?.id) loadAccountPreferences(account);
        $('displayName').readOnly = !!account;
        if (account) {$('displayName').value = account.username; $('displayName').title = 'Using your verified Bonk account';}
        else {$('displayName').title = '';}
        if (reason === 'login' && memberId) {
            if (previousId && previousId !== account?.id) {send({type: 'leave'}); storeSeat(room.id, null); returnToEntry();}
            await entryAction(() => join(LOBBY_ID, true));
        } else if (reason === 'login' && joinAfterLogin) {
            await joinFromEntry();
        } else if (reason === 'refresh' && previousId && previousId !== account?.id && memberId) {
            send({type: 'leave'}); storeSeat(room.id, null); returnToEntry('Your account changed. Join again to continue.');
        }
        renderGamePanels();
    },
    onLogout: async () => {if (memberId) {send({type: 'leave'}); storeSeat(room.id, null); returnToEntry();}},
    onError: showNotice,
    onLoginClosed: () => {joinAfterLogin = false;},
    onLoginOpened: () => {setGameUiHidden(false); releaseInput(); if (capturingKey) {capturingKey = null; renderBindingFields();}},
});
$('footballApp').dataset.ready = 'true';
watcher.start();
(async () => {
    await accountMenu.refresh('initial');
    if (account && savedSeat(LOBBY_ID)?.resumeToken) {
        try {
            await entryAction(() => join(LOBBY_ID, true));
        } catch (error) {$('entryStatus').textContent = error.message;}
    }
})();
