import test from 'node:test';
import assert from 'node:assert/strict';
import {FootballPhysics, createState} from '../../football/physics.js';
import {InputTimeline, ReconciliationOffsets, FootballPredictor} from '../../football/prediction.js';

const DT = 1000 / 30, FRAME = 1000 / 60;
const clone = value => structuredClone(value);
const controls = flags => ({left:Boolean(flags & 1), right:Boolean(flags & 2), up:Boolean(flags & 4), down:Boolean(flags & 8), action:Boolean(flags & 16)});
const initial = () => createState([{id:0, team:3, name:'Player'}], {kickoffTicks:-1});

test('input history samples timestamps, not received sequence numbers or heartbeat counts', () => {
    const timeline = new InputTimeline(); timeline.recordInput(1, 0, 0); timeline.recordInput(2, 2, 20); timeline.recordInput(3, 2, 30); timeline.recordInput(4, 0, 60); timeline.acknowledge(1);
    assert.equal(timeline.flagsAt(10), 0); assert.equal(timeline.flagsAt(25), 2); assert.equal(timeline.flagsAt(40), 2); assert.equal(timeline.flagsAt(70), 0);
    timeline.acknowledge(3); assert.equal(timeline.flagsAt(40, {baseline:2}), 2); assert.equal(timeline.flagsAt(70, {baseline:2}), 0);
    assert.equal(timeline.recordInput(2, 1, 100), false); assert.equal(timeline.recordInput(5, 32, 100), true); assert.equal(timeline.currentFlags, 0);
});

test('history is bounded and heartbeat density never changes native simulation speed', () => {
    const sparse = new FootballPredictor(), dense = new FootballPredictor(), state = initial();
    for (const predictor of [sparse, dense]) predictor.acceptSnapshot({state, inputs:[0], ackSeq:-1}, {now:0, rtt:0, slot:0, practice:true});
    sparse.recordInput(1, 2, 0); let seq = 1;
    for (let at = 0; at <= 1000; at += 10) {dense.recordInput(seq++, 2, at); sparse.advance(at);}
    assert.ok(Math.abs(sparse.state.discs[0].x - dense.state.discs[0].x) < 1e-10); assert.equal(sparse.simulationSteps, 30); assert.equal(dense.simulationSteps, 30);
    const bounded = new InputTimeline({maxRecords:16, maxAgeMs:500}); for (let i = 0; i < 1000; i++) bounded.recordInput(i, 2, i * 10);
    assert.ok(bounded.records.length <= 16); assert.ok(bounded.records[0].at >= 9800);
});

test('normal rendered motion is direct and only authority error is smoothed', () => {
    const offsets = new ReconciliationOffsets(); const target = {x:10, y:3, xv:4, yv:0}; assert.equal(offsets.render('self', target, 0), target);
    offsets.capture('self', {x:10, y:3}, {x:9, y:3}, 0);
    const first = offsets.render('self', {x:9.5, y:3, xv:4, yv:0}, 16, {directionX:1});
    const betweenTicks = offsets.render('self', {x:9.5, y:3, xv:4, yv:0}, 32, {directionX:1}); assert.ok(betweenTicks.x >= first.x);
    offsets.capture('self', betweenTicks, {x:100, y:3}, 40, {snap:true}); const teleported = {x:100, y:3, xv:0, yv:0}; assert.equal(offsets.render('self', teleported, 40), teleported);
});

test('snapshots preserve the forward prediction clock and replay bounded elapsed time', () => {
    const predictor = new FootballPredictor(), state = initial(); state.ni = false; predictor.recordInput(1, 2, 10);
    predictor.acceptSnapshot({state, inputs:[0], ackSeq:-1}, {now:100, rtt:150, slot:0, practice:true, phaseKey:'lobby'}); const next = predictor.nextStepAt;
    predictor.acceptSnapshot({state, inputs:[0], ackSeq:-1}, {now:105, rtt:150, slot:0, practice:true, phaseKey:'lobby'});
    assert.equal(predictor.nextStepAt, next); assert.ok(predictor.lastReplaySteps <= 8);
    predictor.acceptSnapshot({state, inputs:[0], ackSeq:-1}, {now:110, rtt:100000, slot:0, practice:true, phaseKey:'lobby'}); assert.ok(predictor.lastReplaySteps <= 8);
    const before = predictor.simulationSteps; predictor.advance(100000); assert.ok(predictor.simulationSteps - before <= 8);
});

test('phase changes snap and obsolete action2 flags cannot enter prediction', () => {
    const predictor = new FootballPredictor(), state = initial(); predictor.acceptSnapshot({state, inputs:[0], ackSeq:-1}, {now:0, slot:0, practice:true, phaseKey:'lobby'});
    predictor.recordInput(1, 34, 1); predictor.advance(100); assert.equal(predictor.timeline.currentFlags, 2); assert.ok(predictor.state.discs[0].x > state.discs[0].x);
    const reset = initial(); reset.ni = true; reset.discs[0].x = 40; predictor.acceptSnapshot({state:reset, inputs:[0], ackSeq:1}, {now:101, slot:0, practice:false, phaseKey:'new-match'});
    assert.equal(predictor.renderBody('self', predictor.state.discs[0], 101).x, 40); assert.equal(predictor.offsets.errors.size, 0);
    predictor.reset(); assert.equal(predictor.state, null); assert.equal(predictor.timeline.records.length, 0); assert.equal(predictor.recordInput(1, 2, 102), true);
});

// Reproduce the former client: every 15 Hz snapshot clones state, advances
// floor(RTT/2/DT) using current flags, resets its clock, and EMA-filters self.
class SnapshotResetBaseline {
    constructor(rtt) {this.rtt = rtt; this.physics = new FootballPhysics(); this.flags = 0; this.state = null; this.at = 0; this.steps = 0; this.position = null;}
    accept(snapshot, at) {
        this.state = clone(snapshot.state); this.at = at; this.steps = 0;
        for (let i = 0; i < Math.min(3, Math.floor(this.rtt / 2 / DT)); i++) {this.state = this.physics.step(this.state, [controls(this.flags)], {practice:true}); this.steps++;}
    }
    frame(at) {
        if (!this.state) return null;
        let count = 0; while (at - this.at >= DT && this.steps < 7 && count++ < 3) {this.state = this.physics.step(this.state, [controls(this.flags)], {practice:true}); this.at += DT; this.steps++;}
        const target = this.state.discs[0];
        if (!this.position || Math.hypot(this.position.x - target.x, this.position.y - target.y) > 5) this.position = {...target};
        else {const blend = 1 - Math.exp(-FRAME / 1000 * 28); this.position = {...target, x:this.position.x + (target.x - this.position.x) * blend, y:this.position.y + (target.y - this.position.y) * blend};}
        return this.position.x;
    }
}

function latencyScenario(rtt) {
    const delay = rtt / 2, server = new FootballPhysics(), predictor = new FootballPredictor(), baseline = new SnapshotResetBaseline(rtt), startState = initial(); startState.ni = false;
    let state = clone(startState), held = 0, serverFlags = 0, seq = -1, ack = -1; const events = [], frames = [], pressAt = 273, releaseAt = pressAt + 1000, duration = 1700;
    const priority = {press:0, release:0, heartbeat:1, received:2, server:3, snapshot:4, frame:5};
    const add = (at, kind, data = {}) => events.push({at, kind, ...data});
    const send = at => {seq++; predictor.recordInput(seq, held, at); add(at + delay, 'received', {seq, flags:held});};
    add(pressAt, 'press'); add(releaseAt, 'release');
    for (let at = 0; at <= duration; at += 100) add(at, 'heartbeat');
    for (let tick = 1; tick * DT <= duration; tick++) add(tick * DT, 'server', {tick});
    for (let frame = 0; frame * FRAME <= duration; frame++) add(frame * FRAME, 'frame');
    add(delay, 'snapshot', {snapshot:{state:clone(startState), inputs:[0], ackSeq:-1, tick:0}});
    while (events.length) {
        events.sort((a, b) => a.at - b.at || priority[a.kind] - priority[b.kind]); const event = events.shift(); if (event.at > duration) continue;
        if (event.kind === 'press' || event.kind === 'release') {held = event.kind === 'press' ? 2 : 0; baseline.flags = held; send(event.at);}
        else if (event.kind === 'heartbeat') send(event.at);
        else if (event.kind === 'received') {serverFlags = event.flags; ack = event.seq;}
        else if (event.kind === 'server') {state = server.step(state, [controls(serverFlags)], {practice:true}); if (event.tick % 2 === 0) add(event.at + delay, 'snapshot', {snapshot:{state:clone(state), inputs:[serverFlags], ackSeq:ack, tick:event.tick}});}
        else if (event.kind === 'snapshot') {baseline.accept(event.snapshot, event.at); predictor.acceptSnapshot(event.snapshot, {now:event.at, rtt, slot:0, practice:true, phaseKey:'lobby'});}
        else {
            const oldX = baseline.frame(event.at), predicted = predictor.advance(event.at), newX = predicted ? predictor.renderBody('self', predicted.discs[0], event.at).x : null;
            frames.push({at:event.at, oldX, newX});
        }
    }
    const origin = startState.discs[0].x, atOneSecond = frames.find(frame => frame.at >= releaseAt), motion = key => frames.find(frame => frame.at >= pressAt && frame[key] !== null && (frame[key] - origin) * 11 > .05).at - pressAt;
    const backwards = key => frames.filter((frame, index) => index && frame.at > pressAt + 100 && frame.at < releaseAt && (frame[key] - frames[index - 1][key]) * 11 < -.1).length;
    return {rtt, oldFirstMotionMs:motion('oldX'), newFirstMotionMs:motion('newX'), oldDistancePx:(atOneSecond.oldX - origin) * 11, newDistancePx:(atOneSecond.newX - origin) * 11, oldBackwards:backwards('oldX'), newBackwards:backwards('newX')};
}

test('100/150 ms RTT replay improves sustained movement without held backward corrections', t => {
    const idealPhysics = new FootballPhysics(); let ideal = initial(); const origin = ideal.discs[0].x;
    for (let tick = 0; tick < 30; tick++) ideal = idealPhysics.step(ideal, [controls(2)], {practice:true}); const idealDistancePx = (ideal.discs[0].x - origin) * 11;
    for (const rtt of [100, 150]) {
        const result = latencyScenario(rtt); t.diagnostic(JSON.stringify({...result, idealDistancePx}));
        assert.equal(result.newBackwards, 0); assert.ok(Math.abs(result.newDistancePx - idealDistancePx) < Math.abs(result.oldDistancePx - idealDistancePx)); assert.ok(result.newDistancePx > result.oldDistancePx + 4); assert.ok(result.newFirstMotionMs <= 50);
    }
});
