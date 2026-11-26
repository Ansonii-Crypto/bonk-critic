import assert from 'node:assert/strict';
import test from 'node:test';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import {FootballRoom, FOOTBALL_ROOM_LIMITS as LIMITS} from '../src/football-room.js';
import {footballApi, FOOTBALL_HUB_ID as ID} from '../src/football-api.js';
import worker from '../src/index.js';

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
    const env = {ALLOWED_ORIGIN:origin, objects:new Map(), db, API_RATE_LIMITER:{async limit() {return {success:true};}}, LOGIN_RATE_LIMITER:{async limit() {return {success:true};}}};
    env.DB = {prepare(sql) {return {bind(...args) {const statement = db.prepare(sql); return {async first() {return statement.get(...args) || null;}, async run() {return {meta:{changes:Number(statement.run(...args).changes)}};}};}};}};
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
async function join(env, name = 'Player', {identity = null, extra = {}, path = '/lobby'} = {}) {
    const response = await request(env, path, {displayName:name, ...extra}, identity); return {response, data:await response.json()};
}
async function connect(env, data, headers = {}) {
    const response = await request(env, data.socketPath.replace('/api/football', ''), undefined, null, {Upgrade:'websocket', ...headers}); assert.equal(response.status, 101); return response.webSocket;
}
async function member(env, name, identity = null) {const {response, data} = await join(env, name, {identity}); assert.equal(response.status, 200); const socket = await connect(env, data); return {...data, socket};}
const roomOf = env => env.objects.get(ID);
const roster = (room, data) => room.room.members.find(item => item.id === data.member.id);
async function command(room, data, message) {await room.message(room.connections.get(data.member.id), JSON.stringify(message));}
function cleanup(env) {for (const room of env.objects.values()) room.stopTimer(); env.db.close();}
async function match(env, count = 2) {
    const members = []; for (let i = 0; i < count; i++) members.push(await member(env, 'Player ' + i));
    const room = roomOf(env); for (const data of members) await command(room, data, {type:'ready', ready:true}); room.stopTimer(); assert.equal(room.room.status, 'playing'); return {room, members};
}

test('all legacy room links and lobby requests resolve to one guest-safe shared hub', async () => {
    const env = environment();
    try {
        const empty = await (await request(env)).json(); assert.equal(empty.room.id, ID); assert.deepEqual(empty.room.members, []);
        const first = (await join(env, 'Guest', {path:'/rooms', extra:{name:'Private room', admin:true, identity:{username:'Forged', bonkId:'123'}}})).data;
        const second = (await join(env, 'Other', {path:'/rooms/old-private-code/join'})).data;
        assert.equal(first.room.id, second.room.id); assert.equal(env.objects.size, 1); assert.equal(first.room.members[0].admin, false); assert.equal(first.room.members[0].verified, false);
        assert.equal(first.room.hostId, null); assert.equal(first.room.members[0].host, false);
        assert.doesNotMatch(JSON.stringify(second.room), /resumeHash|resumeToken|bonkId|SessionHash|adminContext/);
    } finally {cleanup(env);}
});

test('first guests have no admin power; balanced players ready up to auto-start', async () => {
    const env = environment();
    try {
        const first = await member(env, 'First'), second = await member(env, 'Second'), room = roomOf(env);
        assert.equal(roster(room, first).team, 2); assert.equal(roster(room, second).team, 3);
        for (const type of ['settings', 'start', 'abort', 'kick', 'assign']) await command(room, first, {type, settings:{scoreLimit:1}, memberId:second.member.id, team:2});
        assert.equal(room.room.settings.scoreLimit, 3); assert.equal(room.room.members.length, 2); assert.equal(room.room.status, 'lobby');
        await command(room, first, {type:'ready', ready:true}); assert.equal(room.room.status, 'lobby');
        await command(room, first, {type:'chat', text:'Ready!'}); assert.equal(roster(room, first).ready, true);
        await command(room, second, {type:'ready', ready:true}); room.stopTimer(); assert.equal(room.room.status, 'playing'); assert.equal(room.room.state.ftu, 120);
    } finally {cleanup(env);}
});

test('real paired site sessions authorize admins, with expiry/revocation checked for each operation', async () => {
    const env = environment();
    try {
        const auth = await administrator(env), admin = await member(env, 'Ignored', auth), player = await member(env, 'Guest'), room = roomOf(env);
        assert.equal(roster(room, admin).admin, true);
        await command(room, admin, {type:'settings', settings:{scoreLimit:1, moveForce:0, goalHeight:-1}}); assert.equal(room.room.settings.moveForce, 0); assert.equal(room.room.settings.goalHeight, -1);
        await command(room, admin, {type:'assign', memberId:player.member.id, team:0}); assert.equal(roster(room, player).team, 0);
        env.db.prepare('DELETE FROM admin_sessions WHERE token_hash=?').run(auth.adminSessionHash);
        await command(room, admin, {type:'settings', settings:{scoreLimit:9}}); assert.equal(room.room.settings.scoreLimit, 1); assert.equal(roster(room, admin).admin, false);
        await command(room, admin, {type:'kick', memberId:player.member.id}); assert.equal(room.room.members.length, 2);
    } finally {cleanup(env);}
});

test('worker auth wiring ignores claimed admin, rejects mismatched paired sessions, and accepts genuine elevation', async () => {
    const env = environment();
    try {
        const auth = await administrator(env), other = await administrator(env, 'b');
        const send = headers => worker.fetch(new Request('https://api.test/api/football/lobby', {method:'POST', headers:{Origin:origin, 'Content-Type':'application/json', ...headers}, body:JSON.stringify({displayName:'Claimed admin', admin:true, adminSessionHash:auth.adminSessionHash})}), env);
        const forged = await (await send({})).json(); assert.equal(forged.room.members.find(item => item.id === forged.member.id).admin, false);
        const mismatch = await (await send({'X-Account-Session':other.userToken, Authorization:'Bearer ' + auth.adminToken})).json(); assert.equal(mismatch.room.members.find(item => item.id === mismatch.member.id).admin, false);
        const real = await (await send({'X-Account-Session':auth.userToken, Authorization:'Bearer ' + auth.adminToken})).json(); assert.equal(real.room.members.find(item => item.id === real.member.id).admin, true);
    } finally {cleanup(env);}
});

test('settings validate atomically, reset readiness, and are locked during play', async () => {
    const env = environment();
    try {
        const admin = await member(env, 'Admin', await administrator(env)), player = await member(env, 'Player'), room = roomOf(env);
        await command(room, player, {type:'ready', ready:true}); const before = structuredClone(room.room.settings);
        await command(room, admin, {type:'settings', settings:{scoreLimit:5, moveForce:999}}); assert.deepEqual(room.room.settings, before); assert.equal(roster(room, player).ready, true);
        await command(room, admin, {type:'settings', settings:{scoreLimit:5, kickImpulse:0, ballRadius:1.1, pitchWidth:900}}); assert.equal(roster(room, player).ready, false); assert.equal(room.room.settings.scoreLimit, 5);
        await command(room, admin, {type:'start'}); room.stopTimer(); assert.equal(room.room.state.settings.ballRadius, 1.1);
        await command(room, admin, {type:'settings', settings:{scoreLimit:2}}); assert.equal(room.room.settings.scoreLimit, 5);
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
        await command(room, people[0], {type:'spectate'}); assert.equal(roster(room, people[0]).queuePosition, undefined); assert.equal(roster(room, people[8]).team, 2);
        assert.equal(room.publicRoom().members.find(item => item.id === people[0].member.id).queuePosition, null);
    } finally {cleanup(env);}
});

test('team preferences honor FIFO and active opt-out creates a fair queue vacancy', async () => {
    const env = environment();
    try {
        const people = []; for (let i = 0; i < 10; i++) people.push(await member(env, 'P' + i)); const room = roomOf(env);
        await command(room, people[8], {type:'queue', team:3}); await command(room, people[9], {type:'queue', team:2});
        await command(room, people[0], {type:'spectate'}); assert.equal(roster(room, people[9]).team, 2); assert.equal(roster(room, people[8]).queued, true);
        await command(room, people[1], {type:'spectate'}); assert.equal(roster(room, people[8]).team, 3);
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

test('changing finished-match settings clears its old field preview and preserves the result', async () => {
    const env = environment();
    try {
        const admin = await member(env, 'Admin', await administrator(env)), player = await member(env, 'Player'), room = roomOf(env);
        await command(room, admin, {type:'start'}); room.stopTimer(); room.room.state.fte = 0; room.room.state.scores[2] = 3; room.tick();
        const result = structuredClone(room.room.lastResult);
        await command(room, admin, {type:'settings', settings:{pitchWidth:900}});
        assert.equal(room.room.status, 'lobby'); assert.equal(room.room.state, null); assert.equal(room.room.winner, null); assert.equal(room.room.settings.pitchWidth, 900); assert.deepEqual(room.room.lastResult, result);
    } finally {cleanup(env);}
});

test('live arrivals wait until the next kickoff and retain existing players, scores and settings', async () => {
    const env = environment();
    try {
        const {room, members} = await match(env), arrival = await member(env, 'Queued');
        assert.equal(roster(room, arrival).queued, true); assert.equal(roster(room, arrival).team, 0); assert.equal(room.room.state.discs[2], undefined);
        room.room.state.fte = 0; room.room.state.scores[2] = 1; room.tick();
        assert.equal(roster(room, arrival).queued, false); assert.equal(roster(room, arrival).team, 2); assert.equal(room.room.state.ftu, 120); assert.equal(room.room.state.scores[2], 1);
        assert.equal(room.room.state.players[0].id, roster(room, members[0]).slot); assert.equal(room.room.state.players[2].name, 'Queued');
    } finally {cleanup(env);}
});

test('winning score resolves before reset and finished players may ready for a rematch', async () => {
    const env = environment();
    try {
        const {room, members} = await match(env); room.room.settings.scoreLimit = 1;
        room.room.state.ftu = -1; room.room.state.ball.x = 29 / 11; room.room.state.ball.xv = -1; room.tick();
        assert.equal(room.room.state.scores[2], 1); assert.equal(room.room.state.fte, 90);
        for (let i = 0; i < 90; i++) room.tick(); assert.equal(room.room.status, 'playing'); room.tick();
        assert.equal(room.room.status, 'finished'); assert.equal(room.room.winner, 2); const result = structuredClone(room.room.lastResult);
        await command(room, members[0], {type:'ready', ready:true}); await command(room, members[1], {type:'ready', ready:true}); room.stopTimer();
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

test('origin, one-use ticket TTL, reconnect rotation and account binding remain enforced', async () => {
    const env = environment();
    try {
        assert.equal((await request(env, '/lobby', {displayName:'Evil'}, null, {Origin:'https://evil.test'})).status, 403);
        const identity = {username:'Verified', bonkId:'555'}, first = (await join(env, 'Ignored', {identity})).data;
        assert.equal((await request(env, first.socketPath.replace('/api/football', ''), undefined, null, {Upgrade:'websocket', Origin:'https://evil.test'})).status, 403);
        const socket = await connect(env, first); socket.close(1001, 'gone'); assert.equal(roomOf(env).inputs[0], 0);
        assert.equal((await join(env, 'Guest', {extra:{resumeToken:first.member.resumeToken}})).response.status, 403);
        const resumed = (await join(env, 'Ignored', {identity, extra:{resumeToken:first.member.resumeToken}})).data; assert.equal(resumed.member.id, first.member.id); assert.notEqual(resumed.member.resumeToken, first.member.resumeToken);
        await connect(env, resumed); assert.equal((await request(env, resumed.socketPath.replace('/api/football', ''), undefined, null, {Upgrade:'websocket'})).status, 403);
        assert.equal((await join(env, 'Ignored', {identity, extra:{resumeToken:first.member.resumeToken}})).response.status, 403);
        const expires = (await join(env, 'Expires')).data; roomOf(env).tickets.get(expires.ticket).expires = Date.now() - 1;
        assert.equal((await request(env, expires.socketPath.replace('/api/football', ''), undefined, null, {Upgrade:'websocket'})).status, 403);
    } finally {cleanup(env);}
});

test('a guest may upgrade its own seat only through a real trusted account/admin identity', async () => {
    const env = environment();
    try {
        const guest = await member(env, 'Guest'), auth = await administrator(env);
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

test('heartbeat alarms reap silent sockets and grace expiry aborts an empty team; active input avoids alarm writes', async () => {
    const env = environment();
    try {
        const {room, members} = await match(env), connection = room.connections.get(members[0].member.id), alarm = room.ctx.storage.alarm;
        connection.lastMessageAt = Date.now() - LIMITS.HEARTBEAT_TTL - 1; await command(room, members[0], {type:'input', seq:1, flags:0}); assert.equal(room.ctx.storage.alarm, alarm);
        await room.alarm(); assert.equal(members[0].socket.closed, false);
        connection.lastMessageAt = Date.now() - LIMITS.HEARTBEAT_TTL - 1; await room.alarm(); assert.equal(members[0].socket.closed, true);
        roster(room, members[0]).disconnectedAt = Date.now() - LIMITS.RESUME_GRACE - 1; await room.alarm(); assert.equal(room.room.status, 'lobby'); assert.equal(room.room.members.length, 1);
    } finally {cleanup(env);}
});

test('kick invalidates resume, chat limits preserve readiness, and oversized/flooded sockets close', async () => {
    const env = environment();
    try {
        const admin = await member(env, 'Admin', await administrator(env)), player = await member(env, 'Player'), room = roomOf(env);
        await command(room, player, {type:'ready', ready:true});
        for (let i = 0; i < 5; i++) await command(room, player, {type:'chat', text:'Hello ' + i}); assert.equal(room.room.chat.length, 4); assert.equal(roster(room, player).ready, true);
        await command(room, admin, {type:'kick', memberId:player.member.id}); assert.equal(player.socket.closed, true); assert.equal((await join(env, 'Player', {extra:{resumeToken:player.member.resumeToken}})).response.status, 403);
        const large = await member(env, 'Large'); await command(room, large, {type:'ping', padding:'x'.repeat(1100)}); assert.equal(large.socket.closed, true);
        const flood = await member(env, 'Flood'); for (let i = 0; i < 120 && room.connections.has(flood.member.id); i++) await command(room, flood, {type:'ping', sentAt:i}); assert.equal(flood.socket.closed, true);
    } finally {cleanup(env);}
});
