import assert from 'node:assert/strict';
import test from 'node:test';
import {FootballRoom, FOOTBALL_ROOM_LIMITS as LIMITS} from '../src/football-room.js';
import {footballApi} from '../src/football-api.js';

const origin = 'https://bonk-critic.com';
const NativeResponse = globalThis.Response;
// Node deliberately rejects status 101; Workers attaches the client socket to
// that response. Keep all ordinary responses and JSON handling native.
globalThis.Response = class extends NativeResponse {
    constructor(body, init = {}) {
        if (init.status === 101) {super(null, {status:200}); Object.defineProperty(this, 'status', {value:101}); this.webSocket = init.webSocket;}
        else super(body, init);
    }
};
class Socket {
    listeners = new Map(); received = []; closed = false;
    accept() {this.accepted = true;}
    addEventListener(type, callback) {const list = this.listeners.get(type) || []; list.push(callback); this.listeners.set(type, list);}
    emit(type, event) {for (const callback of this.listeners.get(type) || []) callback(event);}
    send(data) {if (this.closed) throw new Error('closed'); this.peer.received.push(JSON.parse(data)); this.peer.emit('message', {data});}
    close(code, reason) {if (this.closed) return; this.closed = true; this.peer.closed = true; this.emit('close', {code, reason}); this.peer.emit('close', {code, reason});}
}
globalThis.WebSocketPair = class {
    constructor() {this[0] = new Socket(); this[1] = new Socket(); this[0].peer = this[1]; this[1].peer = this[0];}
};
class Storage {
    values = new Map();
    async get(key) {return structuredClone(this.values.get(key));}
    async put(key, value) {this.values.set(key, structuredClone(value));}
    async delete(key) {this.values.delete(key);}
    async setAlarm(at) {this.alarm = at;}
    async deleteAlarm() {this.alarm = null;}
}
function context(storage = new Storage()) {
    return {storage, pending:[], blockConcurrencyWhile(callback) {return callback();}, waitUntil(promise) {this.pending.push(promise);}};
}
function environment() {
    const objects = new Map();
    const env = {ALLOWED_ORIGIN:origin, objects};
    env.FOOTBALL_ROOMS = {idFromName:id => id, get(id) {if (!objects.has(id)) objects.set(id, new FootballRoom(context(), env)); return objects.get(id);}};
    return env;
}
function request(env, path, body, identity = null, extraHeaders = {}) {
    return footballApi(new Request('https://api.test/api/football/rooms' + path, {method:body === undefined ? 'GET' : 'POST', headers:{Origin:origin, 'Content-Type':'application/json', ...extraHeaders}, ...(body === undefined ? {} : {body:JSON.stringify(body)})}), env, identity);
}
async function create(env, name = 'Host', identity = null) {
    const response = await request(env, '', {name:'Friday football', displayName:name, identity:{username:'forged', bonkId:'1'}}, identity);
    assert.equal(response.status, 201); return response.json();
}
async function join(env, id, name = 'Player', extra = {}, identity = null) {
    const response = await request(env, `/${id}/join`, {displayName:name, ...extra}, identity);
    return {response, data:await response.json()};
}
async function connect(env, data, headers = {}) {
    const response = await request(env, data.socketPath.replace('/api/football/rooms', ''), undefined, null, {Upgrade:'websocket', ...headers});
    assert.equal(response.status, 101); return response.webSocket;
}
async function command(room, memberId, message) {await room.message(room.connections.get(memberId), JSON.stringify(message));}
function cleanup(env) {for (const room of env.objects.values()) room.stopTimer();}
async function teams(env) {
    const host = await create(env); const room = env.objects.get(host.room.id); const hostSocket = await connect(env, host);
    const player = (await join(env, host.room.id)).data; const playerSocket = await connect(env, player);
    await command(room, host.member.id, {type:'team', team:2}); await command(room, player.member.id, {type:'team', team:3});
    return {host, player, room, hostSocket, playerSocket};
}

test('HTTP creation strips forged identity and public/private state stays separated', async () => {
    const env = environment();
    try {
        const host = await create(env, 'Guest Host');
        assert.equal(host.room.members[0].name, 'Guest Host'); assert.equal(host.room.members[0].verified, false);
        assert.equal(host.room.members[0].slot, 0); assert.match(host.room.id, /^[A-Za-z0-9_-]{16}$/);
        assert.match(host.member.resumeToken, /^[a-f0-9]{64}$/);
        const publicText = JSON.stringify((await (await request(env, `/${host.room.id}`)).json()).room);
        assert.doesNotMatch(publicText, /resumeHash|resumeToken|bonkId|ticket/);
        const verified = (await join(env, host.room.id, 'Spoofed', {}, {username:'Real Bonk', bonkId:'12345'})).data;
        assert.equal(verified.room.members[1].name, 'Real Bonk'); assert.equal(verified.room.members[1].verified, true);
        assert.doesNotMatch(JSON.stringify(verified.room), /12345/);
    } finally {cleanup(env);}
});

test('origin and one-use short-lived tickets protect socket upgrades', async () => {
    const env = environment();
    try {
        assert.equal((await request(env, '', {name:'x', displayName:'x'}, null, {Origin:'https://evil.test'})).status, 403);
        const host = await create(env);
        assert.equal((await request(env, host.socketPath.replace('/api/football/rooms', ''), undefined, null, {Origin:'https://evil.test', Upgrade:'websocket'})).status, 403);
        await connect(env, host);
        assert.equal((await request(env, host.socketPath.replace('/api/football/rooms', ''), undefined, null, {Upgrade:'websocket'})).status, 403);
        const other = (await join(env, host.room.id)).data; const room = env.objects.get(host.room.id);
        room.tickets.get(other.ticket).expires = Date.now() - 1;
        assert.equal((await request(env, other.socketPath.replace('/api/football/rooms', ''), undefined, null, {Upgrade:'websocket'})).status, 403);
    } finally {cleanup(env);}
});

test('host controls and server-owned player bindings reject forged operations and scores', async () => {
    const env = environment();
    try {
        const {host, player, room, playerSocket} = await teams(env);
        await command(room, player.member.id, {type:'settings', scoreLimit:1}); assert.equal(room.room.settings.scoreLimit, 3);
        await command(room, player.member.id, {type:'start'}); assert.equal(room.room.status, 'lobby');
        await command(room, host.member.id, {type:'start'}); assert.equal(room.room.status, 'playing');
        const state = structuredClone(room.room.state);
        await command(room, player.member.id, {type:'state', memberId:host.member.id, scores:[0, 0, 99, 99], state:{}});
        assert.deepEqual(room.room.state, state);
        await command(room, player.member.id, {type:'input', memberId:host.member.id, seq:1, flags:63});
        assert.equal(room.inputs[1], 63); assert.equal(room.inputs[0] || 0, 0);
        await command(room, player.member.id, {type:'input', seq:1, flags:0}); assert.equal(room.inputs[1], 63);
        await command(room, player.member.id, {type:'input', seq:2, flags:64}); assert.equal(room.inputs[1], 63);
        assert.ok(playerSocket.received.some(message => message.type === 'error'));
    } finally {cleanup(env);}
});

test('team and room capacity allow four per side and sixteen total', async () => {
    const env = environment();
    try {
        const host = await create(env); const room = env.objects.get(host.room.id); await connect(env, host);
        await command(room, host.member.id, {type:'team', team:2});
        for (let i = 1; i < 16; i++) {
            const member = (await join(env, host.room.id, 'Player ' + i)).data; await connect(env, member);
            await command(room, host.member.id, {type:'assign', memberId:member.member.id, team:i < 5 ? 2 : i < 9 ? 3 : 0});
        }
        assert.equal(room.room.members.length, 16); assert.equal(room.room.members.filter(member => member.team === 2).length, 4);
        assert.equal(room.room.members.filter(member => member.team === 3).length, 4);
        assert.equal((await join(env, host.room.id, 'Overflow')).response.status, 409);
        await command(room, host.member.id, {type:'settings', scoreLimit:10}); assert.equal(room.room.settings.scoreLimit, 3);
    } finally {cleanup(env);}
});

test('real authoritative physics accepts controls and snapshots at fifteen hertz', async () => {
    const env = environment();
    try {
        const {host, player, room, hostSocket} = await teams(env);
        await command(room, host.member.id, {type:'start'}); room.stopTimer(); room.room.state.ftu = -1;
        const before = room.room.state.discs[1].x;
        await command(room, player.member.id, {type:'input', seq:7, flags:2}); room.tick(); room.tick();
        assert.ok(room.room.state.discs[1].x > before); assert.equal(room.room.state.scores[2], 0);
        const snapshots = hostSocket.received.filter(message => message.type === 'snapshot');
        assert.equal(snapshots.length, 1); assert.equal(snapshots[0].tick, 2); assert.equal(snapshots[0].inputs[1], 2);
        assert.equal(snapshots[0].state.players[1].id, 1);
        room.inputTimes[1] = Date.now() - 1001; room.tick(); assert.equal(room.inputs[1], 0);
    } finally {cleanup(env);}
});

test('spectators leave sparse player slots intact throughout real simulation', async () => {
    const env = environment();
    try {
        const host = await create(env); const room = env.objects.get(host.room.id); await connect(env, host);
        const spectator = (await join(env, host.room.id, 'Spectator')).data; await connect(env, spectator);
        const player = (await join(env, host.room.id, 'Blue')).data; await connect(env, player);
        await command(room, host.member.id, {type:'team', team:2}); await command(room, player.member.id, {type:'team', team:3});
        await command(room, host.member.id, {type:'start'}); room.stopTimer(); room.room.state.ftu = -1;
        assert.equal(room.room.state.discs[1], undefined); assert.equal(room.room.state.players[2].id, 2);
        await command(room, player.member.id, {type:'input', seq:1, flags:2});
        const start = room.room.state.discs[2].x; room.tick();
        assert.ok(room.room.state.discs[2].x > start); assert.equal(room.room.state.discs[1], undefined);
    } finally {cleanup(env);}
});

test('winning goal completes before kickoff reset and host can rematch', async () => {
    const env = environment();
    try {
        const {host, room} = await teams(env);
        await command(room, host.member.id, {type:'settings', scoreLimit:1}); await command(room, host.member.id, {type:'start'}); room.stopTimer();
        room.room.state.scores[3] = 1; room.room.state.fte = 0; room.room.state.ftu = -1;
        room.tick(); assert.equal(room.room.status, 'finished'); assert.equal(room.room.winner, 3); assert.equal(room.room.state.fte, 0);
        await command(room, host.member.id, {type:'rematch'}); room.stopTimer();
        assert.equal(room.room.status, 'playing'); assert.deepEqual(room.room.state.scores, [0, 0, 0, 0]); assert.equal(room.room.state.ftu, 120);
        await command(room, host.member.id, {type:'abort'}); assert.equal(room.room.status, 'lobby'); assert.equal(room.room.state, null);
    } finally {cleanup(env);}
});

test('an authoritative goal celebrates for ninety ticks then finishes the match', async () => {
    const env = environment();
    try {
        const {host, room} = await teams(env);
        await command(room, host.member.id, {type:'settings', scoreLimit:1}); await command(room, host.member.id, {type:'start'}); room.stopTimer();
        room.room.state.ftu = -1; room.room.state.ball.x = 29 / 11; room.room.state.ball.xv = -1;
        room.tick(); assert.equal(room.room.state.scores[2], 1); assert.equal(room.room.state.fte, 90); assert.equal(room.room.status, 'playing');
        for (let frame = 0; frame < 90; frame++) room.tick();
        assert.equal(room.room.state.fte, 0); assert.equal(room.room.status, 'playing');
        room.tick(); assert.equal(room.room.status, 'finished'); assert.equal(room.room.winner, 2);
    } finally {cleanup(env);}
});

test('disconnect releases controls; account-bound resume rotates credentials and preserves seat', async () => {
    const env = environment();
    try {
        const host = await create(env, 'Host', {username:'Verified', bonkId:'123'}); const room = env.objects.get(host.room.id); const socket = await connect(env, host);
        room.inputs[0] = 31; socket.close(1001, 'gone'); assert.equal(room.inputs[0], 0); assert.equal(room.room.members[0].connected, false);
        assert.equal((await join(env, host.room.id, 'x', {resumeToken:host.member.resumeToken})).response.status, 403);
        const resumed = await join(env, host.room.id, 'x', {resumeToken:host.member.resumeToken}, {username:'Verified', bonkId:'123'});
        assert.equal(resumed.response.status, 200); assert.equal(resumed.data.member.id, host.member.id); assert.notEqual(resumed.data.member.resumeToken, host.member.resumeToken);
        await connect(env, resumed.data); assert.equal(room.room.members[0].connected, true); assert.equal(room.room.members.length, 1);
        assert.equal((await join(env, host.room.id, 'x', {resumeToken:host.member.resumeToken}, {username:'Verified', bonkId:'123'})).response.status, 403);
    } finally {cleanup(env);}
});

test('grace expiry removes absent players, transfers host and aborts an empty team', async () => {
    const env = environment();
    try {
        const {host, player, room, hostSocket} = await teams(env);
        await command(room, host.member.id, {type:'start'}); room.stopTimer();
        hostSocket.close(1001, 'gone'); const member = room.room.members.find(item => item.id === host.member.id);
        member.disconnectedAt = Date.now() - LIMITS.RESUME_GRACE - 1; await room.alarm();
        assert.equal(room.room.members.length, 1); assert.equal(room.room.hostId, player.member.id); assert.equal(room.room.status, 'lobby');
        assert.equal((await join(env, host.room.id, 'x', {resumeToken:host.member.resumeToken})).response.status, 403);
    } finally {cleanup(env);}
});

test('cold checkpoints restore bounded member grace with controls released and idle rooms expire', async () => {
    const env = environment();
    try {
        const {host, room} = await teams(env);
        await command(room, host.member.id, {type:'start'}); room.stopTimer(); room.inputs[0] = 2; room.tick(); await room.persist();
        const restored = new FootballRoom(context(room.ctx.storage), env); await restored.ready; restored.stopTimer();
        assert.equal(restored.room.status, 'playing'); assert.deepEqual(restored.room.state, room.room.state); assert.equal(restored.inputs[0] || 0, 0);
        assert.ok(restored.room.members.every(member => !member.connected));
        restored.room.lastActive = Date.now() - LIMITS.IDLE_TTL - 1; await restored.alarm(); await restored.persistChain;
        assert.equal(restored.room, null); assert.equal(await restored.ctx.storage.get('checkpoint'), undefined);
    } finally {cleanup(env);}
});

test('lobby alarms drop half-dead sockets, then transfer host after resume grace and expire idle rooms', async () => {
    const env = environment();
    try {
        const {host, player, room, hostSocket} = await teams(env);
        const connection = room.connections.get(host.member.id);
        assert.ok(room.ctx.storage.alarm <= Date.now() + LIMITS.HEARTBEAT_TTL);
        connection.lastMessageAt = Date.now() - LIMITS.HEARTBEAT_TTL - 1;
        await room.alarm();
        assert.equal(hostSocket.closed, true); assert.equal(room.room.members.find(member => member.id === host.member.id).connected, false);
        assert.equal(room.room.hostId, host.member.id); // Reserved during reconnect grace.
        room.room.members.find(member => member.id === host.member.id).disconnectedAt = Date.now() - LIMITS.RESUME_GRACE - 1;
        await room.alarm(); assert.equal(room.room.hostId, player.member.id);
        room.connections.get(player.member.id).lastMessageAt = Date.now() - LIMITS.HEARTBEAT_TTL - 1; await room.alarm();
        room.room.members[0].disconnectedAt = Date.now() - LIMITS.RESUME_GRACE - 1; await room.alarm();
        assert.equal(room.room.members.length, 0);
        room.room.lastActive = Date.now() - LIMITS.IDLE_TTL - 1; await room.alarm(); await room.persistChain;
        assert.equal(room.room, null); assert.equal(await room.ctx.storage.get('checkpoint'), undefined);
    } finally {cleanup(env);}
});

test('active heartbeat extends socket liveness without writing an alarm on every input', async () => {
    const env = environment();
    try {
        const host = await create(env); const room = env.objects.get(host.room.id); const socket = await connect(env, host);
        const connection = room.connections.get(host.member.id), originalAlarm = room.ctx.storage.alarm;
        connection.lastMessageAt = Date.now() - LIMITS.HEARTBEAT_TTL - 1;
        await command(room, host.member.id, {type:'input', seq:1, flags:0});
        assert.equal(room.ctx.storage.alarm, originalAlarm); assert.ok(connection.lastMessageAt > Date.now() - 100);
        await room.alarm(); assert.equal(socket.closed, false); assert.equal(room.room.members[0].connected, true);
        assert.ok(room.ctx.storage.alarm >= connection.lastMessageAt + LIMITS.HEARTBEAT_TTL);
    } finally {cleanup(env);}
});

test('chat and websocket message rates are bounded and kick revokes reconnect', async () => {
    const env = environment();
    try {
        const {host, player, room, playerSocket} = await teams(env);
        for (let i = 0; i < 5; i++) await command(room, player.member.id, {type:'chat', text:'Hello ' + i});
        assert.equal(room.room.chat.length, 4); assert.ok(playerSocket.received.some(message => /slow down/.test(message.error || '')));
        await command(room, host.member.id, {type:'kick', memberId:player.member.id}); assert.equal(playerSocket.closed, true);
        assert.equal((await join(env, host.room.id, 'x', {resumeToken:player.member.resumeToken})).response.status, 403);
        const newMember = (await join(env, host.room.id, 'Again')).data; const socket = await connect(env, newMember);
        await command(room, newMember.member.id, {type:'ping', padding:'x'.repeat(1100)}); assert.equal(socket.closed, true);
        const flood = (await join(env, host.room.id, 'Flood')).data; const floodSocket = await connect(env, flood);
        for (let i = 0; i < 120 && room.connections.has(flood.member.id); i++) await command(room, flood.member.id, {type:'ping', sentAt:i});
        assert.equal(floodSocket.closed, true); assert.equal(room.connections.has(flood.member.id), false);
    } finally {cleanup(env);}
});
