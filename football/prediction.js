import {FootballPhysics, FOOTBALL_CONSTANTS} from './physics.js?v=20261127-football-9';

const DT = 1000 / FOOTBALL_CONSTANTS.TICK_RATE, EPSILON = 1e-7;
const finite = (value, fallback = 0) => Number.isFinite(value) ? value : fallback;
const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const copy = value => typeof structuredClone === 'function' ? structuredClone(value) : JSON.parse(JSON.stringify(value));
const input = flags => ({left:Boolean(flags & 1), right:Boolean(flags & 2), up:Boolean(flags & 4), down:Boolean(flags & 8), action:Boolean(flags & 16)});

// Wire sequence numbers acknowledge received packets, not simulated frames.
// Keep actual input timestamps; a heartbeat never adds a physics step.
export class InputTimeline {
    constructor({maxRecords = 256, maxAgeMs = 2000} = {}) {
        this.maxRecords = clamp(Math.floor(finite(maxRecords, 256)), 8, 512); this.maxAgeMs = clamp(finite(maxAgeMs, 2000), 333, 5000); this.clear();
    }
    clear() {this.records = []; this.ackSeq = -1; this.lastSeq = -1; this.currentFlags = 0;}
    recordInput(seq, flags, at) {
        if (!Number.isSafeInteger(seq) || seq < 0 || seq > 2147483647 || seq <= this.lastSeq || !Number.isInteger(flags) || !Number.isFinite(at)) return false;
        at = Math.max(at, this.records.at(-1)?.at ?? at); flags &= 31;
        this.records.push({seq, flags, at, pressed:Boolean(flags & 16) && !(this.currentFlags & 16)}); this.lastSeq = seq; this.currentFlags = flags; this.prune(at); return true;
    }
    prune(now) {
        const cutoff = finite(now) - this.maxAgeMs;
        while (this.records.length > 1 && this.records[1].at < cutoff) this.records.shift();
        if (this.records.length > this.maxRecords) this.records.splice(0, this.records.length - this.maxRecords);
    }
    acknowledge(seq, now) {if (Number.isSafeInteger(seq) && seq >= -1) this.ackSeq = Math.max(this.ackSeq, seq); if (Number.isFinite(now)) this.prune(now);}
    flagsAt(at, {baseline = 0, ackSeq = this.ackSeq} = {}) {
        let flags = baseline & 31;
        for (const record of this.records) {if (record.at > at + EPSILON) break; if (record.seq > ackSeq) flags = record.flags;}
        return flags;
    }
    pressedBetween(from, to, ackSeq = this.ackSeq) {return this.records.some(record => record.seq > ackSeq && record.pressed && record.at > from + EPSILON && record.at <= to + EPSILON);}
    pendingPressBefore(at, ackSeq = this.ackSeq) {return this.records.some(record => record.seq > ackSeq && record.pressed && record.at <= at + EPSILON);}
}

// Only reconciliation error decays. With zero error, render() returns the
// native target position directly; normal motion has no low-pass filter.
export class ReconciliationOffsets {
    constructor({decayMs = 85, snapDistance = 5} = {}) {this.decayMs = clamp(finite(decayMs, 85), 16, 250); this.snapDistance = clamp(finite(snapDistance, 5), .1, 20); this.clear();}
    clear() {this.errors = new Map();}
    capture(key, previous, target, now, {snap = false} = {}) {
        if (!previous || !target || snap || Math.hypot(previous.x - target.x, previous.y - target.y) > this.snapDistance) {this.errors.delete(key); return;}
        this.errors.set(key, {x:previous.x - target.x, y:previous.y - target.y, at:now, lastX:previous.x, lastY:previous.y});
    }
    render(key, target, now, {directionX = 0, directionY = 0} = {}) {
        if (!target) return target;
        const error = this.errors.get(key); if (!error) return target;
        const factor = Math.exp(-clamp(finite(now) - error.at, 0, 250) / this.decayMs);
        let x = target.x + error.x * factor, y = target.y + error.y * factor;
        // Native physics is 30 Hz, rendering may be 60/144 Hz. On an intervening
        // frame a shrinking positive error must not draw a held player backward.
        if (directionX > 0) x = Math.max(error.lastX, x); else if (directionX < 0) x = Math.min(error.lastX, x);
        if (directionY > 0) y = Math.max(error.lastY, y); else if (directionY < 0) y = Math.min(error.lastY, y);
        error.x = x - target.x; error.y = y - target.y; error.at = finite(now); error.lastX = x; error.lastY = y;
        if (Math.abs(error.x) + Math.abs(error.y) < 1e-5) this.errors.delete(key);
        return {...target, x, y};
    }
}

export class FootballPredictor {
    constructor({physics = new FootballPhysics(), maxReplayMs = 250, maxSteps = 8, timeline = new InputTimeline(), offsets = new ReconciliationOffsets()} = {}) {
        this.physics = physics; this.maxReplayMs = clamp(finite(maxReplayMs, 250), DT, 333); this.maxSteps = clamp(Math.floor(finite(maxSteps, 8)), 1, 10); this.timeline = timeline; this.offsets = offsets; this.reset();
    }
    reset() {
        this.timeline.clear(); this.offsets.clear(); this.state = null; this.slot = null; this.nextStepAt = null; this.simulatedAt = null; this.phaseKey = null; this.authority = null; this.inputs = []; this.practice = false; this.pendingHeavy = false; this.simulationSteps = 0; this.lastReplaySteps = 0; this.lastAdvanceSteps = 0;
    }
    recordInput(seq, flags, now) {const accepted = this.timeline.recordInput(seq, flags, now); if (accepted) this.advance(now); return accepted;}
    signature(state, slot, practice, phaseKey) {
        const settings = state.settings || {};
        return JSON.stringify([phaseKey ?? '', slot, state.discs[slot]?.team, practice, state.ppm, state.goalHeight, settings.pitchWidth, settings.pitchHeight, settings.ballRadius, settings.playerRadius, settings.moveForce, settings.kickImpulse]);
    }
    acceptSnapshot(snapshot, {now = performance.now(), rtt = 0, slot, practice = false, phaseKey = '', snapshotAgeMs} = {}) {
        const source = snapshot?.state;
        if (!source?.ball || !Array.isArray(source.discs) || !Number.isInteger(slot) || !source.discs[slot]) {this.state = null; this.slot = null; this.nextStepAt = null; this.offsets.clear(); return null;}
        now = finite(now); this.advance(now);
        const oldSelf = this.state?.discs[this.slot], oldBall = this.state?.ball;
        const previousSelf = oldSelf ? this.renderBody('self', oldSelf, now) : null, previousBall = oldBall ? this.renderBody('ball', oldBall, now) : null;
        const signature = this.signature(source, slot, practice, phaseKey);
        const reset = signature !== this.phaseKey || source.ni || (this.authority && source.ftu > this.authority.ftu + 5);
        const oldNextStep = reset ? null : this.nextStepAt;
        this.slot = slot; this.practice = Boolean(practice); this.phaseKey = signature; this.authority = source; this.state = copy(source); this.inputs = Array.isArray(snapshot.inputs) ? snapshot.inputs.map(flags => flags & 31) : [];
        this.timeline.acknowledge(snapshot.ackSeq, now);
        const oneWay = clamp(finite(rtt) / 2, 0, this.maxReplayMs), age = clamp(finite(snapshotAgeMs, oneWay), 0, this.maxReplayMs);
        // The authoritative own body also reflects uplink-delayed input. Replay
        // that unacknowledged input span plus the snapshot's downlink age.
        const lead = Math.min(this.maxReplayMs, age + oneWay), baseAt = now - lead;
        const targetAt = oldNextStep === null ? now : Math.min(now, oldNextStep - DT);
        this.simulatedAt = baseAt; this.pendingHeavy = !reset && this.timeline.pendingPressBefore(baseAt); this.lastReplaySteps = 0;
        const replaySteps = Math.min(this.maxSteps, Math.max(0, Math.floor((targetAt - baseAt + EPSILON) / DT)));
        for (let index = 0; index < replaySteps; index++) {if (!this.step(baseAt + (index + 1) * DT)) break; this.lastReplaySteps++;}
        this.nextStepAt = oldNextStep ?? this.simulatedAt + DT;
        while (this.nextStepAt <= this.simulatedAt + EPSILON) this.nextStepAt += DT;
        if (reset) this.offsets.clear();
        else {this.offsets.capture('self', previousSelf, this.state.discs[slot], now); this.offsets.capture('ball', previousBall, this.state.ball, now);}
        return this.state;
    }
    step(at) {
        if (!this.state || (!this.practice && this.state.fte === 0)) return false;
        const own = this.state.discs[this.slot]; if (!own) return false;
        let flags = this.timeline.flagsAt(at, {baseline:this.inputs[this.slot] || 0});
        if (this.timeline.pressedBetween(this.simulatedAt, at)) this.pendingHeavy = true;
        if (!this.practice && this.state.ftu !== -1) this.pendingHeavy = false;
        else if (this.pendingHeavy) {if (own.kickReady === false) flags &= ~16; else {flags |= 16; this.pendingHeavy = false;}}
        const controls = this.inputs.map(input); controls[this.slot] = input(flags);
        this.state = this.physics.step(this.state, controls, this.practice ? {practice:true} : undefined); this.simulatedAt = at; this.simulationSteps++; return true;
    }
    advance(now = performance.now()) {
        if (!this.state || this.nextStepAt === null || !Number.isFinite(now)) return this.state;
        if (now - this.nextStepAt > this.maxReplayMs) this.nextStepAt = now - this.maxReplayMs + DT;
        this.lastAdvanceSteps = 0;
        while (this.nextStepAt <= now + EPSILON && this.lastAdvanceSteps < this.maxSteps) {
            const at = this.nextStepAt; this.nextStepAt += DT;
            if (!this.step(at)) break;
            this.lastAdvanceSteps++;
        }
        return this.state;
    }
    renderBody(key, target, now = performance.now()) {
        if (!target) return target;
        const flags = this.timeline.currentFlags, intentX = flags & 1 ? -1 : flags & 2 ? 1 : 0, intentY = flags & 4 ? -1 : flags & 8 ? 1 : 0;
        const directionX = key === 'self' ? Math.sign(target.xv) === intentX ? intentX : 0 : Math.sign(target.xv), directionY = key === 'self' ? Math.sign(target.yv) === intentY ? intentY : 0 : Math.sign(target.yv);
        return this.offsets.render(key, target, now, {directionX, directionY});
    }
}
