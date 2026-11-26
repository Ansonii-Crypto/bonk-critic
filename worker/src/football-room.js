import {FootballPhysics, createState} from '../../football/physics.js';

const TICKET_TTL = 30_000, RESUME_GRACE = 15_000, HEARTBEAT_TTL = 15_000, IDLE_TTL = 30 * 60_000;
const MAX_MEMBERS = 16, TEAM_SIZE = 4, MESSAGE_LIMIT = 1024;
const validObject = value => value && typeof value === 'object' && !Array.isArray(value);
const randomToken = () => crypto.randomUUID().replaceAll('-', '') + crypto.randomUUID().replaceAll('-', '');
const json = (data, status = 200) => new Response(JSON.stringify(data), {status, headers:{'Content-Type':'application/json', 'Cache-Control':'no-store'}});
const cleanName = (value, length) => typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, length) : '';
async function digest(token) {
    return [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token)))].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

export class FootballRoom {
    constructor(ctx, env) {
        this.ctx = ctx; this.env = env; this.room = null;
        this.connections = new Map(); this.tickets = new Map(); this.inputs = []; this.inputTimes = []; this.sequences = []; this.playerLeaves = new Set();
        this.physics = new FootballPhysics(); this.timer = null; this.tickNumber = 0; this.lastSaved = 0;
        this.persistChain = Promise.resolve();
        this.ready = ctx.blockConcurrencyWhile(async () => {
            const saved = await ctx.storage.get('checkpoint');
            if (!saved || saved.version !== 1) return;
            this.room = saved.room; this.tickNumber = saved.tick || 0;
            for (const member of this.room.members) {
                member.connected = false;
                member.disconnectedAt = member.disconnectedAt || Date.now();
                member.pendingUntil = 0;
            }
            if (Date.now() - this.room.lastActive >= IDLE_TTL) {await this.destroy(); return;}
            // Inputs are intentionally never restored: a dropped connection must
            // release all controls even if its previous process stopped abruptly.
            this.sweep(); this.ensureTimer(); await this.scheduleAlarm();
        });
    }

    publicRoom() {
        const room = this.room;
        if (!room) return null;
        return {id:room.id, name:room.name, hostId:room.hostId, status:room.status, settings:{...room.settings}, winner:room.winner,
            members:room.members.map(member => ({id:member.id, slot:member.slot, name:member.name, verified:member.verified, team:member.team, connected:member.connected, host:member.id === room.hostId})),
            state:room.state, chat:room.chat || []};
    }

    async fetch(request) {
        await this.ready;
        const url = new URL(request.url);
        this.sweep();
        if (url.pathname === '/create' && request.method === 'POST') {
            if (this.room) return json({error:'Room already exists.'}, 409);
            const body = await request.json().catch(() => null);
            if (!validObject(body) || !/^[A-Za-z0-9_-]{16}$/.test(body.roomId || '')) return json({error:'Invalid room request.'}, 400);
            const name = cleanName(body.name, 48);
            if (!name) return json({error:'Enter a room name.'}, 400);
            this.room = {id:body.roomId, name, hostId:null, status:'lobby', settings:{scoreLimit:3, maxPerTeam:TEAM_SIZE}, state:null, winner:null, members:[], chat:[], createdAt:Date.now(), lastActive:Date.now()};
            const result = await this.join(body, true);
            if (result.status >= 400) {await this.destroy(); return result;}
            return result;
        }
        if (!this.room) return json({error:'Room not found or expired.'}, 404);
        if (url.pathname === '/info' && request.method === 'GET') return json({room:this.publicRoom()});
        if (url.pathname === '/join' && request.method === 'POST') return this.join(await request.json().catch(() => null));
        if (url.pathname === '/socket' && request.method === 'GET') return this.upgrade(request, url);
        return json({error:'Route not found.'}, 404);
    }

    async join(body, creating = false) {
        if (!validObject(body)) return json({error:'Invalid room request.'}, 400);
        const now = Date.now();
        this.pruneTickets(now);
        let member;
        if (body.resumeToken != null) {
            if (typeof body.resumeToken !== 'string' || !/^[a-f0-9]{64}$/.test(body.resumeToken)) return json({error:'Invalid room resume token.'}, 403);
            const resumeHash = await digest(body.resumeToken);
            member = this.room.members.find(item => item.resumeHash === resumeHash);
            if (!member) return json({error:'Your room session expired. Join again.'}, 403);
            if (member.bonkId && String(body.identity?.bonkId || '') !== member.bonkId) return json({error:'Sign in with the same Bonk account to resume.'}, 403);
        } else {
            if (this.room.members.length >= MAX_MEMBERS) return json({error:'This room is full (16 members).'}, 409);
            const verified = Boolean(body.identity && typeof body.identity.username === 'string' && body.identity.username.trim() && body.identity.bonkId);
            const name = cleanName(verified ? body.identity.username : body.displayName, 32);
            if (!name) return json({error:'Enter a display name.'}, 400);
            const slot = Array.from({length:MAX_MEMBERS}, (_, i) => i).find(i => !this.room.members.some(item => item.slot === i));
            member = {id:crypto.randomUUID(), slot, name, verified, bonkId:verified ? String(body.identity.bonkId) : null, team:0, connected:false, disconnectedAt:now, pendingUntil:now + TICKET_TTL, joinedAt:now};
            this.room.members.push(member);
            if (creating || !this.room.hostId) this.room.hostId = member.id;
        }
        // Rotate on every join: a previous reconnect credential cannot be replayed
        // after a successful resume. Tickets themselves are always one-use.
        const resumeToken = randomToken(); member.resumeHash = await digest(resumeToken);
        for (const [key, ticket] of this.tickets) if (ticket.memberId === member.id) this.tickets.delete(key);
        const ticket = randomToken();
        this.tickets.set(ticket, {memberId:member.id, expires:now + TICKET_TTL});
        if (!member.connected) member.pendingUntil = now + TICKET_TTL;
        this.room.lastActive = now;
        await this.persist(); await this.scheduleAlarm(); this.broadcastRoom();
        return json({room:this.publicRoom(), member:{id:member.id, resumeToken}, ticket, socketPath:`/api/football/rooms/${this.room.id}/socket?ticket=${ticket}`}, creating ? 201 : 200);
    }

    upgrade(request, url) {
        if (!this.env.ALLOWED_ORIGIN || request.headers.get('Origin') !== this.env.ALLOWED_ORIGIN) return json({error:'Untrusted request origin.'}, 403);
        if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') return json({error:'WebSocket upgrade required.'}, 426);
        const token = url.searchParams.get('ticket') || '';
        const ticket = this.tickets.get(token); this.tickets.delete(token);
        if (!ticket || ticket.expires <= Date.now()) return json({error:'Room connection ticket expired or already used.'}, 403);
        const member = this.room.members.find(item => item.id === ticket.memberId);
        if (!member) return json({error:'Room membership expired.'}, 403);
        const pair = new WebSocketPair(), client = pair[0], server = pair[1];
        server.accept();
        const old = this.connections.get(member.id);
        // Bind messages to the socket's server-owned member ID. No message may
        // choose another player, write simulation state, or submit a score.
        const connection = {socket:server, memberId:member.id, tokens:100, replenished:Date.now(), lastMessageAt:Date.now(), chatTimes:[], errors:0};
        this.connections.set(member.id, connection);
        this.inputs[member.slot] = 0; this.inputTimes[member.slot] = 0; this.sequences[member.slot] = -1;
        member.connected = true; member.disconnectedAt = null; member.pendingUntil = 0;
        if (old) {try {old.socket.close(4001, 'Connected in another tab.');} catch {}}
        server.addEventListener('message', event => {void this.message(connection, event.data).catch(() => this.send(server, {type:'error', error:'Unable to process room action.'}));});
        server.addEventListener('close', () => this.disconnect(connection));
        server.addEventListener('error', () => this.disconnect(connection));
        this.room.lastActive = Date.now();
        this.send(server, {type:'welcome', memberId:member.id, room:this.publicRoom()});
        this.broadcastRoom(); this.ensureTimer(); this.background(this.persist()); this.background(this.scheduleAlarm());
        return new Response(null, {status:101, webSocket:client});
    }

    send(socket, data) {try {socket.send(JSON.stringify(data));} catch {}}
    broadcast(data) {for (const connection of this.connections.values()) this.send(connection.socket, data);}
    broadcastRoom() {if (this.room) this.broadcast({type:'room', room:this.publicRoom()});}
    background(promise) {if (this.ctx.waitUntil) this.ctx.waitUntil(promise.catch(() => {})); else void promise.catch(() => {});}

    async message(connection, raw) {
        if (!this.room || this.connections.get(connection.memberId) !== connection) return;
        const now = Date.now();
        connection.tokens = Math.min(100, connection.tokens + (now - connection.replenished) * .07); connection.replenished = now;
        if (typeof raw !== 'string' || raw.length > MESSAGE_LIMIT || --connection.tokens < 0) {this.closeAbusive(connection); return;}
        let message; try {message = JSON.parse(raw);} catch {this.reject(connection, 'Invalid message.'); return;}
        if (!validObject(message) || typeof message.type !== 'string') {this.reject(connection, 'Invalid message.'); return;}
        connection.lastMessageAt = now;
        const member = this.room.members.find(item => item.id === connection.memberId);
        if (!member) return;
        if (message.type === 'input') {
            if (!Number.isSafeInteger(message.seq) || message.seq < 0 || message.seq > 2147483647 || !Number.isInteger(message.flags) || message.flags < 0 || message.flags > 63) {this.reject(connection, 'Invalid controls.'); return;}
            if (message.seq <= (this.sequences[member.slot] ?? -1)) return;
            this.sequences[member.slot] = message.seq;
            this.inputs[member.slot] = this.room.status === 'playing' && member.team !== 0 ? message.flags : 0;
            this.inputTimes[member.slot] = now;
            this.room.lastActive = now; return;
        }
        if (message.type === 'ping') {this.send(connection.socket, {type:'pong', sentAt:typeof message.sentAt === 'number' && Number.isFinite(message.sentAt) ? message.sentAt : null, serverTime:now}); return;}
        if (message.type === 'chat') {
            const text = cleanName(message.text, 180);
            if (!text || typeof message.text !== 'string' || message.text.length > 180) {this.reject(connection, 'Chat messages must be 1–180 characters.'); return;}
            connection.chatTimes = connection.chatTimes.filter(time => time > now - 10_000);
            if (connection.chatTimes.length >= 4) {this.reject(connection, 'Please slow down in chat.'); return;}
            connection.chatTimes.push(now);
            const chat = {type:'chat', id:crypto.randomUUID(), memberId:member.id, name:member.name, text, time:now};
            this.room.chat.push(chat); if (this.room.chat.length > 40) this.room.chat.shift();
            this.room.lastActive = now; this.broadcast(chat); this.background(this.persist()); return;
        }
        if (message.type === 'leave') {this.removeMember(member.id, 'Left the room.'); await this.changed(); return;}
        if (message.type === 'team') {
            if (this.room.status === 'playing') {this.reject(connection, 'Teams can be changed in the lobby.'); return;}
            if (!this.assignTeam(member, message.team)) {this.reject(connection, 'Invalid team or that team already has four players.'); return;}
            await this.changed(); return;
        }
        if (this.room.hostId !== member.id) {this.reject(connection, 'Only the room host can do that.'); return;}
        if (message.type === 'assign') {
            const target = this.room.members.find(item => item.id === message.memberId);
            if (this.room.status === 'playing' || !target || !this.assignTeam(target, message.team)) {this.reject(connection, 'Choose a lobby member and a team with space.'); return;}
        } else if (message.type === 'settings') {
            if (this.room.status === 'playing' || !Number.isInteger(message.scoreLimit) || message.scoreLimit < 1 || message.scoreLimit > 9) {this.reject(connection, 'Choose a score limit from 1 to 9 in the lobby.'); return;}
            this.room.settings.scoreLimit = message.scoreLimit;
        } else if (message.type === 'start' || message.type === 'rematch') {
            if (this.room.status === 'playing' || (message.type === 'rematch' && this.room.status !== 'finished')) {this.reject(connection, 'A match is already running or no rematch is available.'); return;}
            if (![2, 3].every(team => this.room.members.some(item => item.team === team && item.connected))) {this.reject(connection, 'Both teams need a connected player to start.'); return;}
            // Offline reservations do not enter an active match. They may resume as
            // spectators, then take a team place after the match returns to the lobby.
            for (const item of this.room.members) if (!item.connected) item.team = 0;
            this.inputs = []; this.inputTimes = []; this.sequences = []; this.playerLeaves.clear(); this.tickNumber = 0;
            this.room.state = createState(this.activePlayers()); this.room.status = 'playing'; this.room.winner = null; this.ensureTimer();
        } else if (message.type === 'abort') {
            this.abort('The host returned the room to the lobby.');
        } else if (message.type === 'kick') {
            if (typeof message.memberId !== 'string' || message.memberId === member.id || !this.room.members.some(item => item.id === message.memberId)) {this.reject(connection, 'Choose another room member.'); return;}
            this.removeMember(message.memberId, 'Removed by the room host.');
        } else {this.reject(connection, 'Unknown room action.'); return;}
        await this.changed();
    }

    assignTeam(member, team) {
        if (![0, 2, 3].includes(team)) return false;
        if (team !== 0 && this.room.members.filter(item => item.id !== member.id && item.team === team).length >= TEAM_SIZE) return false;
        member.team = team; this.inputs[member.slot] = 0; return true;
    }
    reject(connection, error) {this.send(connection.socket, {type:'error', error}); if (++connection.errors > 40) this.closeAbusive(connection);}
    closeAbusive(connection) {try {connection.socket.close(1008, 'Room message limit exceeded.');} catch {} this.disconnect(connection);}
    activePlayers() {
        const players = [];
        for (const member of this.room.members) if (member.team === 2 || member.team === 3) players[member.slot] = {id:member.slot, team:member.team, name:member.name};
        return players;
    }

    disconnect(connection) {
        if (this.connections.get(connection.memberId) !== connection) return;
        this.connections.delete(connection.memberId);
        const member = this.room?.members.find(item => item.id === connection.memberId);
        if (!member) return;
        this.inputs[member.slot] = 0; member.connected = false; member.disconnectedAt = Date.now(); member.pendingUntil = 0;
        this.broadcastRoom(); this.background(this.persist()); this.background(this.scheduleAlarm());
    }

    removeMember(memberId, reason) {
        const member = this.room.members.find(item => item.id === memberId);
        if (!member) return;
        const connection = this.connections.get(memberId); this.connections.delete(memberId);
        if (connection) {this.send(connection.socket, {type:'removed', reason}); try {connection.socket.close(4002, reason);} catch {}}
        for (const [key, ticket] of this.tickets) if (ticket.memberId === memberId) this.tickets.delete(key);
        this.inputs[member.slot] = 0; this.sequences[member.slot] = -1; this.playerLeaves.add(member.slot);
        this.room.members = this.room.members.filter(item => item.id !== memberId);
        if (this.room.hostId === memberId) this.room.hostId = this.room.members.find(item => item.connected)?.id || this.room.members[0]?.id || null;
        if (this.room.status === 'playing' && ![2, 3].every(team => this.room.members.some(item => item.team === team))) this.abort('A team has no players remaining.');
    }

    abort(reason) {
        this.room.status = 'lobby'; this.room.state = null; this.room.winner = null; this.inputs = [];
        this.stopTimer(); this.broadcast({type:'notice', text:reason});
    }
    async changed() {this.room.lastActive = Date.now(); this.broadcastRoom(); await this.persist(); await this.scheduleAlarm();}

    pruneTickets(now) {for (const [key, ticket] of this.tickets) if (ticket.expires <= now) this.tickets.delete(key);}
    sweep() {
        if (!this.room) return;
        const now = Date.now(); this.pruneTickets(now);
        if (now - this.room.lastActive >= IDLE_TTL) {this.background(this.destroy()); return;}
        for (const connection of [...this.connections.values()]) {
            if (now - connection.lastMessageAt >= HEARTBEAT_TTL) {
                try {connection.socket.close(4004, 'Room connection timed out.');} catch {}
                this.disconnect(connection);
            }
        }
        let changed = false;
        for (const member of [...this.room.members]) {
            if (!member.connected && now >= (member.pendingUntil || (member.disconnectedAt || now) + RESUME_GRACE)) {this.removeMember(member.id, 'Room session expired.'); changed = true;}
        }
        if (changed) {this.broadcastRoom(); this.background(this.persist());}
    }

    ensureTimer() {if (!this.timer && this.room?.status === 'playing') this.timer = setInterval(() => this.tick(), 1000 / 30);}
    stopTimer() {if (this.timer) clearInterval(this.timer); this.timer = null;}
    tick() {
        this.sweep();
        if (!this.room || this.room.status !== 'playing') {this.stopTimer(); return;}
        const state = this.room.state;
        // Bonk resolves the winning score at celebration frame zero, before the
        // football physics step recreates the next kickoff and clears that phase.
        if (state.fte === 0 && [2, 3].some(team => state.scores[team] >= this.room.settings.scoreLimit)) {
            this.room.winner = state.scores[2] >= this.room.settings.scoreLimit ? 2 : 3; this.room.status = 'finished';
            this.inputs = []; this.stopTimer(); this.broadcastRoom(); this.background(this.persist()); return;
        }
        const inputDeadline = Date.now() - 1000;
        this.inputs.forEach((flags, slot) => {if ((this.inputTimes[slot] || 0) < inputDeadline) this.inputs[slot] = 0;});
        const controls = this.inputs.map(flags => ({left:Boolean(flags & 1), right:Boolean(flags & 2), up:Boolean(flags & 4), down:Boolean(flags & 8), action:Boolean(flags & 16), action2:Boolean(flags & 32)}));
        try {this.room.state = this.physics.step(state, controls, {playersLeft:[...this.playerLeaves]}); this.playerLeaves.clear();}
        catch {this.abort('The match stopped. The host can start again.'); this.broadcastRoom(); this.background(this.persist()); return;}
        this.tickNumber++;
        if (this.connections.size) this.room.lastActive = Date.now();
        if (this.tickNumber % 2 === 0) {
            const snapshot = {type:'snapshot', tick:this.tickNumber, serverTime:Date.now(), status:this.room.status, winner:this.room.winner, state:this.room.state, inputs:Array.from({length:MAX_MEMBERS}, (_, slot) => this.inputs[slot] || 0)};
            for (const connection of this.connections.values()) {
                const member = this.room.members.find(item => item.id === connection.memberId);
                this.send(connection.socket, {...snapshot, ackSeq:this.sequences[member?.slot] ?? -1});
            }
        }
        if (Date.now() - this.lastSaved >= 2000) this.background(this.persist());
    }

    persist() {
        this.lastSaved = Date.now();
        // Capture before awaiting storage so a later frame cannot mutate a queued
        // checkpoint or revive data after an idle-room deletion.
        const saved = this.room ? JSON.parse(JSON.stringify({version:1, room:this.room, tick:this.tickNumber})) : null;
        this.persistChain = this.persistChain.catch(() => {}).then(() => saved ? this.ctx.storage.put('checkpoint', saved) : this.ctx.storage.delete('checkpoint'));
        return this.persistChain;
    }
    async scheduleAlarm() {
        if (!this.room) return;
        const deadlines = [this.room.lastActive + IDLE_TTL,
            ...[...this.connections.values()].map(connection => connection.lastMessageAt + HEARTBEAT_TTL),
            ...this.room.members.filter(member => !member.connected).map(member => member.pendingUntil || (member.disconnectedAt || Date.now()) + RESUME_GRACE)];
        await this.ctx.storage.setAlarm(Math.max(Date.now() + 100, Math.min(...deadlines)));
    }
    async alarm() {await this.ready; this.sweep(); if (this.room) {await this.persist(); await this.scheduleAlarm();}}
    async destroy() {
        this.stopTimer();
        for (const connection of this.connections.values()) {try {connection.socket.close(4003, 'Room expired.');} catch {}}
        this.connections.clear(); this.tickets.clear(); this.inputs = []; this.room = null;
        await this.persist(); if (this.ctx.storage.deleteAlarm) await this.ctx.storage.deleteAlarm();
    }
}

export const FOOTBALL_ROOM_LIMITS = Object.freeze({TICKET_TTL, RESUME_GRACE, HEARTBEAT_TTL, IDLE_TTL, MAX_MEMBERS, TEAM_SIZE, MESSAGE_LIMIT});
