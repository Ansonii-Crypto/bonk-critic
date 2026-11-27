import assert from 'node:assert/strict';
import test from 'node:test';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import {FootballRoom, FOOTBALL_ROOM_LIMITS as LIMITS} from '../src/football-room.js';
import {footballApi, FOOTBALL_HUB_ID as ID} from '../src/football-api.js';
import worker from '../src/index.js';
import {getPitchGeometry} from '../../football/physics.js';

const origin = 'https://bonk-critic.com', NativeResponse = globalThis.Response;
globalThis.Response = class extends NativeResponse {
    constructor(body, init = {}) {if (init.status === 101) {super(null, {status:200}); Object.defineProperty(this, 'status', {value:101}); this.webSocket = init.webSocket;} else super(body, init);}
};
class Socket {
    listeners = new Map(); received = []; closed = false;
    accept() {this.accepted = true;}
    addEventListener(type, callback) {const list = this.listeners.get(type) || []; list.push(callback); this.listeners.set(type, list);}
    emit(type, event) {for (const callback of this.listeners.get(type) || []) callback(event);}
    send(data) {if (this.closed) throw Error('closed'); this.peer.received.push(JSON.parse(data)); this.peer.emit('message', {data});}
    close(code, reason) {if (this.closed) return; this.closed = this.peer.closed = true; this.emit('close', {code, reason}); this.peer.emit('close', {code, reason});}
}
globalThis.WebSocketPair = class {constructor() {this[0] = new Socket(); this[1] = new Socket(); this[0].peer = this[1]; this[1].peer = this[0];}};
class Storage {
    values = new Map();
    async get(key) {return structuredClone(this.values.get(key));}
    async put(key, value) {this.values.set(key, structuredClone(value));}
    async delete(key) {this.values.delete(key);}
    async setAlarm(at) {this.alarm = at;}
    async deleteAlarm() {this.alarm = null;}
}
function context(storage = new Storage()) {return {storage, pending:[], blockConcurrencyWhile(callback) {return callback();}, waitUntil(promise) {this.pending.push(promise);}};}
function environment() {
    const db = new DatabaseSync(':memory:'); db.exec(readFileSync(new URL('../schema.sql', import.meta.url), 'utf8'));
    const env = {ALLOWED_ORIGIN:origin, objects:new Map(), db, nextIdentity:1000, API_RATE_LIMITER:{async limit() {return {success:true};}}, LOGIN_RATE_LIMITER:{async limit() {return {success:true};}}};
    env.DB = {prepare(sql) {return {bind(...args) {const statement = db.prepare(sql); return {async first() {return statement.get(...args) || null;}, async run() {return {meta:{changes:Number(statement.run(...args).changes)}};}};}};}};
    env.DB.batch = async statements => {db.exec('BEGIN'); try {const result = []; for (const statement of statements) result.push(await statement.run()); db.exec('COMMIT'); return result;} catch (error) {db.exec('ROLLBACK'); throw error;}};
    env.FOOTBALL_ROOMS = {idFromName:id => id, get(id) {if (!env.objects.has(id)) env.objects.set(id, new FootballRoom(context(), env)); return env.objects.get(id);}};
    return env;
}
const hash = async token => Buffer.from(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token))).toString('hex');
async function administrator(env, suffix = 'a') {
    const userToken = crypto.randomUUID() + crypto.randomUUID(), adminToken = crypto.randomUUID() + crypto.randomUUID();
    const userSessionHash = await hash(userToken), adminSessionHash = await hash(adminToken), adminAccountId = 'admin-' + suffix, bonkId = suffix === 'a' ? '123' : '456';
    env.db.prepare('INSERT INTO bonk_users VALUES(?,?,?)').run(bonkId, 'Admin ' + suffix, new Date().toISOString());
    env.db.prepare('INSERT INTO user_sessions VALUES(?,?,?)').run(userSessionHash, bonkId, Date.now() + 1000000);
    env.db.prepare('INSERT INTO admin_accounts VALUES(?,?,0)').run(adminAccountId, 'Admin ' + suffix);
    env.db.prepare('INSERT INTO admin_credentials(account_id,salt,code_hash) VALUES(?,?,?)').run(adminAccountId, 'salt', 'validated-code');
    env.db.prepare('INSERT INTO admin_bonk_links VALUES(?,?)').run(adminAccountId, bonkId);
    env.db.prepare('INSERT INTO admin_sessions VALUES(?,?,?)').run(adminSessionHash, Date.now() + 1000000, adminAccountId);
    env.db.prepare('INSERT INTO admin_session_identity VALUES(?,?)').run(adminSessionHash, userSessionHash);
    return {username:'Admin ' + suffix, bonkId, userSessionHash, adminSessionHash, adminAccountId, userToken, adminToken};
}
function request(env, path = '/lobby', body, identity = null, headers = {}) {
    return footballApi(new Request('https://api.test/api/football' + path, {method:body === undefined ? 'GET' : 'POST', headers:{Origin:origin, 'Content-Type':'application/json', ...headers}, ...(body === undefined ? {} : {body:JSON.stringify(body)})}), env, identity);
}
async function join(env, name = 'Player', {identity, extra = {}, path = '/lobby'} = {}) {
    if (identity === undefined) {
        const tokenHash = extra.resumeToken ? await hash(extra.resumeToken) : null, resumed = tokenHash ? roomOf(env)?.room?.members.find(item => item.resumeHash === tokenHash) : null;
        identity = {username:resumed?.name || name, bonkId:resumed?.bonkId || String(env.nextIdentity++)};
    }
    const response = await request(env, path, {displayName:name, ...extra}, identity); return {response, data:await response.json()};
}
async function connect(env, data, headers = {}) {
    const response = await request(env, data.socketPath.replace('/api/football', ''), undefined, null, {Upgrade:'websocket', ...headers}); assert.equal(response.status, 101); return response.webSocket;
}
async function watch(env) {
    const response = await request(env, '/watch', undefined, null, {Upgrade:'websocket'}); assert.equal(response.status, 101);
    const room = roomOf(env), connection = [...room.watchers.values()].at(-1); return {socket:response.webSocket, connection};
}
async function member(env, name, identity = null, {vote = true} = {}) {
    const {response, data} = await join(env, name, {identity:identity || undefined}); assert.equal(response.status, 200); const socket = await connect(env, data), result = {...data, socket};
    if (vote && roomOf(env).room.status === 'voting') await command(roomOf(env), result, {type:'modeVote', mode:'balanced'});
    return result;
}
const roomOf = env => env.objects.get(ID);
const roster = (room, data) => room.room.members.find(item => item.id === data.member.id);
async function command(room, data, message) {await room.message(room.connections.get(data.member.id), JSON.stringify(message));}
function cleanup(env) {for (const room of env.objects.values()) room.stopTimer(); env.db.close();}
async function match(env, count = 2) {
    const members = []; for (let i = 0; i < count; i++) members.push(await member(env, 'Player ' + i));
    const room = roomOf(env); for (const data of members) await command(room, data, {type:'ready', ready:true}); room.stopTimer(); assert.equal(room.room.status, 'playing'); return {room, members};
}
async function rocketsMatch(env, count = 2) {
    const members = []; for (let i = 0; i < count; i++) members.push(await member(env, 'Rocket ' + i, null, {vote:false}));
    const room = roomOf(env); for (const data of members) await command(room, data, {type:'modeVote', mode:'rockets'});
    for (const data of members) await command(room, data, {type:'ready', ready:true});
    room.stopTimer(); assert.equal(room.room.status, 'playing'); assert.equal(room.room.mode, 'rockets'); return {room, members};
}
async function finishTransition(room) {
    assert.ok(room.room.transition); room.room.transition.deadline = Date.now() - 1; await room.alarm(); room.stopTimer();
}

test('all legacy room links resolve to one shared hub while unsigned and forged guest joins are denied', async () => {
    const env = environment();
    try {
        const empty = await (await request(env)).json(); assert.equal(empty.room.id, ID); assert.deepEqual(empty.room.members, []);
        const denied = await request(env, '/rooms', {displayName:'Guest', identity:{username:'Forged', bonkId:'123'}, admin:true}); assert.equal(denied.status, 401); assert.deepEqual(await denied.json(), {error:'Sign in with your Bonk account to join.'});
        const first = (await join(env, 'Guest', {path:'/rooms', extra:{name:'Private room', admin:true, identity:{username:'Forged', bonkId:'123'}}})).data;
        const second = (await join(env, 'Other', {path:'/rooms/old-private-code/join'})).data;
        assert.equal(first.room.id, second.room.id); assert.equal(env.objects.size, 1); assert.equal(first.room.members[0].admin, false); assert.equal(first.room.members[0].verified, true);
        assert.equal(first.room.hostId, null); assert.equal(first.room.members[0].host, false);
        assert.doesNotMatch(JSON.stringify(second.room), /resumeHash|resumeToken|bonkId|SessionHash|adminContext/);
    } finally {cleanup(env);}
});

test('signed-in ordinary players have no admin power and ready up to auto-start', async () => {
    const env = environment();
    try {
        const first = await member(env, 'First'), second = await member(env, 'Second'), room = roomOf(env);
        assert.equal(roster(room, first).team, 3); assert.equal(roster(room, second).team, 2);
        for (const type of ['settings', 'start', 'abort', 'kick', 'assign']) await command(room, first, {type, settings:{scoreLimit:1}, memberId:second.member.id, team:2});
        assert.equal(room.room.settings.scoreLimit, 3); assert.equal(room.room.members.length, 2); assert.equal(room.room.status, 'lobby');
        await command(room, first, {type:'ready', ready:true}); assert.equal(room.room.status, 'lobby');
        await command(room, first, {type:'chat', text:'Ready!'}); assert.equal(roster(room, first).ready, true);
        await command(room, second, {type:'ready', ready:true}); room.stopTimer(); assert.equal(room.room.status, 'playing'); assert.equal(room.room.state.ftu, 120);
    } finally {cleanup(env);}
});

test('activated linked admins use their Bonk login, with live user-session revocation checked for every operation', async () => {
    const env = environment();
    try {
        const auth = await administrator(env), admin = await member(env, 'Ignored', auth), player = await member(env, 'Guest'), room = roomOf(env);
        assert.equal(roster(room, admin).admin, true);
        await command(room, admin, {type:'settings', settings:{scoreLimit:1, moveForce:0, goalHeight:-1}}); assert.equal(room.room.settings.moveForce, 0); assert.equal(room.room.settings.goalHeight, -1);
        await command(room, admin, {type:'assign', memberId:player.member.id, team:0}); assert.equal(roster(room, player).team, 0);
        env.db.prepare('DELETE FROM user_sessions WHERE token_hash=?').run(auth.userSessionHash);
        await command(room, admin, {type:'settings', settings:{scoreLimit:9}}); assert.equal(room.room.settings.scoreLimit, 1); assert.equal(roster(room, admin).admin, false);
        await command(room, admin, {type:'kick', memberId:player.member.id}); assert.equal(room.room.members.length, 2);
    } finally {cleanup(env);}
});

test('worker football auth ignores claimed roles and unrelated admin tokens, and recognizes the activated Bonk link', async () => {
    const env = environment();
    try {
        const auth = await administrator(env), other = await administrator(env, 'b');
        env.db.prepare('DELETE FROM admin_bonk_links WHERE account_id=?').run(other.adminAccountId);
        const send = headers => worker.fetch(new Request('https://api.test/api/football/lobby', {method:'POST', headers:{Origin:origin, 'Content-Type':'application/json', ...headers}, body:JSON.stringify({displayName:'Claimed admin', admin:true, adminSessionHash:auth.adminSessionHash})}), env);
        const forged = await send({}); assert.equal(forged.status, 401); assert.equal((await forged.json()).error, 'Sign in with your Bonk account to join.');
        const mismatch = await (await send({'X-Account-Session':other.userToken, Authorization:'Bearer ' + auth.adminToken})).json(); assert.equal(mismatch.room.members.find(item => item.id === mismatch.member.id).admin, false);
        const real = await (await send({'X-Account-Session':auth.userToken})).json(); assert.equal(real.room.members.find(item => item.id === real.member.id).admin, true);
    } finally {cleanup(env);}
});

test('settings validate atomically, reset lobby readiness, and queue during play', async () => {
    const env = environment();
    try {
        const admin = await member(env, 'Admin', await administrator(env)), player = await member(env, 'Player'), room = roomOf(env);
        await command(room, player, {type:'ready', ready:true}); const before = structuredClone(room.room.settings);
        await command(room, admin, {type:'settings', settings:{scoreLimit:5, moveForce:999}}); assert.deepEqual(room.room.settings, before); assert.equal(roster(room, player).ready, true);
        await command(room, admin, {type:'settings', settings:{scoreLimit:5, kickImpulse:0, ballRadius:1.1, pitchWidth:900}}); assert.equal(roster(room, player).ready, false); assert.equal(room.room.settings.scoreLimit, 5);
        await command(room, admin, {type:'start'}); room.stopTimer(); assert.equal(room.room.state.settings.ballRadius, 1.1);
        await command(room, admin, {type:'settings', settings:{scoreLimit:2}}); assert.equal(room.room.settings.scoreLimit, 5); assert.equal(room.room.pendingSettings.scoreLimit, 2);
        await command(room, admin, {type:'abort'}); assert.equal(room.room.status, 'lobby');
    } finally {cleanup(env);}
});

test('64 member capacity allows only four active players per side and FIFO queue positions', async () => {
    const env = environment();
    try {
        const people = []; for (let i = 0; i < LIMITS.MAX_MEMBERS; i++) people.push(await member(env, 'Player ' + i));
        const room = roomOf(env), view = room.publicRoom(); assert.equal(room.room.members.length, 64);
        assert.equal(view.members.filter(item => item.team === 2).length, 4); assert.equal(view.members.filter(item => item.team === 3).length, 4);
        assert.deepEqual(view.members.filter(item => item.queued).map(item => item.queuePosition), Array.from({length:56}, (_, i) => i + 1));
        assert.equal((await join(env, 'Overflow')).response.status, 409);
        await command(room, people[0], {type:'spectate'}); assert.equal(roster(room, people[0]).queuePosition, undefined); assert.equal(roster(room, people[8]).team, 3);
        assert.equal(room.publicRoom().members.find(item => item.id === people[0].member.id).queuePosition, null);
    } finally {cleanup(env);}
});

test('balanced mode preserves a fair queue and keeps sides within one player after opt-out', async () => {
    const env = environment();
    try {
        const people = []; for (let i = 0; i < 10; i++) people.push(await member(env, 'P' + i)); const room = roomOf(env);
        await command(room, people[8], {type:'queue', team:3}); await command(room, people[9], {type:'queue', team:2});
        await command(room, people[0], {type:'spectate'}); assert.ok(roster(room, people[8]).team); assert.equal(roster(room, people[9]).queued, true);
        await command(room, people[1], {type:'spectate'}); assert.ok(roster(room, people[9]).team);
        assert.ok(Math.abs(room.room.members.filter(item => item.team === 2).length - room.room.members.filter(item => item.team === 3).length) <= 1);
    } finally {cleanup(env);}
});

test('queued and spectating arrivals cannot reset active readiness', async () => {
    const env = environment();
    try {
        const people = []; for (let i = 0; i < 8; i++) people.push(await member(env, 'Player ' + i)); const room = roomOf(env);
        await command(room, people[0], {type:'ready', ready:true});
        const queued = await member(env, 'Queue'); assert.equal(roster(room, people[0]).ready, true);
        await command(room, queued, {type:'queue', team:3}); assert.equal(roster(room, people[0]).ready, true);
        await command(room, queued, {type:'spectate'}); assert.equal(roster(room, people[0]).ready, true);
        queued.socket.close(1001, 'gone'); assert.equal(roster(room, people[0]).ready, true);
        roster(room, queued).disconnectedAt = Date.now() - LIMITS.RESUME_GRACE - 1; await room.alarm(); assert.equal(roster(room, people[0]).ready, true);
    } finally {cleanup(env);}
});

test('Balanced continuation applies pending settings only when the selected next game starts', async () => {
    const env = environment();
    try {
        const admin = await member(env, 'Admin', await administrator(env)), player = await member(env, 'Player'), room = roomOf(env);
        await command(room, admin, {type:'start'}); room.stopTimer(); room.room.state.fte = 0; room.room.state.scores[2] = 3; room.tick();
        const result = structuredClone(room.room.lastResult);
        assert.equal(room.room.status, 'voting'); assert.equal(room.publicRoom().phaseKind, 'mode-selection'); assert.equal(room.publicRoom().vote.continuation, true);
        await command(room, admin, {type:'modeVote', mode:'balanced'}); await command(room, player, {type:'modeVote', mode:'balanced'});
        await command(room, admin, {type:'settings', settings:{pitchWidth:900}});
        assert.equal(room.room.status, 'voting'); assert.equal(room.room.transition.kind, 'game'); assert.equal(room.room.settings.pitchWidth, 730); assert.equal(room.room.pendingSettings.pitchWidth, 900);
        await finishTransition(room);
        assert.equal(room.room.status, 'playing'); assert.equal(room.room.state.ftu, 120); assert.equal(room.room.state.settings.pitchWidth, 900); assert.equal(room.room.winner, null); assert.equal(room.room.settings.pitchWidth, 900); assert.deepEqual(room.room.lastResult, result);
    } finally {cleanup(env);}
});

test('live arrivals remain queued through goals and rebalance, then enter only at the next game', async () => {
    const env = environment();
    try {
        const {room, members} = await match(env), arrival = await member(env, 'Queued');
        assert.equal(roster(room, arrival).queued, true); assert.equal(roster(room, arrival).team, 0); assert.equal(room.room.state.discs[2], undefined);
        room.room.state.fte = 0; room.room.state.scores[2] = 1; room.tick();
        assert.equal(roster(room, arrival).queued, true); assert.equal(roster(room, arrival).team, 0); assert.equal(room.room.state.ftu, 120); assert.equal(room.room.state.scores[2], 1);
        assert.equal(room.room.state.players[0].id, roster(room, members[0]).slot); assert.equal(room.room.state.players[2] || null, null);
        await command(room, members[1], {type:'leave'});
        await command(room, members[0], {type:'rebalanceVote', yes:true}); await command(room, arrival, {type:'rebalanceVote', yes:true});
        assert.equal(roster(room, arrival).team, 0); assert.equal(room.room.state.discs[2] || null, null); assert.equal(room.room.state.scores[2], 1);
        room.room.state.scores[2] = room.room.settings.scoreLimit; room.room.state.fte = 0; room.tick(); assert.equal(room.room.status, 'voting');
        assert.equal(roster(room, arrival).team, 0);
        await command(room, members[0], {type:'modeVote', mode:'balanced'}); await command(room, arrival, {type:'modeVote', mode:'balanced'});
        assert.equal(roster(room, arrival).team, 0); assert.equal(room.room.status, 'voting');
        await finishTransition(room);
        assert.equal(room.room.status, 'playing'); assert.equal(room.room.state.players[2].name, 'Queued');
    } finally {cleanup(env);}
});

test('winning score resolves before reset and the dedicated vote automatically starts the next match', async () => {
    const env = environment();
    try {
        const {room, members} = await match(env); room.room.settings.scoreLimit = 1;
        room.room.state.ftu = -1; room.room.state.ball.x = 29 / 11; room.room.state.ball.xv = -1; room.tick();
        assert.equal(room.room.state.scores[2], 1); assert.equal(room.room.state.fte, 90);
        for (let i = 0; i < 90; i++) room.tick(); assert.equal(room.room.status, 'playing'); room.tick();
        assert.equal(room.room.status, 'voting'); assert.equal(room.room.winner, 2); const result = structuredClone(room.room.lastResult);
        assert.deepEqual(room.publicRoom().vote.scores, [0, 0, 1, 0]); assert.equal(room.publicRoom().vote.winner, 2);
        for (const data of members) await command(room, data, {type:'modeVote', mode:'balanced'});
        assert.equal(room.room.status, 'voting'); assert.equal(room.publicRoom().vote.resolved, true); assert.equal(room.publicRoom().vote.selectedMode, 'balanced');
        await command(room, members[0], {type:'ready', ready:true}); assert.equal(room.room.status, 'voting');
        await finishTransition(room);
        assert.equal(room.room.status, 'playing'); assert.deepEqual(room.room.state.scores, [0, 0, 0, 0]); assert.deepEqual(room.room.lastResult, result);
    } finally {cleanup(env);}
});

test('server physics and socket ownership reject client states, forged slots and stale sequences', async () => {
    const env = environment();
    try {
        const {room, members} = await match(env); room.room.state.ftu = -1; const state = structuredClone(room.room.state);
        await command(room, members[1], {type:'state', scores:[0, 0, 99, 99]}); assert.deepEqual(room.room.state, state);
        await command(room, members[1], {type:'input', seq:7, flags:2, memberId:members[0].member.id, slot:0});
        await command(room, members[1], {type:'input', seq:7, flags:0}); assert.equal(room.inputs[1], 2); assert.equal(room.inputs[0] || 0, 0);
        room.tick(); room.tick(); assert.ok(room.room.state.discs[1].x > state.discs[1].x);
        const snapshots = members[0].socket.received.filter(message => message.type === 'snapshot'); assert.equal(snapshots.length, 1); assert.equal(snapshots[0].tick, 2);
        room.inputTimes[1] = Date.now() - 1001; room.tick(); assert.equal(room.inputs[1], 0);
    } finally {cleanup(env);}
});

test('viewport messages change only the bound member metadata and leave positions, settings and readiness untouched', async () => {
    const env = environment();
    try {
        const first = await member(env, 'First'), second = await member(env, 'Second'), room = roomOf(env), slot = roster(room, first).slot;
        await command(room, first, {type:'ready', ready:true});
        await command(room, first, {type:'viewport', aspect:2, memberId:second.member.id, slot:roster(room, second).slot, bounds:{left:-99999}, settings:{pitchWidth:1460}, admin:true});
        assert.equal(roster(room, first).viewportAspect, 2); assert.equal(roster(room, second).viewportAspect, undefined); assert.equal(roster(room, first).ready, true); assert.equal(room.room.state, null); assert.equal(room.timer, null); assert.equal(room.room.settings.pitchWidth, 730);
        await command(room, second, {type:'ready', ready:true}); room.stopTimer();
        assert.equal(room.room.state.players[slot].viewportAspect, 2); const before = structuredClone(room.room.state), settings = {...room.room.settings};
        await command(room, first, {type:'viewport', aspect:.5});
        before.players[slot].viewportAspect = .5; assert.deepEqual(room.room.state, before); assert.deepEqual(room.room.settings, settings); assert.equal(room.timer, null);
        assert.equal(Object.hasOwn(room.publicRoom().members.find(member => member.id === first.member.id), 'viewportAspect'), false);
        for (const aspect of [.124, 8.001, -1, 0, '2', null, {}, [], Infinity]) await command(room, first, {type:'viewport', aspect});
        assert.equal(roster(room, first).viewportAspect, .5); assert.equal(room.room.state.players[slot].viewportAspect, .5);
        await command(room, first, {type:'viewport', aspect:.125}); await command(room, first, {type:'viewport', aspect:8}); assert.equal(roster(room, first).viewportAspect, 8);
        room.tick(); room.tick();
        assert.equal(first.socket.received.filter(message => message.type === 'snapshot').at(-1).state.players[slot].viewportAspect, 8);
    } finally {cleanup(env);}
});

test('spectators save their viewport for the next game without changing current participants or admitting themselves', async () => {
    const env = environment();
    try {
        const {room, members} = await match(env, 1), spectator = await member(env, 'Waiting'), slot = roster(room, spectator).slot, before = structuredClone(room.room.state);
        await command(room, spectator, {type:'viewport', aspect:.4, slot:roster(room, members[0]).slot});
        assert.equal(roster(room, spectator).viewportAspect, .4); assert.equal(roster(room, spectator).team, 0); assert.equal(roster(room, spectator).queued, true); assert.deepEqual(room.room.state, before);
        room.room.state.fte = 0; room.room.state.scores[2] = 1; room.tick(); assert.equal(room.room.state.players[slot] || null, null);
        room.finishGame(2); for (const data of members.concat(spectator)) await command(room, data, {type:'modeVote', mode:'balanced'}); await finishTransition(room);
        assert.equal(room.room.state.players[slot].viewportAspect, .4); assert.ok(room.room.state.discs[slot]);
    } finally {cleanup(env);}
});

test('viewport metadata survives native steps, goal resets and cold checkpoint resume', async () => {
    const env = environment(); let restored;
    try {
        const {room, members} = await match(env, 1), slot = roster(room, members[0]).slot;
        await command(room, members[0], {type:'viewport', aspect:2.4}); room.tick(); assert.equal(room.room.state.players[slot].viewportAspect, 2.4);
        room.room.state.fte = 0; room.room.state.scores[2] = 1; room.tick(); assert.equal(room.room.state.ftu, 120); assert.equal(room.room.state.players[slot].viewportAspect, 2.4);
        await room.persist(); restored = new FootballRoom(context(room.ctx.storage), env); await restored.ready; restored.stopTimer(); env.objects.set(ID, restored);
        assert.equal(restored.room.members[0].viewportAspect, 2.4); assert.equal(restored.room.state.players[slot].viewportAspect, 2.4);
        const resumed = (await join(env, 'Ignored', {extra:{resumeToken:members[0].member.resumeToken}})).data; await connect(env, resumed); restored.stopTimer();
        restored.abort('test'); await command(restored, resumed, {type:'ready', ready:true}); restored.stopTimer(); assert.equal(restored.room.state.players[slot].viewportAspect, 2.4);
    } finally {restored?.stopTimer(); cleanup(env);}
});

test('origin, one-use ticket TTL, reconnect rotation and account binding remain enforced', async () => {
    const env = environment();
    try {
        assert.equal((await request(env, '/lobby', {displayName:'Evil'}, null, {Origin:'https://evil.test'})).status, 403);
        const identity = {username:'Verified', bonkId:'555'}, first = (await join(env, 'Ignored', {identity})).data;
        assert.equal((await request(env, first.socketPath.replace('/api/football', ''), undefined, null, {Upgrade:'websocket', Origin:'https://evil.test'})).status, 403);
        const socket = await connect(env, first); socket.close(1001, 'gone'); assert.equal(roomOf(env).inputs[0] || 0, 0);
        assert.equal((await join(env, 'Guest', {identity:null, extra:{resumeToken:first.member.resumeToken}})).response.status, 401);
        const resumed = (await join(env, 'Ignored', {identity, extra:{resumeToken:first.member.resumeToken}})).data; assert.equal(resumed.member.id, first.member.id); assert.notEqual(resumed.member.resumeToken, first.member.resumeToken);
        await connect(env, resumed); assert.equal((await request(env, resumed.socketPath.replace('/api/football', ''), undefined, null, {Upgrade:'websocket'})).status, 403);
        assert.equal((await join(env, 'Ignored', {identity, extra:{resumeToken:first.member.resumeToken}})).response.status, 403);
        const expires = (await join(env, 'Expires')).data; roomOf(env).tickets.get(expires.ticket).expires = Date.now() - 1;
        assert.equal((await request(env, expires.socketPath.replace('/api/football', ''), undefined, null, {Upgrade:'websocket'})).status, 403);
    } finally {cleanup(env);}
});

test('a legacy guest seat requires authenticated resume and upgrades only through a trusted account identity', async () => {
    const env = environment();
    try {
        const guest = await member(env, 'Guest'), auth = await administrator(env);
        roster(roomOf(env), guest).bonkId = null; roster(roomOf(env), guest).verified = false;
        assert.equal((await join(env, 'Guest', {identity:null, extra:{resumeToken:guest.member.resumeToken}})).response.status, 401);
        const upgraded = (await join(env, 'Ignored', {identity:auth, extra:{resumeToken:guest.member.resumeToken}})).data;
        assert.equal(upgraded.member.id, guest.member.id); const own = upgraded.room.members.find(item => item.id === guest.member.id);
        assert.equal(own.verified, true); assert.equal(own.admin, true); assert.equal(own.name, auth.username);
    } finally {cleanup(env);}
});

test('idle cleanup and cold checkpoints preserve shared admin settings and release controls', async () => {
    const env = environment();
    try {
        const admin = await member(env, 'Admin', await administrator(env)), player = await member(env, 'Player'), room = roomOf(env);
        await command(room, admin, {type:'settings', settings:{moveForce:0, goalHeight:-1, pitchWidth:900}}); await command(room, admin, {type:'start'}); room.stopTimer();
        room.inputs[0] = 31; await room.persist(); const restored = new FootballRoom(context(room.ctx.storage), env); await restored.ready; restored.stopTimer();
        assert.equal(restored.room.status, 'playing'); assert.equal(restored.inputs[0] || 0, 0); assert.ok(restored.room.members.every(item => !item.connected));
        restored.room.lastActive = Date.now() - LIMITS.IDLE_TTL - 1; await restored.alarm(); await restored.persistChain;
        assert.equal(restored.room.status, 'lobby'); assert.deepEqual(restored.room.members, []); assert.equal(restored.room.settings.moveForce, 0); assert.equal(restored.room.settings.goalHeight, -1); assert.equal(restored.ctx.storage.alarm, null);
        const cold = new FootballRoom(context(restored.ctx.storage), env); await cold.ready; assert.equal(cold.room.settings.pitchWidth, 900); assert.equal(cold.timer, null);
    } finally {cleanup(env);}
});

test('heartbeat grace expires into a rebalance poll while remaining players continue; active input avoids alarm writes', async () => {
    const env = environment();
    try {
        const {room, members} = await match(env), connection = room.connections.get(members[0].member.id), alarm = room.ctx.storage.alarm;
        connection.lastMessageAt = Date.now() - LIMITS.HEARTBEAT_TTL - 1; await command(room, members[0], {type:'input', seq:1, flags:0}); assert.equal(room.ctx.storage.alarm, alarm);
        await room.alarm(); assert.equal(members[0].socket.closed, false);
        connection.lastMessageAt = Date.now() - LIMITS.HEARTBEAT_TTL - 1; await room.alarm(); assert.equal(members[0].socket.closed, true);
        roster(room, members[0]).disconnectedAt = Date.now() - LIMITS.RESUME_GRACE - 1; await room.alarm(); assert.equal(room.room.status, 'playing'); assert.equal(room.room.members.length, 1); assert.ok(room.room.rebalanceVote);
        await command(room, members[1], {type:'rebalanceVote', yes:true}); assert.equal(room.room.rebalanceVote, null); assert.equal(room.room.state.ftu, 120);
    } finally {cleanup(env);}
});

test('kick invalidates resume, chat limits preserve readiness, and oversized/flooded sockets close', async () => {
    const env = environment();
    try {
        const admin = await member(env, 'Admin', await administrator(env)), player = await member(env, 'Player'), room = roomOf(env);
        await command(room, player, {type:'ready', ready:true});
        for (let i = 0; i < 5; i++) await command(room, player, {type:'chat', text:'Hello ' + i}); assert.equal(player.socket.received.filter(item => item.type === 'chat').length, 4); assert.deepEqual(room.room.chat, []); assert.equal(roster(room, player).ready, true);
        await command(room, admin, {type:'kick', memberId:player.member.id}); assert.equal(player.socket.closed, true); assert.equal((await join(env, 'Player', {extra:{resumeToken:player.member.resumeToken}})).response.status, 403);
        const large = await member(env, 'Large'); await command(room, large, {type:'ping', padding:'x'.repeat(1100)}); assert.equal(large.socket.closed, true);
        const flood = await member(env, 'Flood'); for (let i = 0; i < 120 && room.connections.has(flood.member.id); i++) await command(room, flood, {type:'ping', sentAt:i}); assert.equal(flood.socket.closed, true);
    } finally {cleanup(env);}
});

test('mode voting is server-timed, has one vote per eligible member, and excludes watchers', async () => {
    const env = environment();
    try {
        const first = await member(env, 'First', null, {vote:false}), second = await member(env, 'Second', null, {vote:false}), watcher = await member(env, 'Watch', null, {vote:false}), room = roomOf(env);
        await command(room, watcher, {type:'spectate'}); assert.equal(room.room.status, 'voting'); const deadline = room.room.vote.deadline;
        await command(room, watcher, {type:'modeVote', mode:'rockets'}); assert.deepEqual(room.publicRoom().vote.counts, {balanced:0, rockets:0});
        await command(room, first, {type:'modeVote', mode:'balanced', memberId:second.member.id, deadline:0});
        await command(room, first, {type:'modeVote', mode:'rockets'}); assert.equal(room.room.vote.deadline, deadline); assert.deepEqual(room.publicRoom().vote.counts, {balanced:0, rockets:1});
        assert.equal(room.room.status, 'voting'); await command(room, second, {type:'modeVote', mode:'rockets'});
        assert.equal(room.room.status, 'lobby'); assert.equal(room.room.mode, 'rockets'); assert.equal(room.room.vote, null);
    } finally {cleanup(env);}
});

test('a single player may vote and start balanced football, and timed votes resolve without client timers', async () => {
    const env = environment();
    try {
        const solo = await member(env, 'Solo', null, {vote:false}), room = roomOf(env); assert.equal(room.room.status, 'voting');
        room.room.vote.deadline = Date.now() - 1; await room.alarm(); assert.equal(room.room.status, 'lobby'); assert.equal(room.room.mode, 'balanced'); assert.equal(room.canStart(), true);
        await command(room, solo, {type:'ready', ready:true}); room.stopTimer(); assert.equal(room.room.status, 'playing'); assert.equal(room.room.state.discs.filter(Boolean).length, 1);
    } finally {cleanup(env);}
});

test('empty votes stop and a watcher joining the queue opens a fresh initial vote', async () => {
    const env = environment();
    try {
        const solo = await member(env, 'Solo', null, {vote:false}), room = roomOf(env);
        await command(room, solo, {type:'spectate'}); assert.equal(room.room.status, 'lobby'); assert.equal(room.room.vote, null);
        await command(room, solo, {type:'queue', team:0}); assert.equal(room.room.status, 'voting'); assert.ok(room.room.vote.deadline > Date.now());
    } finally {cleanup(env);}
});

test('a continuation with no connected participants fades to an idle lobby without restarting', async () => {
    const env = environment();
    try {
        const {room, members} = await match(env, 1); room.finishGame(3);
        members[0].socket.close(1001, 'gone'); room.room.vote.deadline = Date.now() - 1; await room.alarm();
        assert.equal(room.room.status, 'voting'); assert.equal(room.room.transition.kind, 'lobby'); await finishTransition(room);
        assert.equal(room.room.status, 'lobby'); assert.equal(room.room.results, null); assert.equal(room.room.vote, null); assert.equal(room.room.state, null);
        roster(room, members[0]).disconnectedAt = Date.now() - LIMITS.RESUME_GRACE - 1; await room.alarm();
        assert.equal(room.room.members.length, 0); assert.equal(room.ctx.storage.alarm, null); assert.ok(room.room.lastResult);
    } finally {cleanup(env);}
});

test('rebalance yes resets at kickoff with scores intact, while no and timeout preserve live assignments', async () => {
    const env = environment();
    try {
        const {room, members} = await match(env, 3); room.room.state.ftu = -1; room.room.state.scores[2] = 1;
        await command(room, members[0], {type:'leave'}); assert.equal(room.room.status, 'playing'); assert.ok(room.room.rebalanceVote);
        const before = room.room.state, teams = room.room.members.map(item => [item.id, item.team]);
        await command(room, members[1], {type:'rebalanceVote', yes:false}); await command(room, members[2], {type:'rebalanceVote', yes:false});
        assert.equal(room.room.rebalanceVote, null); assert.equal(room.room.state, before); assert.deepEqual(room.room.members.map(item => [item.id, item.team]), teams);
        room.room.state.fte = 0; room.tick(); assert.deepEqual(room.room.members.map(item => [item.id, item.team]), teams); assert.equal(room.room.state.scores[2], 1);
        const afterKickoff = room.room.state;
        room.openRebalanceVote(); room.room.rebalanceVote.deadline = Date.now() - 1; await room.alarm(); assert.equal(room.room.state, afterKickoff); assert.equal(room.room.rebalanceVote, null);
        room.openRebalanceVote(); await command(room, members[1], {type:'rebalanceVote', yes:true}); await command(room, members[2], {type:'rebalanceVote', yes:true});
        assert.equal(room.room.rebalanceVote, null); assert.equal(room.room.state.ftu, 120); assert.equal(room.room.state.scores[2], 1);
        assert.ok(Math.abs(room.room.members.filter(item => item.team === 2).length - room.room.members.filter(item => item.team === 3).length) <= 1);
    } finally {cleanup(env);}
});

test('solo Rockets excludes countdown from its 900 active ticks and records native goal speed in m/s only once', async () => {
    const env = environment();
    try {
        const {room, members} = await rocketsMatch(env, 1); assert.equal(room.publicRoom().rockets.attackerId, members[0].member.id); assert.equal(roster(room, members[0]).team, 3);
        for (let frame = 0; frame < 121; frame++) room.tick(); assert.equal(room.room.state.ftu, -1); assert.equal(room.room.rockets.turnTicksLeft, 900);
        room.room.state.ball.x = 701 / 11; room.room.state.ball.xv = 20; room.tick();
        assert.equal(room.room.rockets.turnTicksLeft, 899); assert.equal(room.room.state.fte, 90); assert.equal(room.room.rockets.turnEnded, true);
        const board = room.publicRoom().rockets.leaderboard; assert.equal(board[0].scored, true); assert.ok(Math.abs(board[0].speed - 19.6) < .000001); assert.equal(room.publicRoom().rockets.unit, 'm/s');
        assert.equal(members[0].socket.received.filter(item => item.system).length, 1); assert.equal(members[0].socket.received.filter(item => item.system).at(-1).text, 'Rocket 0 reached 19.6 m/s.');
        for (let frame = 0; frame < 90; frame++) room.tick(); assert.equal(room.room.rockets.turnTicksLeft, 899); room.tick();
        assert.equal(room.room.status, 'results'); assert.equal(room.room.results.winnerId, members[0].member.id); assert.equal(room.room.results.unit, 'm/s'); assert.equal(members[0].socket.received.filter(item => item.system).length, 1);
    } finally {cleanup(env);}
});

test('Rockets rotates every participant with exactly one disc and queues late arrivals for the next game', async () => {
    const env = environment();
    try {
        const {room, members} = await rocketsMatch(env, 6), late = await member(env, 'Late');
        assert.equal(room.room.rockets.participantIds.includes(late.member.id), false); assert.equal(roster(room, late).queued, true);
        const seen = [];
        for (let turn = 0; turn < 6; turn++) {
            const attackerTeam = room.room.rockets.attackerTeam;
            seen.push(room.room.rockets.attackerId); assert.equal(room.publicRoom().rockets.turnIndex, turn + 1); assert.equal(room.room.members.filter(item => item.team === attackerTeam).length, 1); assert.equal(room.room.members.filter(item => item.team).length, 1); assert.equal(room.room.state.discs.filter(Boolean).length, 1);
            assert.equal(room.room.rockets.participantIds.length, 6); assert.ok(room.room.members.filter(item => item.id !== room.room.rockets.attackerId).every(item => !item.team && item.queued));
            room.room.state.ftu = -1; room.room.rockets.turnTicksLeft = 1; room.tick();
        }
        assert.deepEqual(seen, members.map(data => data.member.id)); assert.equal(room.room.status, 'results'); assert.equal(room.room.results.leaderboard.length, 6); assert.ok(room.room.results.leaderboard.every(row => !row.scored));
        assert.equal(members[0].socket.received.filter(item => item.system).length, 0); assert.equal(room.room.results.winnerId, null);
    } finally {cleanup(env);}
});

test('Rockets queued participants must ready up and are listed in the public fixed roster', async () => {
    const env = environment();
    try {
        const people = []; for (let i = 0; i < 10; i++) people.push(await member(env, 'Rocket ' + i, null, {vote:false})); const room = roomOf(env);
        for (const data of people) await command(room, data, {type:'modeVote', mode:'rockets'});
        for (const data of people.slice(0, 9)) await command(room, data, {type:'ready', ready:true});
        assert.equal(room.room.status, 'lobby'); assert.equal(roster(room, people[9]).queued, true);
        await command(room, people[9], {type:'ready', ready:true}); room.stopTimer(); assert.equal(room.room.status, 'playing');
        assert.deepEqual(room.publicRoom().rockets.participantIds, people.map(data => data.member.id)); assert.equal(room.publicRoom().rockets.totalTurns, 10);
    } finally {cleanup(env);}
});

test('Rockets red goals do not announce a shot; role changes skip the attacker and remove departed records', async () => {
    const env = environment();
    try {
        const {room, members} = await rocketsMatch(env, 3);
        room.room.state.ftu = -1; room.room.state.ball.x = 29 / 11; room.room.state.ball.xv = -20; room.tick();
        assert.equal(room.room.state.lscr, 2); assert.equal(members[0].socket.received.filter(item => item.system).length, 0);
        for (let frame = 0; frame < 91; frame++) room.tick(); assert.equal(room.room.rockets.attackerId, members[1].member.id); assert.equal(room.publicRoom().rockets.leaderboard.find(row => row.id === members[0].member.id).scored, false);
        await command(room, members[1], {type:'spectate'}); assert.equal(room.room.rockets.attackerId, members[2].member.id); assert.equal(room.room.rockets.totalTurns, 2); assert.equal(roster(room, members[1]).queued, false); assert.equal(room.publicRoom().rockets.leaderboard.some(row => row.id === members[1].member.id), false);
        await command(room, members[0], {type:'queue', team:0}); assert.equal(room.room.rockets.participantIds.includes(members[0].member.id), false); assert.equal(roster(room, members[0]).queued, true); assert.equal(room.publicRoom().rockets.leaderboard.length, 1);
        await command(room, members[2], {type:'leave'}); assert.notEqual(room.room.status, 'playing'); assert.equal(room.room.rockets, null);
    } finally {cleanup(env);}
});

test('expired mode and rebalance votes reject late socket messages before an alarm runs', async () => {
    const env = environment();
    try {
        const first = await member(env, 'First', null, {vote:false}), second = await member(env, 'Second', null, {vote:false}), room = roomOf(env);
        room.room.vote.deadline = Date.now() - 1;
        await command(room, first, {type:'modeVote', mode:'rockets'});
        assert.equal(room.room.status, 'lobby'); assert.equal(room.room.mode, 'balanced'); assert.ok(first.socket.received.some(message => /vote has ended/.test(message.error || '')));
        await command(room, first, {type:'ready', ready:true}); await command(room, second, {type:'ready', ready:true}); room.stopTimer(); room.room.state.ftu = -1;
        await command(room, first, {type:'leave'}); room.room.rebalanceVote.deadline = Date.now() - 1; const state = room.room.state;
        await command(room, second, {type:'rebalanceVote', yes:true});
        assert.equal(room.room.rebalanceVote, null); assert.equal(room.room.balanceDeferred, true); assert.equal(room.room.state, state); assert.equal(room.room.state.ftu, -1);
    } finally {cleanup(env);}
});

test('a disconnected Rockets attacker immediately withdraws without a ghost disc and resumes only into the next-game queue', async () => {
    const env = environment();
    try {
        const {room, members} = await rocketsMatch(env, 3), attacker = members[0], slot = roster(room, attacker).slot;
        room.room.state.ftu = -1; room.room.state.ball.x = 701 / 11; room.room.state.ball.xv = 20; room.tick();
        assert.equal(room.publicRoom().rockets.leaderboard.find(row => row.id === attacker.member.id).scored, true);
        attacker.socket.close(1001, 'network lost');
        assert.equal(room.room.rockets.attackerId, members[1].member.id); assert.equal(roster(room, attacker).team, 0); assert.equal(roster(room, attacker).queued, true); assert.equal(roster(room, attacker).connected, false);
        assert.equal(room.publicRoom().rockets.leaderboard.some(row => row.id === attacker.member.id), false); assert.equal(room.room.state.discs[slot] || null, null); assert.equal(room.room.state.players[slot] || null, null);
        const resumed = (await join(env, 'Ignored', {extra:{resumeToken:attacker.member.resumeToken}})).data; await connect(env, resumed);
        assert.equal(resumed.member.id, attacker.member.id); assert.equal(roster(room, attacker).connected, true); assert.equal(roster(room, attacker).team, 0); assert.equal(roster(room, attacker).queued, true);
        assert.equal(room.room.rockets.participantIds.includes(attacker.member.id), false); assert.equal(room.room.state.discs[slot] || null, null);
    } finally {cleanup(env);}
});

test('a waiting Rockets participant disconnect withdraws without affecting the current attacker or adding a disc', async () => {
    const env = environment();
    try {
        const {room, members} = await rocketsMatch(env, 3), attacker = members[0], defender = members[1], slot = roster(room, defender).slot;
        const replaced = (await join(env, 'Ignored', {extra:{resumeToken:attacker.member.resumeToken}})).data; await connect(env, replaced);
        assert.equal(room.room.rockets.attackerId, attacker.member.id); assert.equal(room.room.rockets.participantIds.includes(attacker.member.id), true); assert.equal(roster(room, attacker).team, 3);
        room.room.state.ftu = -1; defender.socket.close(1001, 'network lost'); room.tick();
        assert.equal(roster(room, defender).team, 0); assert.equal(roster(room, defender).queued, true); assert.equal(room.room.rockets.participantIds.includes(defender.member.id), false); assert.equal(room.room.state.discs[slot] || null, null); assert.equal(room.room.rockets.attackerId, attacker.member.id);
    } finally {cleanup(env);}
});

test('departing Rockets results leaders disappear from the board and cannot remain its winner', async () => {
    const env = environment();
    try {
        const {room, members} = await rocketsMatch(env, 2), leader = members[0], other = members[1];
        room.room.rockets.records[leader.member.id] = {scored:true, speed:20, timeTicks:10}; room.room.rockets.records[other.member.id] = {scored:true, speed:10, timeTicks:20}; room.finishGame(null);
        assert.equal(room.room.results.winnerId, leader.member.id);
        await command(room, leader, {type:'leave'});
        assert.equal(room.room.status, 'results'); assert.equal(room.room.results.winnerId, other.member.id); assert.deepEqual(room.room.results.leaderboard.map(row => row.id), [other.member.id]); assert.equal(room.room.lastResult.winnerId, other.member.id);
        await command(room, other, {type:'spectate'}); assert.equal(room.room.status, 'results'); assert.deepEqual(room.room.results.leaderboard, []); assert.equal(room.room.results.winnerId, null); assert.equal(room.room.lastResult.winnerId, null);
    } finally {cleanup(env);}
});

test('the fixed-step pump recovers delayed callbacks without changing direct tick semantics', async () => {
    const env = environment();
    try {
        const {room} = await match(env, 1), start = Date.now(); room.lastPumpAt = start; room.accumulator = 0;
        assert.equal(room.pump(start + 10), 0); assert.equal(room.tickNumber, 0);
        assert.equal(room.pump(start + 100), 3); assert.equal(room.tickNumber, 3); assert.equal(room.room.state.ftu, 117);
        assert.equal(room.pump(start + 220), 3); assert.equal(room.tickNumber, 6);
        assert.equal(room.pump(start + 300), 3); assert.equal(room.tickNumber, 9); assert.equal(room.room.state.ftu, 111);
        room.tick(); assert.equal(room.tickNumber, 10); assert.equal(room.room.state.ftu, 110);
        const bounded = room.pump(start + 20_000); assert.ok(bounded >= 7 && bounded <= 8); assert.ok(room.accumulator < 1000 / 30);
        room.stopTimer(); assert.equal(room.accumulator, 0); assert.equal(room.lastPumpAt, 0);
    } finally {cleanup(env);}
});

test('Rockets advances 900 active ticks in thirty seconds despite delayed callback batches', async () => {
    const env = environment();
    try {
        const {room, members} = await rocketsMatch(env, 2), start = Date.now(); room.room.state.ftu = -1; room.lastPumpAt = start; room.accumulator = 0;
        for (let elapsed = 100; elapsed <= 29_900; elapsed += 100) room.pump(start + elapsed);
        assert.equal(room.room.rockets.attackerId, members[0].member.id); assert.equal(room.room.rockets.turnTicksLeft, 3);
        room.pump(start + 30_000); assert.equal(room.room.rockets.attackerId, members[1].member.id); assert.equal(room.room.rockets.turnTicksLeft, 900); assert.equal(room.room.state.ftu, 120);
    } finally {cleanup(env);}
});

test('the dedicated continuation vote coasts through its fade and publishes motion without accepting input', async () => {
    const env = environment();
    try {
        const {room, members} = await match(env, 2), watcher = await member(env, 'Watcher');
        await command(room, watcher, {type:'spectate'});
        const slot = roster(room, members[0]).slot;
        room.room.state.ftu = -1; room.room.state.fte = 0; room.room.state.scores[2] = 3;
        Object.assign(room.room.state.discs[slot], {x:20, y:22, xv:4, yv:0});
        Object.assign(room.room.state.ball, {x:22.1, y:22, xv:8, yv:0});
        room.finishGame(2);
        assert.ok(room.timer, 'finishing keeps the simulation timer running');
        room.stopTimer();
        const lastResult = structuredClone(room.room.lastResult);
        await command(room, members[0], {type:'input', seq:1, flags:18});
        assert.equal(room.inputs[slot], 0, 'mode selection accepts no movement or kick input');
        const start = Date.now(); room.lastPumpAt = start; room.accumulator = 0;
        assert.equal(room.pump(start + 100), 3);
        assert.ok(Math.abs(room.room.state.ball.xv - 8 * 0.98 ** 3) < 1e-9);
        assert.ok(Math.abs(room.room.state.discs[slot].xv - 4 * 0.92 ** 3) < 1e-9);
        assert.ok(room.room.state.ball.x > 22.1);
        assert.equal(room.room.state.fte, 0);
        assert.equal(room.room.state.ftu, -1);
        assert.equal(room.room.status, 'voting');
        assert.equal(room.room.results, null);
        assert.deepEqual(room.room.lastResult, lastResult);
        for (const data of [...members, watcher]) {
            const frames = data.socket.received.filter(message => message.type === 'snapshot');
            assert.equal(frames.length, 1);
            assert.equal(frames[0].status, 'voting'); assert.equal(frames[0].phaseKind, 'mode-selection');
            assert.ok(frames[0].state.ball.x > 22.1);
            assert.equal(frames[0].inputs.some(Boolean), false);
        }
        room.room.vote.deadline = Date.now() - 1;
        room.pump(start + 200);
        assert.equal(room.room.status, 'voting');
        assert.equal(room.room.transition.kind, 'game'); assert.ok(room.room.state.ball.x > 22.1);
        const vote = structuredClone(room.room.vote);
        await command(room, members[0], {type:'modeVote', mode:'rockets'}); assert.deepEqual(room.room.vote, vote, 'the selected mode cannot change during its fade');
        await finishTransition(room);
        assert.equal(room.room.status, 'playing'); assert.equal(room.room.state.ftu, 120); assert.equal(room.room.vote, null);
    } finally {cleanup(env);}
});

test('Rockets results motion cannot score again, alter the turn clock, or change the final leaderboard', async () => {
    const env = environment();
    try {
        const {room, members} = await rocketsMatch(env, 1), attackerId = members[0].member.id;
        room.room.state.ftu = -1; room.room.state.fte = -1; room.room.state.scores[3] = 1;
        Object.assign(room.room.state.ball, {x:3, xv:-20, yv:0});
        room.room.rockets.records[attackerId] = {scored:true, speed:44.123, timeTicks:8};
        room.room.rockets.turnTicksLeft = 500; room.room.rockets.turnEnded = true;
        room.finishGame(null); room.stopTimer();
        const rockets = structuredClone(room.room.rockets), results = structuredClone(room.room.results);
        const lastResult = structuredClone(room.room.lastResult), chatCount = room.room.chat.length;
        for (let frame = 0; frame < 30; frame++) room.tick();
        assert.ok(room.room.state.ball.x < 30 / 11, 'coasting crosses the open goal plane');
        assert.deepEqual(room.room.state.scores, [0, 0, 0, 1]);
        assert.equal(room.room.state.fte, -1);
        assert.equal(room.room.status, 'results');
        assert.deepEqual(room.room.rockets, rockets);
        assert.deepEqual(room.room.results, results);
        assert.deepEqual(room.room.lastResult, lastResult);
        assert.equal(room.room.chat.length, chatCount);
        assert.equal(room.room.state.sts.some(sound => sound.i === 'footGoal' || sound.i === 'footKick'), false);
    } finally {cleanup(env);}
});

test('a restored Rockets leaderboard coasts until its original deadline, then fades directly to balanced lobby', async () => {
    const env = environment();
    let restored;
    try {
        const {room} = await rocketsMatch(env, 1);
        room.room.state.ftu = -1; room.room.state.fte = 0; room.room.state.scores[3] = 3;
        Object.assign(room.room.state.ball, {x:30, y:22, xv:12, yv:0});
        room.finishGame(null); room.stopTimer();
        const deadline = room.room.results.deadline, result = structuredClone(room.room.lastResult);
        await room.persist();
        restored = new FootballRoom(context(room.ctx.storage), env);
        await restored.ready;
        assert.equal(restored.room.status, 'results');
        assert.ok(restored.timer, 'results with resumable seats resume the fixed-step pump');
        restored.stopTimer();
        restored.tick();
        assert.ok(Math.abs(restored.room.state.ball.xv - 12 * 0.98) < 1e-9);
        assert.ok(restored.room.state.ball.x > 30);
        assert.equal(restored.room.state.fte, 0);
        assert.equal(restored.room.results.deadline, deadline);
        assert.deepEqual(restored.room.lastResult, result);
        restored.room.results.deadline = Date.now() - 1;
        restored.tick();
        assert.equal(restored.room.status, 'results'); assert.equal(restored.room.transition.kind, 'lobby');
        await finishTransition(restored);
        assert.equal(restored.room.status, 'lobby'); assert.equal(restored.room.mode, 'balanced'); assert.equal(restored.room.modeSelected, true); assert.equal(restored.room.vote, null);
        assert.equal(restored.room.state, null);
        assert.equal(restored.room.results, null);
        assert.equal(restored.timer, null);
        restored.tick();
        assert.equal(restored.room.status, 'lobby');
    } finally {restored?.stopTimer(); cleanup(env);}
});

test('an empty results room stops its simulation immediately while keeping the scheduled phase deadline', async () => {
    const env = environment();
    try {
        const {room, members} = await rocketsMatch(env, 1);
        room.finishGame(null);
        assert.ok(room.timer);
        const deadline = room.room.results.deadline;
        await command(room, members[0], {type:'leave'});
        assert.equal(room.room.members.length, 0);
        assert.equal(room.timer, null);
        assert.equal(room.room.results.deadline, deadline);
        assert.equal(room.pump(Date.now() + 100), 0);
        room.room.results.deadline = Date.now() - 1;
        await room.alarm();
        assert.equal(room.room.status, 'results'); assert.equal(room.room.transition.kind, 'lobby'); await finishTransition(room);
        assert.equal(room.room.status, 'lobby');
        assert.equal(room.room.results, null);
        assert.equal(room.room.state, null);
    } finally {cleanup(env);}
});

test('Rockets leaderboard returns through a fade to a balanced roster-only lobby with the result retained and Ready required', async () => {
    const env = environment();
    try {
        const {room, members} = await rocketsMatch(env, 2); room.finishGame(null); room.stopTimer();
        const result = structuredClone(room.room.lastResult), state = room.room.state;
        assert.equal(room.publicRoom().phaseKind, 'leaderboard');
        room.room.results.deadline = Date.now() - 1; await room.alarm();
        assert.equal(room.room.status, 'results'); assert.equal(room.room.state, state); assert.equal(room.room.transition.kind, 'lobby'); assert.equal(room.room.vote, null);
        await finishTransition(room);
        assert.equal(room.room.status, 'lobby'); assert.equal(room.room.mode, 'balanced'); assert.equal(room.room.modeSelected, true); assert.equal(room.room.vote, null); assert.equal(room.room.transition, null);
        assert.equal(room.room.state, null); assert.equal(room.timer, null); assert.deepEqual(room.room.lastResult, result);
        assert.ok(members.every(data => roster(room, data).team));
        await command(room, members[0], {type:'ready', ready:true}); assert.equal(room.room.status, 'lobby');
        await command(room, members[1], {type:'ready', ready:true}); room.stopTimer(); assert.equal(room.room.status, 'playing'); assert.equal(room.room.mode, 'balanced');
    } finally {cleanup(env);}
});

test('a queued arrival during a resolved mode fade enters only when its automatic next game starts', async () => {
    const env = environment();
    try {
        const {room, members} = await match(env, 1); room.finishGame(3); room.stopTimer();
        await command(room, members[0], {type:'modeVote', mode:'rockets'}); room.stopTimer();
        const selected = structuredClone(room.room.vote), deadline = room.room.transition.deadline;
        const arrival = await member(env, 'During fade', null, {vote:false}); room.stopTimer();
        assert.equal(roster(room, arrival).team, 0); assert.equal(roster(room, arrival).queued, true); assert.equal(room.room.transition.deadline, deadline);
        await command(room, arrival, {type:'modeVote', mode:'balanced'}); room.resolveModeVote();
        assert.deepEqual(room.room.vote, selected); assert.equal(room.room.mode, 'rockets');
        await finishTransition(room);
        assert.equal(room.room.status, 'playing'); assert.equal(room.room.mode, 'rockets'); assert.deepEqual(room.publicRockets().participantIds, members.concat(arrival).map(data => data.member.id));
        assert.equal(room.room.state.discs.filter(Boolean).length, 1);
    } finally {cleanup(env);}
});

test('saved continuation fades retain their chosen mode and deadline across a reconnect without reopening a vote', async () => {
    const env = environment(); let restored;
    try {
        const {room, members} = await match(env, 1); room.finishGame(3); room.stopTimer();
        await command(room, members[0], {type:'modeVote', mode:'rockets'}); room.stopTimer();
        room.room.transition.deadline = Date.now() + 10_000; const transition = {...room.room.transition}, voteId = room.room.vote.id; await room.persist();
        restored = new FootballRoom(context(room.ctx.storage), env); await restored.ready; restored.stopTimer(); env.objects.set(ID, restored);
        assert.equal(restored.room.status, 'voting'); assert.deepEqual(restored.room.transition, transition); assert.equal(restored.room.vote.id, voteId); assert.equal(restored.room.vote.resolved, true);
        const resumed = (await join(env, 'Ignored', {extra:{resumeToken:members[0].member.resumeToken}})).data; await connect(env, resumed); restored.stopTimer();
        assert.equal(restored.room.vote.id, voteId); assert.deepEqual(restored.room.transition, transition);
        await finishTransition(restored); assert.equal(restored.room.status, 'playing'); assert.equal(restored.room.mode, 'rockets'); assert.equal(restored.room.vote, null); assert.equal(restored.room.transition, null);
        restored.tick(); assert.equal(restored.room.state.ftu, 119, 'the completed transition cannot restart the match on its next tick');
    } finally {restored?.stopTimer(); cleanup(env);}
});

test('an expired saved game fade with no reconnected players safely returns to balanced lobby', async () => {
    const env = environment(); let restored;
    try {
        const {room, members} = await match(env, 1); room.finishGame(3); room.stopTimer();
        await command(room, members[0], {type:'modeVote', mode:'rockets'}); room.stopTimer(); room.room.transition.deadline = Date.now() - 1; await room.persist();
        restored = new FootballRoom(context(room.ctx.storage), env); await restored.ready; env.objects.set(ID, restored);
        assert.equal(restored.room.status, 'lobby'); assert.equal(restored.room.mode, 'balanced'); assert.equal(restored.room.modeSelected, true); assert.equal(restored.room.vote, null); assert.equal(restored.room.transition, null); assert.equal(restored.room.state, null); assert.equal(restored.timer, null);
        const resumed = (await join(env, 'Ignored', {extra:{resumeToken:members[0].member.resumeToken}})).data; await connect(env, resumed); restored.stopTimer();
        assert.equal(restored.room.status, 'lobby'); assert.equal(restored.room.vote, null); assert.equal(restored.room.state, null); assert.equal(restored.timer, null);
    } finally {restored?.stopTimer(); cleanup(env);}
});

test('old Balanced results checkpoints recover into a continuation vote while retaining the end state and score', async () => {
    const env = environment(); let restored;
    try {
        const {room} = await match(env, 1); room.room.state.scores[2] = 3; room.room.state.ball.xv = 12; room.finishGame(2); room.stopTimer();
        const state = structuredClone(room.room.state); room.room.status = 'results'; room.room.results = {...room.room.lastResult, deadline:Date.now() + 5000}; room.room.vote = null; delete room.room.transition; await room.persist();
        restored = new FootballRoom(context(room.ctx.storage), env); await restored.ready; restored.stopTimer();
        assert.equal(restored.room.status, 'voting'); assert.equal(restored.room.vote.continuation, true); assert.equal(restored.room.results, null); assert.equal(restored.room.transition, null); assert.deepEqual(restored.room.state, state);
        assert.equal(restored.publicRoom().vote.winner, 2); assert.deepEqual(restored.publicRoom().vote.scores, [0, 0, 3, 0]);
        restored.tick(); assert.ok(Math.abs(restored.room.state.ball.xv - 12 * 0.98) < 1e-9);
    } finally {restored?.stopTimer(); cleanup(env);}
});

test('the last explicit departure removes its coasting body immediately for public viewers in either end screen', async () => {
    for (const mode of ['balanced', 'rockets']) {
        const env = environment();
        try {
            const {room, members} = await (mode === 'rockets' ? rocketsMatch(env, 1) : match(env, 1)), viewer = await watch(env), slot = roster(room, members[0]).slot;
            room.finishGame(mode === 'rockets' ? null : 3); await command(room, members[0], {type:'leave'});
            assert.equal(room.room.members.length, 0); assert.equal(room.timer, null); assert.equal(room.room.state.discs[slot], null); assert.equal(room.room.state.players[slot], null);
            const update = viewer.socket.received.filter(message => message.type === 'room').at(-1).room; assert.equal(update.state.discs[slot], null); assert.equal(update.members.length, 0);
        } finally {cleanup(env);}
    }
});

test('public live viewers receive game snapshots and continuation coast without joining or gaining authority', async () => {
    const env = environment();
    try {
        const {room} = await match(env), beforeMembers = room.room.members.length, viewer = await watch(env), beforeActivity = room.room.lastActive;
        assert.equal(viewer.socket.received[0].type, 'watch'); assert.equal(viewer.socket.received[0].room.status, 'playing'); assert.equal(Object.hasOwn(viewer.socket.received[0].room, 'chat'), false);
        room.watchMessage(viewer.connection, JSON.stringify({type:'ping', sentAt:123})); assert.equal(viewer.socket.received.at(-1).type, 'pong'); assert.equal(viewer.socket.received.at(-1).sentAt, 123); assert.equal(room.room.lastActive, beforeActivity);
        room.tick(); room.tick(); assert.ok(viewer.socket.received.some(message => message.type === 'snapshot' && message.status === 'playing')); assert.equal(room.room.members.length, beforeMembers);
        room.room.state.ftu = -1; room.room.state.ball.xv = 2; room.finishGame(3); room.stopTimer(); const x = room.room.state.ball.x; room.tick(); room.tick();
        assert.ok(viewer.socket.received.some(message => message.type === 'snapshot' && message.status === 'voting' && message.phaseKind === 'mode-selection' && message.state.ball.x > x));
        assert.ok(viewer.socket.received.every(message => ['watch', 'room', 'snapshot', 'pong'].includes(message.type)));
    } finally {cleanup(env);}
});

test('watch sockets reject input, chat, joins, votes and admin commands without changing public game state', async () => {
    const env = environment();
    try {
        await request(env); const room = roomOf(env), before = JSON.stringify(room.publicRoom()), activity = room.room.lastActive;
        for (const message of [{type:'input', seq:1, flags:63}, {type:'chat', text:'private'}, {type:'join', identity:{username:'Forged', bonkId:'1'}}, {type:'modeVote', mode:'rockets'}, {type:'settings', settings:{scoreLimit:9}}, {type:'ping', padding:'x'.repeat(300)}]) {
            const viewer = await watch(env); room.watchMessage(viewer.connection, JSON.stringify(message)); assert.equal(viewer.socket.closed, true);
        }
        assert.equal(JSON.stringify(room.publicRoom()), before); assert.equal(room.room.lastActive, activity); assert.equal(room.room.members.length, 0); assert.equal(room.connections.size, 0); assert.equal(room.tickets.size, 0); assert.equal(room.timer, null);
    } finally {cleanup(env);}
});

test('watch handshakes enforce origin, capacity, global rate limiting and independent heartbeat expiry', async () => {
    const env = environment();
    try {
        assert.equal((await request(env, '/watch', undefined, null, {Upgrade:'websocket', Origin:'https://evil.test'})).status, 403);
        assert.equal((await request(env, '/watch')).status, 426); assert.equal((await request(env, '/watch', {})).status, 404);
        const viewers = []; for (let i = 0; i < LIMITS.MAX_WATCHERS; i++) viewers.push(await watch(env)); const room = roomOf(env);
        assert.equal((await request(env, '/watch', undefined, null, {Upgrade:'websocket'})).status, 409); assert.equal(room.room.members.length, 0); assert.equal(room.timer, null);
        const alarm = room.ctx.storage.alarm; room.watchMessage(viewers[0].connection, JSON.stringify({type:'ping'})); assert.equal(room.ctx.storage.alarm, alarm);
        viewers[0].connection.lastMessageAt = Date.now() - LIMITS.HEARTBEAT_TTL - 1; await room.alarm(); assert.equal(viewers[0].socket.closed, true); assert.equal(room.watchers.size, LIMITS.MAX_WATCHERS - 1);
        room.room.lastActive = Date.now() - LIMITS.IDLE_TTL - 1; await room.alarm(); assert.equal(room.watchers.size, 0); assert.ok(viewers.every(viewer => viewer.socket.closed)); assert.equal(room.timer, null);
        env.API_RATE_LIMITER.limit = async () => ({success:false});
        const throttled = await worker.fetch(new Request('https://api.test/api/football/watch', {headers:{Origin:origin, Upgrade:'websocket'}}), env); assert.equal(throttled.status, 429);
    } finally {cleanup(env);}
});

test('chat is delivered only live to joined members and never stored, replayed or included in watch/info/room payloads', async () => {
    const env = environment();
    try {
        const first = await member(env, 'First'), room = roomOf(env), viewer = await watch(env), marker = 'Only joined live recipients see this';
        await command(room, first, {type:'chat', text:marker}); assert.equal(first.socket.received.filter(message => message.type === 'chat').length, 1); assert.deepEqual(room.room.chat, []);
        const info = await (await request(env)).json(); assert.equal(Object.hasOwn(info.room, 'chat'), false); assert.equal(JSON.stringify(info).includes(marker), false);
        const later = (await join(env, 'Later')).data; assert.equal(JSON.stringify(later).includes(marker), false); const laterSocket = await connect(env, later); assert.equal(laterSocket.received.some(message => message.type === 'chat'), false);
        const resumed = (await join(env, 'First', {extra:{resumeToken:first.member.resumeToken}})).data, resumedSocket = await connect(env, resumed); assert.equal(resumedSocket.received.some(message => message.type === 'chat'), false);
        room.broadcastRoom(); room.systemChat('Current system announcement');
        assert.equal(laterSocket.received.filter(message => message.type === 'chat').length, 1); assert.equal(viewer.socket.received.some(message => message.type === 'chat'), false);
        assert.equal(JSON.stringify(viewer.socket.received).includes(marker), false); assert.equal(JSON.stringify(viewer.socket.received).includes('Current system announcement'), false);
        await room.persist(); assert.deepEqual((await room.ctx.storage.get('checkpoint')).room.chat, []);
    } finally {cleanup(env);}
});

test('join preferences are whitelisted before the first assignment and balanced mode honors feasible requests', async () => {
    const env = environment();
    try {
        const red = (await join(env, 'Red', {extra:{preferredTeam:2}})).data; await connect(env, red); const room = roomOf(env);
        assert.equal(roster(room, red).preferredTeam, 2); assert.equal(roster(room, red).team, 2);
        const blue = (await join(env, 'Blue', {extra:{preferredTeam:3}})).data; await connect(env, blue); assert.equal(roster(room, blue).team, 3);
        assert.equal((await join(env, 'Invalid', {extra:{preferredTeam:4}})).response.status, 400); assert.equal((await join(env, 'Invalid', {extra:{preferredTeam:'3'}})).response.status, 400); assert.equal(room.room.members.length, 2);
        await command(room, red, {type:'modeVote', mode:'balanced'}); await command(room, blue, {type:'modeVote', mode:'balanced'});
        await command(room, red, {type:'preference', team:3}); await command(room, blue, {type:'preference', team:2});
        assert.equal(roster(room, red).team, 3); assert.equal(roster(room, blue).team, 2); assert.equal(roster(room, red).queueTeam, 0); assert.equal(roster(room, red).queued, false);
        assert.equal(room.publicRoom().members.find(member => member.id === red.member.id).preferredTeam, 3);
    } finally {cleanup(env);}
});

test('Rockets preferences preserve turn order and clock, allow one side swap, and credit the actual attacker team', async () => {
    const env = environment();
    try {
        const {room, members} = await rocketsMatch(env), attacker = members[0], defender = members[1], order = [...room.room.rockets.participantIds];
        room.room.state.ftu = -1; for (let i = 0; i < 5; i++) room.tick(); const ticks = room.room.rockets.turnTicksLeft;
        await command(room, defender, {type:'preference', team:3}); assert.equal(room.room.rockets.attackerTeam, 3); assert.equal(roster(room, defender).team, 0); assert.equal(roster(room, defender).queued, true); assert.equal(room.room.rockets.participantIds.includes(defender.member.id), true);
        await command(room, attacker, {type:'preference', team:2});
        assert.equal(room.room.rockets.attackerTeam, 2); assert.equal(room.publicRoom().rockets.sideChangeUsed, true); assert.equal(room.room.rockets.turnTicksLeft, ticks); assert.equal(room.room.rockets.turnIndex, 1); assert.deepEqual(room.room.rockets.participantIds, order); assert.equal(room.room.state.ftu, 120);
        assert.equal(roster(room, attacker).team, 2); assert.equal(roster(room, defender).team, 0); assert.equal(roster(room, defender).queued, true); assert.equal(room.room.state.discs.filter(Boolean).length, 1); assert.equal(roster(room, attacker).queued, false);
        await command(room, attacker, {type:'preference', team:3}); assert.equal(roster(room, attacker).preferredTeam, 3); assert.equal(room.room.rockets.attackerTeam, 2); assert.equal(room.room.rockets.turnTicksLeft, ticks);
        room.room.state.ftu = -1; room.room.state.ball.x = 29 / 11; room.room.state.ball.xv = -20; room.tick();
        assert.equal(room.room.state.lscr, 2); assert.equal(room.publicRoom().rockets.leaderboard.find(row => row.id === attacker.member.id).scored, true); assert.equal(attacker.socket.received.filter(message => message.type === 'chat' && message.system).length, 1);
        for (let i = 0; i < 91; i++) room.tick(); assert.equal(room.room.rockets.attackerId, defender.member.id); assert.equal(room.room.rockets.attackerTeam, 3); assert.equal(room.room.rockets.sideChangeUsed, false);
    } finally {cleanup(env);}
});

test('Random Rockets sides alternate deterministically and opponent goals never become attacker records', async () => {
    const env = environment();
    try {
        const {room, members} = await rocketsMatch(env); assert.equal(room.room.rockets.attackerTeam, 3);
        room.room.state.ftu = -1; room.room.rockets.turnTicksLeft = 1; room.tick(); assert.equal(room.room.rockets.attackerId, members[1].member.id); assert.equal(room.room.rockets.attackerTeam, 2);
        room.room.state.ftu = -1; room.room.state.ball.x = 701 / 11; room.room.state.ball.xv = 20; room.tick();
        assert.equal(room.room.state.lscr, 3); assert.equal(room.publicRoom().rockets.leaderboard.find(row => row.id === members[1].member.id).scored, false); assert.equal(members[1].socket.received.filter(message => message.type === 'chat' && message.system).length, 0);
    } finally {cleanup(env);}
});

test('offline lobby seats excluded from a Rockets start cannot leave active ghost discs', async () => {
    const env = environment();
    try {
        const people = []; for (let i = 0; i < 3; i++) people.push(await member(env, 'Rocket ' + i, null, {vote:false})); const room = roomOf(env);
        for (const data of people) await command(room, data, {type:'modeVote', mode:'rockets'});
        const offlineSlot = roster(room, people[2]).slot; people[2].socket.close(1001, 'before game');
        await command(room, people[0], {type:'ready', ready:true}); await command(room, people[1], {type:'ready', ready:true}); room.stopTimer();
        assert.equal(room.room.status, 'playing'); assert.equal(room.room.rockets.totalTurns, 2); assert.equal(roster(room, people[2]).team, 0); assert.equal(roster(room, people[2]).queued, true); assert.equal(room.room.state.discs[offlineSlot] || null, null);
    } finally {cleanup(env);}
});

test('regular team commands request balanced lobby places, retain preference on opt-out, and queue spectators for the next game', async () => {
    const env = environment();
    try {
        const first = await member(env, 'First'), second = await member(env, 'Second'), room = roomOf(env);
        await command(room, second, {type:'team', team:3}); assert.equal(roster(room, second).team, 3); assert.equal(roster(room, second).preferredTeam, 3); assert.equal(roster(room, second).queued, false);
        await command(room, second, {type:'team', team:0}); assert.equal(roster(room, second).team, 0); assert.equal(roster(room, second).queued, false); assert.equal(roster(room, second).preferredTeam, 3);
        await command(room, first, {type:'ready', ready:true}); room.stopTimer(); assert.equal(room.room.status, 'playing');
        const firstTeam = roster(room, first).team;
        await command(room, second, {type:'team', team:2}); assert.equal(roster(room, second).team, 0); assert.equal(roster(room, second).queued, true); assert.equal(roster(room, second).preferredTeam, 2); assert.ok(roster(room, second).queueOrder);
        await command(room, first, {type:'team', team:firstTeam === 2 ? 3 : 2}); assert.equal(roster(room, first).team, firstTeam); assert.equal(roster(room, first).queued, false);
        room.room.state.fte = 0; room.tick(); assert.equal(room.room.state.discs.filter(Boolean).length, 1); assert.equal(room.room.state.discs[roster(room, second).slot] || null, null);
    } finally {cleanup(env);}
});

test('waiting Rockets team requests preserve participant order and never create a second disc', async () => {
    const env = environment();
    try {
        const {room, members} = await rocketsMatch(env, 3), order = [...room.room.rockets.participantIds], queueOrder = roster(room, members[1]).queueOrder;
        await command(room, members[1], {type:'team', team:2}); assert.deepEqual(room.room.rockets.participantIds, order); assert.equal(roster(room, members[1]).queueOrder, queueOrder); assert.equal(roster(room, members[1]).team, 0); assert.equal(roster(room, members[1]).preferredTeam, 2);
        room.room.state.ftu = -1; room.room.rockets.turnTicksLeft = 1; room.tick(); assert.equal(room.room.rockets.attackerId, members[1].member.id); assert.equal(room.room.rockets.attackerTeam, 2); assert.equal(room.room.state.discs.filter(Boolean).length, 1); assert.deepEqual(room.room.rockets.participantIds, order);
        await command(room, members[2], {type:'team', team:0}); assert.equal(room.room.rockets.participantIds.includes(members[2].member.id), false); assert.equal(roster(room, members[2]).queued, false); assert.equal(room.room.state.discs.filter(Boolean).length, 1);
    } finally {cleanup(env);}
});

test('pre-existing and newly joined queues cannot fill a vacancy during goals or rebalance', async () => {
    const env = environment();
    try {
        const people = []; for (let i = 0; i < 9; i++) people.push(await member(env, 'Player ' + i)); const room = roomOf(env);
        for (const data of people.slice(0, 8)) await command(room, data, {type:'ready', ready:true}); room.stopTimer(); assert.equal(room.room.status, 'playing');
        const late = await member(env, 'Late'); await command(room, people[0], {type:'leave'});
        for (const data of [...people.slice(1), late]) await command(room, data, {type:'rebalanceVote', yes:true});
        assert.equal(room.room.rebalanceVote, null); assert.equal(room.room.state.discs.filter(Boolean).length, 7);
        assert.equal(roster(room, people[8]).team, 0); assert.equal(roster(room, late).team, 0); assert.equal(room.promoteQueue(), false);
        room.room.state.fte = 0; room.room.state.scores[2] = 1; room.tick(); assert.equal(room.room.state.discs.filter(Boolean).length, 7); assert.equal(roster(room, people[8]).queued, true); assert.equal(roster(room, late).queued, true);
    } finally {cleanup(env);}
});

test('when the last active player leaves, the current game ends before queued players enter a new lobby', async () => {
    const env = environment();
    try {
        const {room, members} = await match(env, 1), late = await member(env, 'Late'); assert.equal(roster(room, late).team, 0);
        await command(room, members[0], {type:'leave'}); assert.notEqual(room.room.status, 'playing'); assert.equal(room.room.state, null); assert.ok(roster(room, late).team); assert.equal(room.timer, null);
    } finally {cleanup(env);}
});

test('forged obsolete brake input is stripped while normal movement remains active', async () => {
    const env = environment();
    try {
        const {room, members} = await match(env, 1), slot = roster(room, members[0]).slot; room.room.state.ftu = -1;
        await command(room, members[0], {type:'input', seq:1, flags:32}); assert.equal(room.inputs[slot], 0);
        const start = room.room.state.discs[slot].x; await command(room, members[0], {type:'input', seq:2, flags:33}); room.tick(); room.tick();
        assert.equal(room.inputs[slot], 1); assert.equal(room.effectiveInputs[slot], 1); assert.ok(room.room.state.discs[slot].x < start);
        const frame = members[0].socket.received.filter(message => message.type === 'snapshot').at(-1); assert.equal(frame.inputs[slot], 1);
        await command(room, members[0], {type:'input', seq:3, flags:63}); assert.equal(room.inputs[slot], 31);
    } finally {cleanup(env);}
});

test('quick kick taps survive between ticks with ASD held and a second tap gets its native release-to-rearm step', async () => {
    const env = environment();
    try {
        const {room, members} = await match(env, 1), data = members[0], slot = roster(room, data).slot; room.room.state.ftu = -1;
        const placeBall = () => {const disc = room.room.state.discs[slot]; Object.assign(room.room.state.ball, {x:disc.x + 2.1, y:disc.y, xv:0, yv:0});};
        placeBall(); await command(room, data, {type:'input', seq:1, flags:27}); await command(room, data, {type:'input', seq:2, flags:11});
        assert.equal(room.inputs[slot], 11); assert.equal(room.pendingHeavy[slot], true); room.tick();
        assert.equal(room.effectiveInputs[slot], 27); assert.equal(room.pendingHeavy[slot], false); assert.equal(room.room.state.discs[slot].kickReady, false); assert.ok(room.room.state.ball.xv > 24);
        placeBall(); await command(room, data, {type:'input', seq:3, flags:27}); await command(room, data, {type:'input', seq:4, flags:11}); room.tick();
        assert.equal(room.effectiveInputs[slot], 11); assert.equal(room.pendingHeavy[slot], true); assert.equal(room.room.state.discs[slot].kickReady, true); assert.ok(Math.abs(room.room.state.ball.xv) < 1);
        room.tick(); assert.equal(room.effectiveInputs[slot], 27); assert.equal(room.pendingHeavy[slot], false); assert.equal(room.room.state.discs[slot].kickReady, false); assert.ok(room.room.state.ball.xv > 24); assert.equal(room.room.state.sts.filter(sound => sound.i === 'footKick' && sound.f === 10).length, 1);
        room.tick(); assert.equal(room.effectiveInputs[slot], 11); assert.equal(room.room.state.discs[slot].kickReady, true);
    } finally {cleanup(env);}
});

test('pending kick edges are bounded and cleared by kickoff, disconnect and results', async () => {
    const env = environment();
    try {
        const {room, members} = await match(env, 1), data = members[0], slot = roster(room, data).slot; room.room.state.ftu = -1;
        for (let seq = 1; seq <= 10; seq++) await command(room, data, {type:'input', seq, flags:seq % 2 ? 16 : 0});
        assert.equal(room.pendingHeavy[slot], true); room.room.state.fte = 0; room.tick(); assert.equal(room.pendingHeavy[slot] || false, false); assert.equal(room.room.state.ftu, 120);
        room.room.state.ftu = -1; await command(room, data, {type:'input', seq:11, flags:16}); await command(room, data, {type:'input', seq:12, flags:0}); assert.equal(room.pendingHeavy[slot], true);
        room.finishGame(3); room.stopTimer(); assert.equal(room.pendingHeavy[slot] || false, false);
        room.abort('test'); await command(room, data, {type:'ready', ready:true}); room.stopTimer(); room.room.state.ftu = -1;
        await command(room, data, {type:'input', seq:13, flags:16}); assert.equal(room.pendingHeavy[slot], true); data.socket.close(1001, 'gone'); assert.equal(room.pendingHeavy[slot], false); assert.equal(room.inputs[slot], 0);
    } finally {cleanup(env);}
});

test('disconnects cannot turn an expired minority rebalance vote into a winning kickoff reset', async () => {
    const env = environment();
    try {
        const {room, members} = await match(env, 3); room.room.state.ftu = -1; room.room.state.scores[2] = 1; room.openRebalanceVote();
        await command(room, members[0], {type:'rebalanceVote', yes:true}); assert.ok(room.room.rebalanceVote); assert.equal(room.publicRoom().rebalanceVote.counts.yes, 1);
        const state = room.room.state, teams = room.room.members.map(member => [member.id, member.team]); room.room.rebalanceVote.deadline = Date.now() - 1;
        members[1].socket.close(1001, 'lost'); members[2].socket.close(1001, 'lost');
        assert.equal(room.room.rebalanceVote, null); assert.equal(room.room.balanceDeferred, true); assert.equal(room.room.state, state); assert.equal(room.room.state.ftu, -1); assert.equal(room.room.state.scores[2], 1); assert.deepEqual(room.room.members.map(member => [member.id, member.team]), teams);
        room.openRebalanceVote(); room.room.rebalanceVote.votes[members[0].member.id] = true; room.resolveRebalanceVote(true);
        assert.equal(room.room.rebalanceVote, null); assert.equal(room.room.state, state); assert.equal(room.room.balanceDeferred, true);
    } finally {cleanup(env);}
});

test('lobby team selection grants no bodies or controls until readiness starts a real match', async () => {
    const env = environment();
    try {
        const first = await member(env, 'First'), second = await member(env, 'Second'), spectator = await member(env, 'Spectator'), room = roomOf(env);
        await command(room, spectator, {type:'team', team:0}); const slot = roster(room, first).slot, spectatorSlot = roster(room, spectator).slot;
        assert.equal(room.room.status, 'lobby'); assert.equal(room.room.state, null); assert.equal(room.timer, null); assert.ok(roster(room, first).team);
        const step = room.physics.step; room.physics.step = () => assert.fail('lobby actions must never run physics');
        await command(room, first, {type:'input', seq:1, flags:31}); await command(room, spectator, {type:'input', seq:1, flags:31}); room.tick(); room.tick(); assert.equal(room.pump(Date.now() + 200), 0);
        assert.equal(room.inputs[slot], 0); assert.equal(room.inputs[spectatorSlot], 0); assert.equal(room.pendingHeavy[slot] || false, false); assert.equal(room.room.state, null); assert.equal(room.timer, null);
        assert.equal(first.socket.received.some(message => message.type === 'snapshot'), false);
        await command(room, first, {type:'ready', ready:true}); room.tick(); assert.equal(roster(room, first).ready, true); assert.equal(roster(room, second).ready, false); assert.equal(room.room.status, 'lobby'); assert.equal(room.room.state, null);
        room.physics.step = step;
        await command(room, second, {type:'ready', ready:true}); assert.ok(room.timer); room.stopTimer(); assert.equal(room.room.status, 'playing'); assert.equal(room.room.state.ftu, 120); assert.deepEqual(room.room.state.scores, [0, 0, 0, 0]);
        assert.equal(room.room.state.discs.filter(Boolean).length, 2); assert.equal(room.room.state.discs[spectatorSlot] || null, null); assert.equal(room.inputs[slot] || 0, 0);
        room.room.state.ftu = -1; const x = room.room.state.discs[slot].x; await command(room, first, {type:'input', seq:2, flags:2}); room.tick(); assert.ok(room.room.state.discs[slot].x > x);
    } finally {cleanup(env);}
});

test('lobby roster changes update teams and reused slots without spawning a field until the game starts', async () => {
    const env = environment();
    try {
        const first = await member(env, 'First'), second = await member(env, 'Second'), room = roomOf(env), slot = roster(room, second).slot;
        await command(room, first, {type:'team', team:2}); assert.equal(roster(room, first).preferredTeam, 2); assert.equal(room.room.state, null); assert.equal(room.timer, null);
        await command(room, second, {type:'leave'}); const third = await member(env, 'Third'); assert.equal(roster(room, third).slot, slot); assert.equal(room.room.state, null); assert.equal(room.timer, null);
        await command(room, first, {type:'ready', ready:true}); await command(room, third, {type:'ready', ready:true}); room.stopTimer();
        assert.equal(room.room.status, 'playing'); assert.equal(room.room.state.players[slot].name, 'Third'); assert.equal(room.room.state.discs.filter(Boolean).length, 2);
    } finally {cleanup(env);}
});

test('admin Apply updates lobby configuration immediately but creates no field until Start', async () => {
    const env = environment();
    try {
        const admin = await member(env, 'Admin', await administrator(env)), room = roomOf(env);
        await command(room, admin, {type:'settings', settings:{pitchWidth:900, moveForce:0, ballRadius:1.1}});
        assert.equal(room.room.settings.pitchWidth, 900); assert.equal(room.room.pendingSettings, null); assert.equal(room.room.state, null); assert.equal(room.publicRoom().state, null); assert.equal(room.timer, null);
        await command(room, admin, {type:'start'}); assert.ok(room.timer); room.stopTimer();
        assert.equal(room.room.state.settings.pitchWidth, 900); assert.equal(room.room.state.settings.ballRadius, 1.1); assert.equal(room.room.state.ftu, 120); assert.equal(room.room.state.ball.x, 450 / 11);
        const slot = roster(room, admin).slot, x = room.room.state.discs[slot].x; room.room.state.ftu = -1; await command(room, admin, {type:'input', seq:1, flags:1}); room.tick(); assert.equal(room.room.state.discs[slot].x, x);
    } finally {cleanup(env);}
});

test('legacy lobby-practice checkpoints discard old bodies on restore and remain roster-only after reconnect', async () => {
    const env = environment(); let restored;
    try {
        const {room, members} = await match(env, 1); room.room.status = 'lobby'; room.room.state.ftu = -1; await room.persist();
        restored = new FootballRoom(context(room.ctx.storage), env); await restored.ready; env.objects.set(ID, restored);
        assert.equal(restored.room.status, 'lobby'); assert.equal(restored.room.state, null); assert.equal(restored.canSimulate(), false); assert.equal(restored.timer, null);
        const resumed = (await join(env, 'Ignored', {extra:{resumeToken:members[0].member.resumeToken}})).data; const socket = await connect(env, resumed);
        await command(restored, resumed, {type:'input', seq:1, flags:31}); restored.tick();
        assert.equal(restored.room.state, null); assert.equal(restored.timer, null); assert.equal(restored.inputs[roster(restored, resumed).slot], 0); assert.equal(socket.received[0].room.state, null);
    } finally {restored?.stopTimer(); cleanup(env);}
});

test('pending admin settings compose atomically and apply at the next goal kickoff, with an immediate public acknowledgement', async () => {
    const env = environment();
    try {
        const admin = await member(env, 'Admin', await administrator(env)), player = await member(env, 'Player'), room = roomOf(env);
        await command(room, admin, {type:'start'}); room.stopTimer();
        await command(room, admin, {type:'settings', settings:{pitchWidth:900, moveForce:10}}); room.stopTimer();
        await command(room, admin, {type:'settings', settings:{kickImpulse:30}}); room.stopTimer();
        const pending = structuredClone(room.room.pendingSettings); assert.equal(pending.pitchWidth, 900); assert.equal(pending.moveForce, 10); assert.equal(pending.kickImpulse, 30); assert.equal(room.room.settings.pitchWidth, 730); assert.equal(room.room.settings.moveForce, 32);
        await command(room, admin, {type:'settings', settings:{goalHeight:40, pitchHeight:300}}); await command(room, player, {type:'settings', settings:{moveForce:0}}); room.stopTimer(); assert.deepEqual(room.room.pendingSettings, pending);
        await room.persist(); assert.deepEqual((await room.ctx.storage.get('checkpoint')).room.pendingSettings, pending);
        room.openRebalanceVote(); await command(room, admin, {type:'rebalanceVote', yes:true}); await command(room, player, {type:'rebalanceVote', yes:true}); room.stopTimer(); assert.deepEqual(room.room.pendingSettings, pending); assert.equal(room.room.settings.pitchWidth, 730);
        room.room.state.fte = 0; room.room.state.scores[2] = 1; room.tick();
        assert.equal(room.room.pendingSettings, null); assert.equal(room.room.settings.pitchWidth, 900); assert.equal(room.room.state.settings.kickImpulse, 30); assert.equal(room.room.state.settings.moveForce, 10); assert.equal(room.room.state.scores[2], 1); assert.equal(room.room.state.ftu, 120);
        const acknowledgement = admin.socket.received.filter(message => message.type === 'room').at(-1).room; assert.equal(acknowledgement.pendingSettings, null); assert.equal(acknowledgement.settings.pitchWidth, 900);
    } finally {cleanup(env);}
});

test('Rockets pending settings wait through a side swap and apply only when the next attacker turn begins', async () => {
    const env = environment();
    try {
        const admin = await member(env, 'Admin', await administrator(env), {vote:false}), player = await member(env, 'Player', null, {vote:false}), room = roomOf(env);
        for (const data of [admin, player]) await command(room, data, {type:'modeVote', mode:'rockets'});
        await command(room, admin, {type:'ready', ready:true}); await command(room, player, {type:'ready', ready:true}); room.stopTimer();
        await command(room, admin, {type:'settings', settings:{pitchWidth:900, kickImpulse:20}}); room.stopTimer(); assert.equal(room.room.settings.pitchWidth, 730); assert.equal(room.room.pendingSettings.pitchWidth, 900);
        await command(room, admin, {type:'preference', team:2}); room.stopTimer(); assert.equal(room.room.rockets.attackerId, admin.member.id); assert.equal(room.room.settings.pitchWidth, 730); assert.equal(room.room.pendingSettings.pitchWidth, 900);
        room.room.state.ftu = -1; room.room.rockets.turnTicksLeft = 1; room.tick();
        assert.equal(room.room.rockets.attackerId, player.member.id); assert.equal(room.room.pendingSettings, null); assert.equal(room.room.settings.pitchWidth, 900); assert.equal(room.room.state.settings.kickImpulse, 20);
        const acknowledgement = player.socket.received.filter(message => message.type === 'room').at(-1).room; assert.equal(acknowledgement.pendingSettings, null); assert.equal(acknowledgement.settings.pitchWidth, 900);
    } finally {cleanup(env);}
});

test('settings applied during results and voting remain pending until the next game starts', async () => {
    const env = environment();
    try {
        const admin = await member(env, 'Admin', await administrator(env)), player = await member(env, 'Player'), room = roomOf(env);
        await command(room, admin, {type:'start'}); room.stopTimer(); room.finishGame(3); room.stopTimer(); assert.equal(room.room.status, 'voting');
        await command(room, admin, {type:'settings', settings:{ballRadius:1.5}}); room.stopTimer(); assert.equal(room.room.settings.ballRadius, 0.7); assert.equal(room.room.pendingSettings.ballRadius, 1.5);
        await command(room, admin, {type:'settings', settings:{playerRadius:1.3}}); assert.equal(room.room.pendingSettings.ballRadius, 1.5); assert.equal(room.room.pendingSettings.playerRadius, 1.3);
        for (const data of [admin, player]) await command(room, data, {type:'modeVote', mode:'rockets'}); room.stopTimer(); assert.equal(room.room.status, 'voting'); assert.equal(room.room.settings.ballRadius, 0.7); assert.equal(room.room.pendingSettings.ballRadius, 1.5);
        await finishTransition(room); assert.equal(room.room.status, 'playing'); assert.equal(room.room.mode, 'rockets'); assert.equal(room.room.pendingSettings, null); assert.equal(room.room.state.settings.ballRadius, 1.5); assert.equal(room.room.state.settings.playerRadius, 1.3);
        room.finishGame(null); room.stopTimer(); await command(room, admin, {type:'settings', settings:{pitchWidth:900}}); room.stopTimer();
        room.room.results.deadline = Date.now() - 1; await room.alarm(); await finishTransition(room);
        assert.equal(room.room.status, 'lobby'); assert.equal(room.room.mode, 'balanced'); assert.equal(room.room.settings.pitchWidth, 730); assert.equal(room.room.pendingSettings.pitchWidth, 900);
        for (const data of [admin, player]) await command(room, data, {type:'ready', ready:true}); room.stopTimer(); assert.equal(room.room.status, 'playing'); assert.equal(room.room.settings.pitchWidth, 900); assert.equal(room.room.pendingSettings, null);
    } finally {cleanup(env);}
});

test('a pending lower score limit finishes at the goal boundary while old field geometry and motion coast without teleporting', async () => {
    const env = environment();
    try {
        const admin = await member(env, 'Admin', await administrator(env)), player = await member(env, 'Player'), room = roomOf(env);
        await command(room, admin, {type:'start'}); room.stopTimer(); room.room.state.ftu = -1; room.room.state.scores[2] = 1;
        await command(room, admin, {type:'settings', settings:{scoreLimit:2, pitchWidth:900, ballRadius:1.1}}); room.stopTimer();
        Object.assign(room.room.state.ball, {x:29 / 11, y:250 / 11, xv:-20, yv:0}); room.tick(); assert.equal(room.room.state.scores[2], 2); assert.equal(room.room.state.fte, 90);
        for (let frame = 0; frame < 90; frame++) room.tick(); const boundary = room.room.state, ball = {...boundary.ball}, discs = structuredClone(boundary.discs);
        assert.equal(boundary.fte, 0); assert.equal(room.room.settings.scoreLimit, 3); assert.equal(getPitchGeometry(boundary).pixels.width, 730);
        room.tick(); room.stopTimer();
        assert.equal(room.room.status, 'voting'); assert.equal(room.room.winner, 2); assert.equal(room.room.pendingSettings, null); assert.equal(room.room.settings.scoreLimit, 2); assert.equal(room.room.settings.pitchWidth, 900);
        assert.equal(room.room.state, boundary); assert.deepEqual(room.room.state.ball, ball); assert.deepEqual(room.room.state.discs, discs); assert.equal(getPitchGeometry(room.room.state).pixels.width, 730); assert.ok(Math.abs(getPitchGeometry(room.room.state).pixels.ballRadius - 7.7) < 1e-9);
        room.tick(); assert.equal(getPitchGeometry(room.room.state).pixels.width, 730); assert.ok(Math.abs(room.room.state.ball.x - ball.x) < 5); assert.notEqual(room.room.state.ball.x, 450 / 11); assert.deepEqual(room.room.state.scores, [0, 0, 2, 0]);
        const acknowledgement = admin.socket.received.filter(message => message.type === 'room').at(-1).room; assert.equal(acknowledgement.settings.pitchWidth, 900); assert.equal(acknowledgement.pendingSettings, null);
        for (const data of [admin, player]) await command(room, data, {type:'modeVote', mode:'balanced'});
        await finishTransition(room); assert.equal(room.room.status, 'playing'); assert.equal(getPitchGeometry(room.room.state).pixels.width, 900); assert.equal(room.room.state.settings.ballRadius, 1.1); assert.equal(room.room.state.ftu, 120);
    } finally {cleanup(env);}
});

test('an activated linked Bonk login administers football without an elevated session while main-site gates still require the code', async () => {
    const env = environment();
    try {
        const auth = await administrator(env); env.db.prepare('DELETE FROM admin_session_identity').run(); env.db.prepare('DELETE FROM admin_sessions').run();
        const headers = {Origin:origin, 'Content-Type':'application/json', 'X-Account-Session':auth.userToken};
        const response = await worker.fetch(new Request('https://api.test/api/football/lobby', {method:'POST', headers, body:JSON.stringify({displayName:'Ignored'})}), env); assert.equal(response.status, 200);
        const joined = await response.json(), socket = await connect(env, joined), admin = {...joined, socket}, room = roomOf(env);
        assert.equal(roster(room, admin).admin, true); await command(room, admin, {type:'modeVote', mode:'balanced'}); await command(room, admin, {type:'settings', settings:{moveForce:0}}); assert.equal(room.room.settings.moveForce, 0);
        const sessionResponse = await worker.fetch(new Request('https://api.test/api/session', {headers}), env), session = await sessionResponse.json(); assert.equal(session.user.id, auth.bonkId); assert.equal(session.authenticated, false); assert.equal(session.code_verified, false);
        assert.equal((await worker.fetch(new Request('https://api.test/api/accounts', {headers}), env)).status, 403);
        assert.equal((await worker.fetch(new Request('https://api.test/api/players', {method:'POST', headers, body:JSON.stringify({name:'Blocked assessment'})}), env)).status, 401);
    } finally {cleanup(env);}
});

test('expired or missing admin-session tokens have no effect on football authority', async () => {
    const env = environment();
    try {
        const auth = await administrator(env); env.db.prepare('UPDATE admin_sessions SET expires_at=0').run();
        const headers = {Origin:origin, 'Content-Type':'application/json', 'X-Account-Session':auth.userToken, Authorization:'Bearer ' + auth.adminToken};
        const response = await worker.fetch(new Request('https://api.test/api/football/lobby', {method:'POST', headers, body:'{}'}), env); assert.equal(response.status, 200);
        const data = await response.json(), socket = await connect(env, data), admin = {...data, socket}, room = roomOf(env);
        assert.equal(roster(room, admin).admin, true); await command(room, admin, {type:'modeVote', mode:'balanced'}); await command(room, admin, {type:'settings', settings:{scoreLimit:4}}); assert.equal(room.room.settings.scoreLimit, 4);
        env.db.prepare('DELETE FROM admin_session_identity').run(); env.db.prepare('DELETE FROM admin_sessions').run();
        await command(room, admin, {type:'settings', settings:{scoreLimit:5}}); assert.equal(room.room.settings.scoreLimit, 5); assert.equal(roster(room, admin).admin, true);
    } finally {cleanup(env);}
});

test('unactivated and unlinked users cannot obtain football administration through claimed JSON roles or another admin token', async () => {
    const env = environment();
    try {
        const activated = await administrator(env), ordinary = await administrator(env, 'b'); env.db.prepare('UPDATE admin_credentials SET code_hash=NULL WHERE account_id=?').run(ordinary.adminAccountId);
        const headers = {Origin:origin, 'Content-Type':'application/json', 'X-Account-Session':ordinary.userToken, Authorization:'Bearer ' + activated.adminToken};
        const forged = {admin:true, adminAccountId:activated.adminAccountId, userSessionHash:activated.userSessionHash, identity:{username:activated.username, bonkId:activated.bonkId}};
        const response = await worker.fetch(new Request('https://api.test/api/football/lobby', {method:'POST', headers, body:JSON.stringify(forged)}), env); assert.equal(response.status, 200);
        const data = await response.json(), socket = await connect(env, data), user = {...data, socket}, room = roomOf(env); assert.equal(roster(room, user).name, ordinary.username); assert.equal(roster(room, user).admin, false);
        await command(room, user, {type:'modeVote', mode:'balanced'}); await command(room, user, {type:'settings', settings:{scoreLimit:9}}); assert.equal(room.room.settings.scoreLimit, 3);
        env.db.prepare('UPDATE admin_credentials SET code_hash=? WHERE account_id=?').run('activated', ordinary.adminAccountId); env.db.prepare('DELETE FROM admin_bonk_links WHERE account_id=?').run(ordinary.adminAccountId);
        await command(room, user, {type:'settings', settings:{scoreLimit:8}}); assert.equal(room.room.settings.scoreLimit, 3); assert.equal(roster(room, user).admin, false);
        const mismatch = await member(env, 'Mismatch', {...ordinary, userSessionHash:activated.userSessionHash, adminAccountId:activated.adminAccountId}); assert.equal(roster(room, mismatch).admin, false);
    } finally {cleanup(env);}
});

test('football privileges revoke on user expiry, link/account removal, deactivation and actual user logout', async () => {
    for (const revoke of ['expiry', 'unlink', 'account', 'deactivate', 'logout']) {
        const env = environment();
        try {
            const auth = await administrator(env), admin = await member(env, 'Admin', {...auth, adminSessionHash:undefined}), room = roomOf(env); assert.equal(roster(room, admin).admin, true);
            if (revoke === 'expiry') env.db.prepare('UPDATE user_sessions SET expires_at=0 WHERE token_hash=?').run(auth.userSessionHash);
            else if (revoke === 'unlink') env.db.prepare('DELETE FROM admin_bonk_links WHERE account_id=?').run(auth.adminAccountId);
            else if (revoke === 'account') {env.db.prepare('DELETE FROM admin_sessions WHERE account_id=?').run(auth.adminAccountId); env.db.prepare('DELETE FROM admin_accounts WHERE id=?').run(auth.adminAccountId);}
            else if (revoke === 'deactivate') env.db.prepare('UPDATE admin_credentials SET code_hash=NULL WHERE account_id=?').run(auth.adminAccountId);
            else {
                const response = await worker.fetch(new Request('https://api.test/api/bonk/logout', {method:'POST', headers:{Origin:origin, 'Content-Type':'application/json', 'X-Account-Session':auth.userToken}, body:'{}'}), env); assert.equal(response.status, 200);
                assert.equal(env.db.prepare('SELECT COUNT(*) n FROM user_sessions WHERE token_hash=?').get(auth.userSessionHash).n, 0);
            }
            await command(room, admin, {type:'settings', settings:{scoreLimit:9}}); assert.equal(room.room.settings.scoreLimit, 3, revoke); assert.equal(roster(room, admin).admin, false, revoke);
        } finally {cleanup(env);}
    }
});

test('legacy football admin contexts remain compatible but an admin token never replaces the valid Bonk-session binding', async () => {
    const env = environment();
    try {
        const auth = await administrator(env), admin = await member(env, 'Admin', auth), room = roomOf(env), own = roster(room, admin);
        own.adminContext = {userSessionHash:auth.userSessionHash, adminSessionHash:'expired-old-token-hash', adminAccountId:auth.adminAccountId};
        await command(room, admin, {type:'settings', settings:{scoreLimit:4}}); assert.equal(room.room.settings.scoreLimit, 4);
        own.adminContext = {adminSessionHash:auth.adminSessionHash, adminAccountId:auth.adminAccountId}; await command(room, admin, {type:'settings', settings:{scoreLimit:5}}); assert.equal(room.room.settings.scoreLimit, 4); assert.equal(own.admin, false);
    } finally {cleanup(env);}
});
