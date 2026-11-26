import {FootballPhysics, createState} from '../../football/physics.js';
import {DEFAULT_MATCH_SETTINGS, validateMatchSettings} from '../../football/settings.js';
import {ROCKET_TURN_TICKS, goalSpeed, balancedTeamAssignments, rocketsRoster, rocketsLeaderboard} from '../../football/modes.js';
import {FOOTBALL_HUB_ID} from './football-api.js';

const TICKET_TTL = 30_000, RESUME_GRACE = 15_000, HEARTBEAT_TTL = 15_000, IDLE_TTL = 30 * 60_000;
const MAX_MEMBERS = 64, TEAM_SIZE = 4, MESSAGE_LIMIT = 1024;
const MODE_VOTE_TTL = 15_000, REBALANCE_VOTE_TTL = 15_000, RESULTS_TTL = 10_000;
const STEP_MS = 1000 / 30, MAX_PUMP_DELTA = 250, MAX_CATCHUP_STEPS = 8;
const validObject = value => value && typeof value === 'object' && !Array.isArray(value);
const randomToken = () => crypto.randomUUID().replaceAll('-', '') + crypto.randomUUID().replaceAll('-', '');
const json = (data, status = 200) => new Response(JSON.stringify(data), {status, headers:{'Content-Type':'application/json', 'Cache-Control':'no-store'}});
const cleanName = (value, length) => typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, length) : '';
async function digest(token) {return [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token)))].map(byte => byte.toString(16).padStart(2, '0')).join('');}
const privileged = new Set(['assign', 'settings', 'start', 'rematch', 'abort', 'kick']);

export class FootballRoom {
    constructor(ctx, env) {
        this.ctx = ctx; this.env = env; this.room = null;
        this.connections = new Map(); this.tickets = new Map(); this.inputs = []; this.inputTimes = []; this.sequences = []; this.playerLeaves = new Set();
        this.physics = new FootballPhysics(); this.timer = null; this.lastPumpAt = 0; this.accumulator = 0; this.tickNumber = 0; this.lastSaved = 0; this.persistChain = Promise.resolve();
        this.ready = ctx.blockConcurrencyWhile(async () => {
            const saved = await ctx.storage.get('checkpoint');
            if (!saved || ![2, 3].includes(saved.version)) return;
            this.room = saved.room; this.tickNumber = saved.tick || 0;
            Object.assign(this.room, {mode:this.room.mode || 'balanced', modeSelected:this.room.modeSelected ?? false, balanceDeferred:this.room.balanceDeferred || false, vote:this.room.vote || null, rebalanceVote:this.room.rebalanceVote || null, rockets:this.room.rockets || null, results:this.room.results || null});
            if (this.room.status === 'finished') {this.room.status = 'results'; this.room.results = {...this.room.lastResult, mode:'balanced', deadline:Date.now() + RESULTS_TTL};}
            let joinedAt = 0;
            for (const member of this.room.members) {member.joinedAt = Math.max(member.joinedAt || 0, joinedAt + 1); joinedAt = member.joinedAt; member.connected = false; member.ready = false; member.disconnectedAt = member.disconnectedAt || Date.now(); member.pendingUntil = 0;}
            this.room.lastJoinedAt = Math.max(this.room.lastJoinedAt || 0, joinedAt);
            if (Date.now() - this.room.lastActive >= IDLE_TTL) {await this.clearIdle(); return;}
            this.sweep(); this.ensureTimer(); await this.scheduleAlarm();
        });
    }
    ensureRoom() {
        if (!this.room) this.room = {id:FOOTBALL_HUB_ID, name:'Football Division', hostId:null, status:'lobby', mode:'balanced', modeSelected:false, balanceDeferred:false, vote:null, rebalanceVote:null, rockets:null, results:null, settings:{...DEFAULT_MATCH_SETTINGS, maxPerTeam:TEAM_SIZE}, state:null, winner:null, lastResult:null, members:[], chat:[], nextQueueOrder:1, lastJoinedAt:0, createdAt:Date.now(), lastActive:Date.now()};
        return this.room;
    }
    canStart() {return this.room.status === 'lobby' && this.room.members.some(member => member.team && member.connected);}
    readyEligible() {return this.room.mode === 'rockets' ? this.voteEligible() : this.room.members.filter(member => member.team && member.connected);}
    allReady() {return this.canStart() && this.readyEligible().every(member => member.ready);}
    publicRoom() {
        const room = this.ensureRoom(), queue = room.members.filter(member => member.queued).sort((a, b) => a.queueOrder - b.queueOrder);
        return {id:room.id, name:room.name, hostId:null, status:room.status, mode:room.mode, vote:this.publicVote(room.vote), rebalanceVote:this.publicVote(room.rebalanceVote), rockets:this.publicRockets(), results:room.results, settings:{...room.settings}, winner:room.winner, lastResult:room.lastResult, allReady:this.allReady(), canStart:this.canStart(), queueLength:queue.length,
            members:room.members.map(member => ({id:member.id, slot:member.slot, name:member.name, verified:member.verified, admin:member.admin, host:false, team:member.team, connected:member.connected, ready:member.ready, queued:member.queued, queueTeam:member.queueTeam, queuePosition:member.queued ? queue.findIndex(item => item.id === member.id) + 1 : null})), state:room.state, chat:room.chat};
    }
    async fetch(request) {
        await this.ready; this.sweep(); const path = new URL(request.url).pathname;
        if (path === '/info' && request.method === 'GET') return json({room:this.publicRoom()});
        if ((path === '/join' || path === '/create') && request.method === 'POST') {this.ensureRoom(); return this.join(await request.json().catch(() => null));}
        if (path === '/socket' && request.method === 'GET') return this.room ? this.upgrade(request, new URL(request.url)) : json({error:'Lobby session expired. Join again.'}, 404);
        return json({error:'Route not found.'}, 404);
    }
    async adminAllowed(member) {
        const auth = member.adminContext;
        if (!auth || !this.env.DB || !member.bonkId) return false;
        // Reuse the site's paired user/admin rules on every privileged action.
        const row = await this.env.DB.prepare(`SELECT a.id FROM admin_sessions s
            JOIN admin_accounts a ON a.id=s.account_id
            JOIN admin_session_identity i ON i.token_hash=s.token_hash
            JOIN user_sessions u ON u.token_hash=i.user_session_hash
            JOIN admin_bonk_links l ON l.account_id=a.id AND l.bonk_id=u.bonk_id
            WHERE s.token_hash=? AND s.expires_at>? AND i.user_session_hash=? AND u.expires_at>?
            AND u.bonk_id=? AND a.id=? AND EXISTS(SELECT 1 FROM admin_credentials c WHERE c.account_id=a.id AND c.code_hash IS NOT NULL)`)
            .bind(auth.adminSessionHash, Date.now(), auth.userSessionHash, Date.now(), member.bonkId, auth.adminAccountId).first();
        return Boolean(row?.id);
    }
    async join(body) {
        if (!validObject(body)) return json({error:'Invalid lobby request.'}, 400);
        const now = Date.now(); this.pruneTickets(now); let member;
        if (body.resumeToken != null) {
            if (typeof body.resumeToken !== 'string' || !/^[a-f0-9]{64}$/.test(body.resumeToken)) return json({error:'Invalid lobby resume token.'}, 403);
            const hash = await digest(body.resumeToken); member = this.room.members.find(item => item.resumeHash === hash);
            if (!member) return json({error:'Your lobby session expired. Join again.'}, 403);
            if (member.bonkId && String(body.identity?.bonkId || '') !== member.bonkId) return json({error:'Sign in with the same Bonk account to resume.'}, 403);
        } else {
            if (this.room.members.length >= MAX_MEMBERS) return json({error:'The football lobby is full (64 members).'}, 409);
            const verified = Boolean(body.identity?.username?.trim() && body.identity.bonkId), name = cleanName(verified ? body.identity.username : body.displayName, 32);
            if (!name) return json({error:'Enter a display name.'}, 400);
            const slot = Array.from({length:MAX_MEMBERS}, (_, i) => i).find(i => !this.room.members.some(item => item.slot === i));
            const joinedAt = Math.max(now, (this.room.lastJoinedAt || 0) + 1); this.room.lastJoinedAt = joinedAt;
            member = {id:crypto.randomUUID(), slot, name, verified, bonkId:verified ? String(body.identity.bonkId) : null, admin:false, adminContext:null, team:0, ready:false, queued:true, queueTeam:0, queueOrder:this.room.nextQueueOrder++, connected:false, disconnectedAt:now, pendingUntil:now + TICKET_TTL, joinedAt};
            this.room.members.push(member);
        }
        const identity = body.identity;
        if (!member.bonkId && identity?.bonkId && typeof identity.username === 'string' && identity.username.trim()) {
            member.bonkId = String(identity.bonkId); member.verified = true; member.name = cleanName(identity.username, 32);
        }
        member.adminContext = identity?.adminSessionHash && identity?.userSessionHash && identity?.adminAccountId ? {adminSessionHash:identity.adminSessionHash, userSessionHash:identity.userSessionHash, adminAccountId:identity.adminAccountId} : null;
        member.admin = await this.adminAllowed(member);
        if (!this.room?.members.includes(member)) return json({error:'Your lobby session expired. Join again.'}, 403);
        const resumeToken = randomToken(); member.resumeHash = await digest(resumeToken);
        if (!this.room?.members.includes(member)) return json({error:'Your lobby session expired. Join again.'}, 403);
        for (const [key, ticket] of this.tickets) if (ticket.memberId === member.id) this.tickets.delete(key);
        const ticket = randomToken(); this.tickets.set(ticket, {memberId:member.id, expires:now + TICKET_TTL});
        if (!member.connected) member.pendingUntil = now + TICKET_TTL;
        this.room.lastActive = now; await this.persist(); await this.scheduleAlarm(); this.broadcastRoom();
        return json({room:this.publicRoom(), member:{id:member.id, resumeToken}, ticket, socketPath:`/api/football/rooms/${FOOTBALL_HUB_ID}/socket?ticket=${ticket}`});
    }
    upgrade(request, url) {
        if (!this.env.ALLOWED_ORIGIN || request.headers.get('Origin') !== this.env.ALLOWED_ORIGIN) return json({error:'Untrusted request origin.'}, 403);
        if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') return json({error:'WebSocket upgrade required.'}, 426);
        const token = url.searchParams.get('ticket') || '', ticket = this.tickets.get(token); this.tickets.delete(token);
        if (!ticket || ticket.expires <= Date.now()) return json({error:'Lobby connection ticket expired or already used.'}, 403);
        const member = this.room.members.find(item => item.id === ticket.memberId); if (!member) return json({error:'Lobby membership expired.'}, 403);
        const pair = new WebSocketPair(), client = pair[0], server = pair[1]; server.accept(); const old = this.connections.get(member.id);
        const connection = {socket:server, memberId:member.id, tokens:100, replenished:Date.now(), lastMessageAt:Date.now(), chatTimes:[], errors:0};
        this.connections.set(member.id, connection); this.inputs[member.slot] = 0; this.inputTimes[member.slot] = 0; this.sequences[member.slot] = -1;
        member.connected = true; member.disconnectedAt = null; member.pendingUntil = 0; if (member.team) this.clearReadiness();
        if (old) {try {old.socket.close(4001, 'Connected in another tab.');} catch {}}
        server.addEventListener('message', event => {void this.message(connection, event.data).catch(() => this.send(server, {type:'error', error:'Unable to process lobby action.'}));});
        server.addEventListener('close', () => this.disconnect(connection)); server.addEventListener('error', () => this.disconnect(connection));
        this.room.lastActive = Date.now(); if (!['playing', 'results'].includes(this.room.status)) this.promoteQueue();
        if (!this.room.modeSelected && this.room.status === 'lobby') this.openModeVote();
        this.send(server, {type:'welcome', memberId:member.id, room:this.publicRoom()}); this.broadcastRoom(); this.ensureTimer(); this.background(this.persist()); this.background(this.scheduleAlarm());
        return new Response(null, {status:101, webSocket:client});
    }
    send(socket, data) {try {socket.send(JSON.stringify(data));} catch {}}
    broadcast(data) {for (const connection of this.connections.values()) this.send(connection.socket, data);}
    broadcastRoom() {if (this.room) this.broadcast({type:'room', room:this.publicRoom()});}
    background(promise) {if (this.ctx.waitUntil) this.ctx.waitUntil(promise.catch(() => {})); else void promise.catch(() => {});}
    async message(connection, raw) {
        if (!this.room || !connection || this.connections.get(connection.memberId) !== connection) return;
        const now = Date.now(); connection.tokens = Math.min(100, connection.tokens + (now - connection.replenished) * .07); connection.replenished = now;
        if (typeof raw !== 'string' || raw.length > MESSAGE_LIMIT || --connection.tokens < 0) {this.closeAbusive(connection); return;}
        let message; try {message = JSON.parse(raw);} catch {this.reject(connection, 'Invalid message.'); return;}
        if (!validObject(message) || typeof message.type !== 'string') {this.reject(connection, 'Invalid message.'); return;}
        connection.lastMessageAt = now; const member = this.room.members.find(item => item.id === connection.memberId); if (!member) return;
        if (message.type === 'modeVote') {
            if (this.room.status !== 'voting' || !this.room.vote || !['balanced', 'rockets'].includes(message.mode) || !this.voteEligible().some(item => item.id === member.id)) {this.reject(connection, 'There is no eligible mode vote for that choice.'); return;}
            if (this.room.vote.deadline <= now) {this.resolveModeVote(); await this.changed(); this.reject(connection, 'That mode vote has ended.'); return;}
            this.room.vote.votes[member.id] = message.mode;
            if (this.voteEligible().every(item => Object.hasOwn(this.room.vote.votes, item.id))) this.resolveModeVote();
            await this.changed(); return;
        }
        if (message.type === 'rebalanceVote') {
            if (!this.room.rebalanceVote || typeof message.yes !== 'boolean' || !this.voteEligible().some(item => item.id === member.id)) {this.reject(connection, 'There is no eligible rebalance vote.'); return;}
            if (this.room.rebalanceVote.deadline <= now) {this.resolveRebalanceVote(true); await this.changed(); this.reject(connection, 'That rebalance vote has ended.'); return;}
            this.room.rebalanceVote.votes[member.id] = message.yes;
            this.resolveRebalanceVote(false); await this.changed(); return;
        }
        if (message.type === 'input') {
            if (!Number.isSafeInteger(message.seq) || message.seq < 0 || message.seq > 2147483647 || !Number.isInteger(message.flags) || message.flags < 0 || message.flags > 63) {this.reject(connection, 'Invalid controls.'); return;}
            if (message.seq <= (this.sequences[member.slot] ?? -1)) return;
            this.sequences[member.slot] = message.seq; this.inputs[member.slot] = this.room.status === 'playing' && member.team ? message.flags : 0; this.inputTimes[member.slot] = now; this.room.lastActive = now; return;
        }
        if (message.type === 'ping') {this.send(connection.socket, {type:'pong', sentAt:typeof message.sentAt === 'number' && Number.isFinite(message.sentAt) ? message.sentAt : null, serverTime:now}); return;}
        if (message.type === 'chat') {
            const text = cleanName(message.text, 180); if (!text || typeof message.text !== 'string' || message.text.length > 180) {this.reject(connection, 'Chat messages must be 1–180 characters.'); return;}
            connection.chatTimes = connection.chatTimes.filter(time => time > now - 10_000); if (connection.chatTimes.length >= 4) {this.reject(connection, 'Please slow down in chat.'); return;}
            connection.chatTimes.push(now); const chat = {type:'chat', id:crypto.randomUUID(), memberId:member.id, name:member.name, text, time:now};
            this.room.chat.push(chat); if (this.room.chat.length > 40) this.room.chat.shift(); this.room.lastActive = now; this.broadcast(chat); this.background(this.persist()); return;
        }
        if (message.type === 'leave') {this.removeMember(member.id, 'Left the lobby.'); await this.changed(); return;}
        if (['team', 'queue', 'spectate'].includes(message.type)) {
            const preference = message.type === 'spectate' ? 0 : message.team ?? 0;
            if (![0, 2, 3].includes(preference)) {this.reject(connection, 'Choose Blue, Red, or any team.'); return;}
            const wasActive = Boolean(member.team), inRockets = this.room.mode === 'rockets' && ['playing', 'results'].includes(this.room.status) && this.room.rockets?.participantIds.includes(member.id);
            this.setQueue(member, !(message.type === 'spectate' || (message.type === 'team' && preference === 0)), preference);
            if (inRockets) this.removeRocketParticipant(member.id);
            else if (wasActive && this.room.status === 'playing') this.openRebalanceVote();
            if (!['playing', 'results'].includes(this.room.status)) this.promoteQueue(); this.updateVoteEligibility(); await this.changed(); return;
        }
        if (message.type === 'ready') {
            if (typeof message.ready !== 'boolean' || this.room.status !== 'lobby' || !this.readyEligible().some(item => item.id === member.id)) {this.reject(connection, 'Participants can ready up after the mode vote.'); return;}
            member.ready = message.ready; if (this.allReady()) this.startMatch(); await this.changed(); return;
        }
        if (!privileged.has(message.type)) {this.reject(connection, 'Unknown lobby action.'); return;}
        const allowed = await this.adminAllowed(member);
        // A kick, reconnect, or logout may occur during D1's asynchronous query.
        if (!this.room || this.connections.get(member.id) !== connection || !this.room.members.includes(member)) return;
        if (!allowed) {member.admin = false; this.reject(connection, 'A current site administrator session is required.'); this.broadcastRoom(); return;}
        member.admin = true;
        if (message.type === 'settings') {
            if (this.room.status !== 'lobby') {this.reject(connection, 'Settings can be changed in the lobby after the mode vote.'); return;}
            const patch = message.settings ?? (Object.hasOwn(message, 'scoreLimit') ? {scoreLimit:message.scoreLimit} : null), result = validateMatchSettings(patch, this.room.settings);
            if (result.error) {this.reject(connection, result.error); return;}
            this.room.settings = {...result.settings, maxPerTeam:TEAM_SIZE}; this.clearReadiness();
            this.room.state = null; this.room.winner = null;
        } else if (message.type === 'assign') {
            const target = this.room.members.find(item => item.id === message.memberId);
            if (this.room.status !== 'lobby' || !target || ![0, 2, 3].includes(message.team) || (message.team && this.room.members.filter(item => item.id !== target.id && item.team === message.team).length >= TEAM_SIZE)) {this.reject(connection, 'Choose a lobby player and a team with space.'); return;}
            if (target.team && target.team !== message.team) this.playerLeaves.add(target.slot);
            const changedTeam = target.team !== message.team;
            target.team = message.team; target.queued = false; target.queueOrder = null; target.queueTeam = message.team; if (changedTeam) this.clearReadiness(); this.promoteQueue();
        } else if (message.type === 'start' || message.type === 'rematch') {
            if (!this.canStart()) {this.reject(connection, 'A connected player can start after the mode vote.'); return;}
            this.startMatch();
        } else if (message.type === 'abort') this.abort('An administrator returned the match to the lobby.');
        else if (message.type === 'kick') {
            if (typeof message.memberId !== 'string' || message.memberId === member.id || !this.room.members.some(item => item.id === message.memberId)) {this.reject(connection, 'Choose another lobby member.'); return;}
            this.removeMember(message.memberId, 'Removed by a site administrator.');
        }
        await this.changed();
    }
    clearReadiness() {for (const member of this.room.members) member.ready = false;}
    setQueue(member, queued, preference) {
        const wasActive = Boolean(member.team);
        if (wasActive) this.playerLeaves.add(member.slot); member.team = 0; member.ready = false; member.queueTeam = preference;
        if (queued && !member.queued) member.queueOrder = this.room.nextQueueOrder++;
        member.queued = queued; if (!queued) member.queueOrder = null;
        this.inputs[member.slot] = 0; if (wasActive) this.clearReadiness();
    }
    promoteQueue() {
        if (this.room.status === 'playing' && this.room.mode === 'balanced' && this.room.balanceDeferred) return this.fillVacancies();
        const selection = balancedTeamAssignments(this.room.members, TEAM_SIZE), assignments = new Map(selection.assignments.map(item => [item.id, item.team]));
        let changed = false;
        for (const member of this.room.members) {
            const team = assignments.get(member.id) || 0;
            if (member.team !== team) {if (member.team) this.playerLeaves.add(member.slot); changed = true;}
            if (team) {member.team = team; member.queued = false; member.queueOrder = null;}
            else if (member.team) {member.team = 0; member.queued = true; member.queueOrder = this.room.nextQueueOrder++;}
        }
        if (changed) this.clearReadiness(); return changed;
    }
    fillVacancies() {
        const counts = {2:this.room.members.filter(member => member.team === 2).length, 3:this.room.members.filter(member => member.team === 3).length}; let changed = false;
        for (const member of this.room.members.filter(item => item.queued && item.connected).sort((a, b) => a.queueOrder - b.queueOrder)) {
            const team = counts[3] <= counts[2] ? 3 : 2; if (counts[team] >= TEAM_SIZE) break;
            member.team = team; member.queued = false; member.queueOrder = null; member.ready = false; counts[team]++; changed = true;
        }
        return changed;
    }
    matchSettings() {return validateMatchSettings({}, this.room.settings).settings;}
    startMatch() {
        this.inputs = []; this.inputTimes = []; this.playerLeaves.clear(); this.tickNumber = 0; this.clearReadiness(); this.room.status = 'playing'; this.room.balanceDeferred = false; this.room.winner = null; this.room.vote = null; this.room.results = null; this.room.rebalanceVote = null;
        if (this.room.mode === 'rockets') {
            const participants = rocketsRoster(this.room.members);
            this.room.rockets = {participantIds:participants.map(member => member.id), records:{}, completedIds:[], attackerId:null, turnTicksLeft:ROCKET_TURN_TICKS, turnIndex:0, totalTurns:participants.length, turnEnded:false};
            this.startRocketTurn();
        } else {this.room.rockets = null; this.promoteQueue(); this.room.state = createState(this.activePlayers(), {settings:this.matchSettings()});}
        this.ensureTimer();
    }
    voteEligible() {return this.room.members.filter(member => member.connected && (member.team || member.queued));}
    publicVote(vote) {
        if (!vote) return null;
        const eligible = new Set(this.voteEligible().map(member => member.id)), votes = Object.fromEntries(Object.entries(vote.votes).filter(([id]) => eligible.has(id)));
        const counts = vote.kind === 'mode' ? {balanced:0, rockets:0} : {yes:0, no:0};
        for (const value of Object.values(votes)) counts[vote.kind === 'mode' ? value : value ? 'yes' : 'no']++;
        return {id:vote.id, deadline:vote.deadline, options:vote.kind === 'mode' ? ['balanced', 'rockets'] : ['yes', 'no'], counts, votes, eligibleCount:eligible.size};
    }
    openModeVote() {
        if (!this.voteEligible().length) {this.stopTimer(); this.room.status = 'lobby'; this.room.vote = null; this.room.results = null; this.room.state = null; this.room.rockets = null; this.room.rebalanceVote = null; this.room.winner = null; this.room.modeSelected = false; return;}
        this.stopTimer(); this.clearReadiness(); this.room.status = 'voting'; this.room.state = null; this.room.winner = null; this.room.results = null; this.room.rockets = null; this.room.rebalanceVote = null;
        this.room.vote = {id:crypto.randomUUID(), kind:'mode', deadline:Date.now() + MODE_VOTE_TTL, votes:{}};
    }
    resolveModeVote() {
        const vote = this.publicVote(this.room.vote); if (!vote) return;
        this.room.mode = vote.counts.rockets > vote.counts.balanced ? 'rockets' : 'balanced'; this.room.modeSelected = true; this.room.vote = null; this.room.status = 'lobby'; this.room.state = null; this.room.winner = null; this.clearReadiness(); this.promoteQueue();
    }
    openRebalanceVote() {
        if (!this.voteEligible().length) {this.abort('The game is waiting for players.'); this.room.modeSelected = false; return;}
        if (!this.room.rebalanceVote) this.room.rebalanceVote = {id:crypto.randomUUID(), kind:'rebalance', deadline:Date.now() + REBALANCE_VOTE_TTL, votes:{}};
    }
    resolveRebalanceVote(timeout) {
        const vote = this.publicVote(this.room.rebalanceVote); if (!vote) return;
        const majority = Math.floor(vote.eligibleCount / 2) + 1;
        if (vote.counts.yes >= majority) {
            this.room.rebalanceVote = null; this.room.balanceDeferred = false; const scores = this.room.state?.scores.slice() || [0, 0, 0, 0];
            if (this.room.state?.fte >= 0 && [2, 3].some(team => scores[team] >= this.room.settings.scoreLimit)) return;
            this.promoteQueue();
            this.room.state = createState(this.activePlayers(), {settings:this.matchSettings()}); this.room.state.scores = scores; this.playerLeaves.clear(); this.inputs = [];
            this.broadcast({type:'notice', text:'Players voted to rebalance. A new kickoff begins.'});
        } else if (timeout || vote.counts.no >= majority || vote.counts.yes + vote.counts.no === vote.eligibleCount) {this.room.rebalanceVote = null; this.room.balanceDeferred = true;}
    }
    updateVoteEligibility() {
        for (const vote of [this.room.vote, this.room.rebalanceVote]) if (vote) {
            const eligible = new Set(this.voteEligible().map(member => member.id)); for (const id of Object.keys(vote.votes)) if (!eligible.has(id)) delete vote.votes[id];
        }
        if (!this.voteEligible().length) {
            if (this.room.status === 'voting') {this.room.status = 'lobby'; this.room.vote = null; this.room.modeSelected = false;}
            this.room.rebalanceVote = null; return;
        }
        if (this.room.status === 'lobby' && !this.room.modeSelected) this.openModeVote();
        if (this.room.vote && this.voteEligible().every(member => Object.hasOwn(this.room.vote.votes, member.id))) this.resolveModeVote();
        if (this.room.rebalanceVote) this.resolveRebalanceVote(false);
    }
    publicRockets() {
        const rockets = this.room?.rockets; if (!rockets) return null;
        const participants = this.room.members.filter(member => rockets.participantIds.includes(member.id));
        return {participantIds:[...rockets.participantIds], attackerId:rockets.attackerId, turnTicksLeft:rockets.turnTicksLeft, turnIndex:rockets.turnIndex, totalTurns:rockets.totalTurns, unit:'m/s', leaderboard:rocketsLeaderboard(participants, rockets.records)};
    }
    startRocketTurn() {
        const rockets = this.room.rockets; if (!rockets) return;
        const id = rockets.participantIds.find(candidate => !rockets.completedIds.includes(candidate));
        if (!id) {this.finishGame(null); return;}
        rockets.attackerId = id; rockets.turnTicksLeft = ROCKET_TURN_TICKS; rockets.turnIndex = rockets.completedIds.length + 1; rockets.totalTurns = rockets.participantIds.length; rockets.turnEnded = false;
        const defenders = rockets.participantIds.filter(candidate => candidate !== id).slice(0, TEAM_SIZE);
        for (const member of this.room.members) {
            if (!rockets.participantIds.includes(member.id)) continue;
            member.team = member.id === id ? 3 : defenders.includes(member.id) ? 2 : 0;
            member.queued = !member.team; if (member.queued && !member.queueOrder) member.queueOrder = this.room.nextQueueOrder++;
            if (!member.queued) member.queueOrder = null;
        }
        this.inputs = []; this.inputTimes = []; this.playerLeaves.clear(); this.room.state = createState(this.activePlayers(), {settings:this.matchSettings()});
    }
    completeRocketTurn() {
        const rockets = this.room.rockets; if (!rockets) return;
        if (!rockets.records[rockets.attackerId]) rockets.records[rockets.attackerId] = {scored:false, speed:null, timeTicks:ROCKET_TURN_TICKS - rockets.turnTicksLeft};
        if (!rockets.completedIds.includes(rockets.attackerId)) rockets.completedIds.push(rockets.attackerId);
        this.startRocketTurn();
    }
    removeRocketParticipant(id) {
        const rockets = this.room.rockets; if (!rockets || !rockets.participantIds.includes(id)) return;
        const wasAttacker = rockets.attackerId === id; rockets.participantIds = rockets.participantIds.filter(candidate => candidate !== id); rockets.completedIds = rockets.completedIds.filter(candidate => candidate !== id); delete rockets.records[id]; rockets.totalTurns = rockets.participantIds.length; rockets.turnIndex = Math.min(rockets.completedIds.length + 1, rockets.totalTurns);
        if (this.room.status === 'results') {
            const board = this.publicRockets().leaderboard, winnerId = board.find(row => row.scored)?.id || null;
            this.room.results.leaderboard = board; this.room.results.winnerId = winnerId;
            if (this.room.lastResult?.mode === 'rockets') {this.room.lastResult.leaderboard = board; this.room.lastResult.winnerId = winnerId;}
            return;
        }
        if (!rockets.participantIds.length) {this.abort('The game is waiting for players.'); this.room.modeSelected = false;}
        else if (wasAttacker) this.startRocketTurn();
    }
    finishGame(winner) {
        this.room.winner = winner; const board = this.publicRockets()?.leaderboard || [];
        this.room.results = {mode:this.room.mode, winner, winnerId:this.room.mode === 'rockets' ? board.find(row => row.scored)?.id || null : null, scores:this.room.state?.scores.slice() || [0, 0, 0, 0], leaderboard:board, unit:'m/s', deadline:Date.now() + RESULTS_TTL};
        this.room.lastResult = {...this.room.results, finishedAt:Date.now()}; this.room.status = 'results'; this.inputs = []; this.clearReadiness(); this.room.rebalanceVote = null; this.stopTimer(); this.broadcastRoom(); this.background(this.persist()); this.background(this.scheduleAlarm());
    }
    systemChat(text) {
        const chat = {type:'chat', id:crypto.randomUUID(), memberId:null, name:'Football', text, time:Date.now(), system:true}; this.room.chat.push(chat); if (this.room.chat.length > 40) this.room.chat.shift(); this.broadcast(chat);
    }
    activePlayers() {const players = []; for (const member of this.room.members) if (member.team === 2 || member.team === 3) players[member.slot] = {id:member.slot, team:member.team, name:member.name}; return players;}
    reject(connection, error) {this.send(connection.socket, {type:'error', error}); if (++connection.errors > 40) this.closeAbusive(connection);}
    closeAbusive(connection) {try {connection.socket.close(1008, 'Lobby message limit exceeded.');} catch {} this.disconnect(connection);}
    disconnect(connection) {
        if (this.connections.get(connection.memberId) !== connection) return; this.connections.delete(connection.memberId);
        const member = this.room?.members.find(item => item.id === connection.memberId); if (!member) return;
        this.inputs[member.slot] = 0; member.connected = false; member.disconnectedAt = Date.now(); member.pendingUntil = 0;
        if (this.room.mode === 'rockets' && ['playing', 'results'].includes(this.room.status) && this.room.rockets?.participantIds.includes(member.id)) {
            // Queue first: a retained resumable member must not leave a ghost
            // disc when the next attacker recreates the authoritative state.
            this.setQueue(member, true, 0); this.removeRocketParticipant(member.id);
        } else if (member.team) this.clearReadiness();
        this.updateVoteEligibility();
        this.broadcastRoom(); this.background(this.persist()); this.background(this.scheduleAlarm());
    }
    removeMember(memberId, reason) {
        const member = this.room.members.find(item => item.id === memberId); if (!member) return;
        const connection = this.connections.get(memberId); this.connections.delete(memberId);
        if (connection) {this.send(connection.socket, {type:'removed', reason}); try {connection.socket.close(4002, reason);} catch {}}
        for (const [key, ticket] of this.tickets) if (ticket.memberId === memberId) this.tickets.delete(key);
        this.inputs[member.slot] = 0; this.sequences[member.slot] = -1; this.playerLeaves.add(member.slot); this.room.members = this.room.members.filter(item => item.id !== memberId);
        if (member.team) this.clearReadiness();
        if (this.room.status === 'playing') {
            if (this.room.mode === 'rockets') this.removeRocketParticipant(memberId);
            else if (member.team) this.openRebalanceVote();
        } else if (this.room.status === 'results' && this.room.mode === 'rockets') this.removeRocketParticipant(memberId);
        if (!['playing', 'results'].includes(this.room.status)) this.promoteQueue(); this.updateVoteEligibility();
    }
    abort(reason) {this.room.status = 'lobby'; this.room.state = null; this.room.winner = null; this.room.vote = null; this.room.results = null; this.room.rockets = null; this.room.rebalanceVote = null; this.inputs = []; this.stopTimer(); this.clearReadiness(); this.promoteQueue(); this.broadcast({type:'notice', text:reason});}
    async changed() {this.room.lastActive = Date.now(); this.broadcastRoom(); await this.persist(); await this.scheduleAlarm();}
    pruneTickets(now) {for (const [key, ticket] of this.tickets) if (ticket.expires <= now) this.tickets.delete(key);}
    sweep() {
        if (!this.room) return; const now = Date.now(); this.pruneTickets(now);
        if (now - this.room.lastActive >= IDLE_TTL) {this.background(this.clearIdle()); return;}
        for (const connection of [...this.connections.values()]) if (now - connection.lastMessageAt >= HEARTBEAT_TTL) {try {connection.socket.close(4004, 'Lobby connection timed out.');} catch {} this.disconnect(connection);}
        let changed = false;
        for (const member of [...this.room.members]) if (!member.connected && now >= (member.pendingUntil || (member.disconnectedAt || now) + RESUME_GRACE)) {this.removeMember(member.id, 'Lobby session expired.'); changed = true;}
        if (this.room.status === 'results' && this.room.results?.deadline <= now) {this.promoteQueue(); this.openModeVote(); changed = true;}
        if (this.room.status === 'voting' && this.room.vote?.deadline <= now) {if (this.voteEligible().length) this.resolveModeVote(); else {this.room.status = 'lobby'; this.room.vote = null; this.room.modeSelected = false;} changed = true;}
        if (this.room.rebalanceVote?.deadline <= now) {this.resolveRebalanceVote(true); changed = true;}
        if (changed) {this.broadcastRoom(); this.background(this.persist());}
    }
    ensureTimer() {
        if (!this.timer && this.room?.status === 'playing') {this.lastPumpAt = Date.now(); this.accumulator = 0; this.timer = setInterval(() => this.pump(), STEP_MS);}
    }
    stopTimer() {if (this.timer) clearInterval(this.timer); this.timer = null; this.lastPumpAt = 0; this.accumulator = 0;}
    pump(now = Date.now()) {
        if (this.room?.status !== 'playing') {this.stopTimer(); return 0;}
        if (!this.lastPumpAt) {this.lastPumpAt = now; return 0;}
        // Timers can arrive late under load. Keep each physics step exactly
        // 1/30s while recovering ordinary delays; never replay a long dormancy.
        const elapsed = Math.max(0, Math.min(MAX_PUMP_DELTA, now - this.lastPumpAt)); this.lastPumpAt = now; this.accumulator += elapsed;
        let steps = 0;
        while (this.room?.status === 'playing' && this.accumulator + 1e-7 >= STEP_MS && steps < MAX_CATCHUP_STEPS) {this.accumulator -= STEP_MS; this.tick(); steps++;}
        return steps;
    }
    tick() {
        this.sweep(); if (!this.room || this.room.status !== 'playing') {this.stopTimer(); return;}
        const state = this.room.state;
        if (this.room.mode === 'rockets' && this.room.rockets?.turnEnded && state.fte === 0) {
            this.completeRocketTurn(); this.broadcastRoom(); this.background(this.persist()); return;
        }
        if (state.fte === 0) {
            if ([2, 3].some(team => state.scores[team] >= this.room.settings.scoreLimit)) {
                this.finishGame(state.scores[2] >= this.room.settings.scoreLimit ? 2 : 3); return;
            }
            this.promoteQueue(); this.room.state = createState(this.activePlayers(), {settings:this.matchSettings()}); this.room.state.scores = state.scores.slice(); this.playerLeaves.clear();
        } else {
            const deadline = Date.now() - 1000; this.inputs.forEach((flags, slot) => {if ((this.inputTimes[slot] || 0) < deadline) this.inputs[slot] = 0;});
            const controls = this.inputs.map(flags => ({left:Boolean(flags & 1), right:Boolean(flags & 2), up:Boolean(flags & 4), down:Boolean(flags & 8), action:Boolean(flags & 16), action2:Boolean(flags & 32)}));
            try {this.room.state = this.physics.step(state, controls, {playersLeft:[...this.playerLeaves]}); this.playerLeaves.clear();}
            catch {this.abort('The match stopped. Players can ready up again.'); this.broadcastRoom(); this.background(this.persist()); return;}
        }
        if (this.room.mode === 'rockets' && this.room.rockets && !this.room.rockets.turnEnded && state.ftu === -1 && state.fte === -1) {
            const rockets = this.room.rockets; rockets.turnTicksLeft = Math.max(0, rockets.turnTicksLeft - 1);
            const speed = goalSpeed(state, this.room.state);
            if (speed !== null) {
                rockets.turnEnded = true;
                if (this.room.state.lscr === 3) {
                    rockets.records[rockets.attackerId] = {scored:true, speed, timeTicks:ROCKET_TURN_TICKS - rockets.turnTicksLeft};
                    const attacker = this.room.members.find(member => member.id === rockets.attackerId); if (attacker) this.systemChat(`${attacker.name} reached ${speed.toFixed(1)} m/s.`);
                }
            } else if (!rockets.turnTicksLeft) {this.completeRocketTurn(); this.broadcastRoom(); this.background(this.persist()); return;}
        }
        this.tickNumber++; if (this.connections.size) this.room.lastActive = Date.now();
        if (this.tickNumber % 2 === 0) {
            const frame = {type:'snapshot', tick:this.tickNumber, serverTime:Date.now(), status:this.room.status, mode:this.room.mode, winner:this.room.winner, rockets:this.publicRockets(), rebalanceVote:this.publicVote(this.room.rebalanceVote), state:this.room.state, inputs:Array.from({length:MAX_MEMBERS}, (_, slot) => this.inputs[slot] || 0)};
            for (const connection of this.connections.values()) {const member = this.room.members.find(item => item.id === connection.memberId); this.send(connection.socket, {...frame, ackSeq:this.sequences[member?.slot] ?? -1});}
        }
        if (state.fte === 0) this.broadcastRoom(); if (Date.now() - this.lastSaved >= 2000) this.background(this.persist());
    }
    persist() {this.lastSaved = Date.now(); const saved = this.room ? JSON.parse(JSON.stringify({version:3, room:this.room, tick:this.tickNumber})) : null; this.persistChain = this.persistChain.catch(() => {}).then(() => saved ? this.ctx.storage.put('checkpoint', saved) : this.ctx.storage.delete('checkpoint')); return this.persistChain;}
    async scheduleAlarm() {
        if (!this.room || (!this.room.members.length && !this.room.chat.length && !this.room.state && !this.room.vote && !this.room.results)) {if (this.ctx.storage.deleteAlarm) await this.ctx.storage.deleteAlarm(); return;}
        const deadlines = [this.room.lastActive + IDLE_TTL, ...[this.room.vote, this.room.rebalanceVote, this.room.results].filter(Boolean).map(phase => phase.deadline), ...[...this.connections.values()].map(connection => connection.lastMessageAt + HEARTBEAT_TTL), ...this.room.members.filter(member => !member.connected).map(member => member.pendingUntil || (member.disconnectedAt || Date.now()) + RESUME_GRACE)];
        await this.ctx.storage.setAlarm(Math.max(Date.now() + 100, Math.min(...deadlines)));
    }
    async alarm() {await this.ready; this.sweep(); if (this.room) {await this.persist(); await this.scheduleAlarm();}}
    async clearIdle() {
        this.stopTimer(); for (const connection of this.connections.values()) {try {connection.socket.close(4003, 'Lobby session expired.');} catch {}}
        this.connections.clear(); this.tickets.clear(); this.inputs = []; this.ensureRoom();
        this.room.members = []; this.room.chat = []; this.room.state = null; this.room.status = 'lobby'; this.room.winner = null; this.room.vote = null; this.room.modeSelected = false; this.room.results = null; this.room.rockets = null; this.room.rebalanceVote = null; this.room.lastActive = Date.now();
        await this.persist(); if (this.ctx.storage.deleteAlarm) await this.ctx.storage.deleteAlarm();
    }
}
export const FOOTBALL_ROOM_LIMITS = Object.freeze({TICKET_TTL, RESUME_GRACE, HEARTBEAT_TTL, IDLE_TTL, MODE_VOTE_TTL, REBALANCE_VOTE_TTL, RESULTS_TTL, MAX_MEMBERS, TEAM_SIZE, MESSAGE_LIMIT});
