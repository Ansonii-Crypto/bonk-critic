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
        const last = this.errors.get(key);
        this.errors.set(key, {x:previous.x - target.x, y:previous.y - target.y, at:now, targetX:target.x, targetY:target.y, deltaX:last?.deltaX || 0, deltaY:last?.deltaY || 0});
    }
    render(key, target, now) {
        if (!target) return target;
        const error = this.errors.get(key); if (!error) return target;
        const factor = Math.exp(-clamp(finite(now) - error.at, 0, 250) / this.decayMs);
        let changeX = error.x * (factor - 1), changeY = error.y * (factor - 1);
        const dx = target.x - error.targetX, dy = target.y - error.targetY, distance = Math.hypot(dx, dy);
        // Limit only the correction opposing ongoing motion. Unlike a position
        // clamp, this leaves continuous progress at every display refresh rate.
        // A collision reversal or stopped body uses ordinary error decay.
        if (distance > EPSILON && dx * error.deltaX + dy * error.deltaY >= 0) {
            const nx = dx / distance, ny = dy / distance, opposing = -(changeX * nx + changeY * ny), limit = distance * .5;
            if (opposing > limit) {changeX += nx * (opposing - limit); changeY += ny * (opposing - limit);}
        }
        error.x += changeX; error.y += changeY; error.at = finite(now);
        error.targetX = target.x; error.targetY = target.y; error.deltaX = dx; error.deltaY = dy;
        if (Math.abs(error.x) + Math.abs(error.y) < 1e-5) this.errors.delete(key);
        return {...target, x:target.x + error.x, y:target.y + error.y};
    }
}

export class FootballPredictor {
    constructor({physics = new FootballPhysics(), maxReplayMs = 250, maxSteps = 8, timeline = new InputTimeline(), offsets = new ReconciliationOffsets()} = {}) {
        this.physics = physics; this.maxReplayMs = clamp(finite(maxReplayMs, 250), DT, 333); this.maxSteps = clamp(Math.floor(finite(maxSteps, 8)), 1, 10); this.timeline = timeline; this.offsets = offsets; this.reset();
    }
    reset() {
        this.timeline.clear(); this.offsets.clear(); this.state = null; this.slot = null; this.nextStepAt = null; this.simulatedAt = null; this.phaseKey = null; this.authority = null; this.inputs = []; this.practice = false; this.pendingHeavy = false; this.preview = null; this.simulationSteps = 0; this.lastReplaySteps = 0; this.lastAdvanceSteps = 0;
    }
    recordInput(seq, flags, now) {
        if (!Number.isSafeInteger(seq) || seq < 0 || seq > 2147483647 || seq <= this.timeline.lastSeq || !Number.isInteger(flags) || !Number.isFinite(now)) return false;
        const changed = (flags & 31) !== this.timeline.currentFlags;
        this.advance(now);
        // A changed input can alter the cached future endpoint partway through
        // a tick. Keep that presentation continuous, especially for kick taps.
        const previousSelf = changed && this.state ? this.renderBody('self', this.state.discs[this.slot], now) : null;
        const previousBall = changed && this.state ? this.renderBody('ball', this.state.ball, now) : null;
        const accepted = this.timeline.recordInput(seq, flags, now);
        if (accepted && changed && this.state) {
            this.preview = null;
            this.offsets.capture('self', previousSelf, this.sampleBody('self', this.state.discs[this.slot], now), now);
            this.offsets.capture('ball', previousBall, this.sampleBody('ball', this.state.ball, now), now);
        }
        return accepted;
    }
    signature(state, slot, practice, phaseKey) {
        const settings = state.settings || {};
        return JSON.stringify([phaseKey ?? '', slot, state.discs[slot]?.team, practice, state.ppm, state.goalHeight, settings.pitchWidth, settings.pitchHeight, settings.ballRadius, settings.playerRadius, settings.moveForce, settings.kickImpulse]);
    }
    acceptSnapshot(snapshot, {now = performance.now(), rtt = 0, slot, practice = false, phaseKey = '', snapshotAgeMs} = {}) {
        const source = snapshot?.state;
        if (!source?.ball || !Array.isArray(source.discs) || !Number.isInteger(slot) || !source.discs[slot]) {this.state = null; this.slot = null; this.nextStepAt = null; this.preview = null; this.offsets.clear(); return null;}
        now = finite(now); this.advance(now);
        const oldSelf = this.state?.discs[this.slot], oldBall = this.state?.ball;
        const previousSelf = oldSelf ? this.renderBody('self', oldSelf, now) : null, previousBall = oldBall ? this.renderBody('ball', oldBall, now) : null;
        const signature = this.signature(source, slot, practice, phaseKey);
        const reset = signature !== this.phaseKey || source.ni || (this.authority && source.ftu > this.authority.ftu + 5);
        const oldNextStep = reset ? null : this.nextStepAt;
        this.slot = slot; this.practice = Boolean(practice); this.phaseKey = signature; this.authority = source; this.state = copy(source); this.preview = null; this.inputs = Array.isArray(snapshot.inputs) ? snapshot.inputs.map(flags => flags & 31) : [];
        this.timeline.acknowledge(snapshot.ackSeq, now);
        const oneWay = clamp(finite(rtt) / 2, 0, this.maxReplayMs), age = clamp(finite(snapshotAgeMs, oneWay), 0, this.maxReplayMs);
        // Advance the actual age of this snapshot. Adding a second half-RTT
        // also advances the ball and contacts too far into the future.
        const baseAt = now - age;
        const targetAt = oldNextStep === null ? now : Math.min(now, oldNextStep - DT);
        this.simulatedAt = baseAt; this.pendingHeavy = !reset && this.timeline.pendingPressBefore(baseAt); this.lastReplaySteps = 0;
        const replaySteps = Math.min(this.maxSteps, Math.max(0, Math.floor((targetAt - baseAt + EPSILON) / DT)));
        for (let index = 0; index < replaySteps; index++) {if (!this.step(baseAt + (index + 1) * DT)) break; this.lastReplaySteps++;}
        this.nextStepAt = oldNextStep ?? this.simulatedAt + DT;
        while (this.nextStepAt <= this.simulatedAt + EPSILON) this.nextStepAt += DT;
        if (reset) this.offsets.clear();
        else {this.offsets.capture('self', previousSelf, this.sampleBody('self', this.state.discs[slot], now), now); this.offsets.capture('ball', previousBall, this.sampleBody('ball', this.state.ball, now), now);}
        return this.state;
    }
    controlsAt(at) {
        const own = this.state.discs[this.slot];
        let flags = this.timeline.flagsAt(at, {baseline:this.inputs[this.slot] || 0});
        let pendingHeavy = this.pendingHeavy || this.timeline.pressedBetween(this.simulatedAt, at);
        if (!this.practice && this.state.ftu !== -1) pendingHeavy = false;
        else if (pendingHeavy) {if (own.kickReady === false) flags &= ~16; else {flags |= 16; pendingHeavy = false;}}
        const controls = this.inputs.map(input); controls[this.slot] = input(flags);
        return {controls, pendingHeavy};
    }
    step(at) {
        if (!this.state || !this.state.discs[this.slot] || (!this.practice && this.state.fte === 0)) return false;
        const next = this.controlsAt(at); this.pendingHeavy = next.pendingHeavy;
        this.state = this.physics.step(this.state, next.controls, this.practice ? {practice:true} : undefined); this.preview = null; this.simulatedAt = at; this.simulationSteps++; return true;
    }
    previewState() {
        if (!this.state || !this.state.discs[this.slot] || this.nextStepAt === null || (!this.practice && this.state.fte === 0)) return this.state;
        if (this.preview?.source === this.state && this.preview.seq === this.timeline.lastSeq && this.preview.at === this.nextStepAt) return this.preview.state;
        const next = this.physics.step(this.state, this.controlsAt(this.nextStepAt).controls, this.practice ? {practice:true} : undefined);
        this.preview = {source:this.state, seq:this.timeline.lastSeq, at:this.nextStepAt, state:next};
        return next;
    }
    sampleBody(key, target, now) {
        if (!target || this.nextStepAt === null) return target;
        const preview = this.previewState(), next = key === 'self' ? preview?.discs[this.slot] : preview?.ball;
        if (!next) return target;
        const alpha = clamp((finite(now) - (this.nextStepAt - DT)) / DT, 0, 1);
        return {...target, x:target.x + (next.x - target.x) * alpha, y:target.y + (next.y - target.y) * alpha};
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
        return this.offsets.render(key, this.sampleBody(key, target, now), now);
    }
}
