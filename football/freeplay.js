import {FootballPhysics, FOOTBALL_CONSTANTS, createState, getPitchGeometry} from './physics.js?v=20261127-football-6';
import {DEFAULT_MATCH_SETTINGS, validateMatchSettings} from './settings.js';

const STEP_MS = 1000 / FOOTBALL_CONSTANTS.TICK_RATE;
const DEMO_PLAYERS = [
    {id: 0, team: 3, name: 'Blue'},
    {id: 1, team: 2, name: 'Red'},
];
const clamp = (value, minimum, maximum) => Math.max(minimum, Math.min(maximum, value));

// A local empty-pitch scene. It never reads controls, opens a connection, or
// sends its state anywhere. All movement, kicks and contacts use native physics.
export class FreeplayScene {
    constructor(settings = DEFAULT_MATCH_SETTINGS) {
        this.physics = new FootballPhysics();
        this.settings = null;
        this.state = null;
        this.lastAt = null;
        this.accumulator = 0;
        this.ticks = 0;
        this.setSettings(settings);
    }

    setSettings(settings = DEFAULT_MATCH_SETTINGS) {
        const checked = validateMatchSettings({}, settings || DEFAULT_MATCH_SETTINGS);
        if (checked.error) throw new RangeError(checked.error);
        if (this.settings && Object.keys(checked.settings).every(key => checked.settings[key] === this.settings[key])) return false;
        this.settings = checked.settings;
        this.lastAt = null;
        this.accumulator = 0;
        this.ticks = 0;
        this.resetRound();
        return true;
    }

    resetRound(scores = [0, 0, 0, 0]) {
        this.state = createState(DEMO_PLAYERS, {settings: this.settings, kickoffTicks: -1, seed: 2711});
        this.state.scores = scores.slice();
        const geometry = getPitchGeometry(this.state).world;
        const gap = this.settings.playerRadius + this.settings.ballRadius + 3;
        const radius = this.settings.playerRadius;
        Object.assign(this.state.discs[0], {
            x: clamp(geometry.centerX - gap, radius, geometry.width - radius),
            y: clamp(geometry.centerY + 2, radius, geometry.height - radius),
        });
        Object.assign(this.state.discs[1], {
            x: clamp(geometry.centerX + gap * 1.3, radius, geometry.width - radius),
            y: clamp(geometry.centerY - 3, radius, geometry.height - radius),
        });
        this.state.ball.xv = 3.6;
        this.state.ball.yv = 2.1;
    }

    inputs() {
        const ball = this.state.ball;
        const geometry = getPitchGeometry(this.state).world;
        const radius = this.settings.playerRadius;
        const reach = radius + this.settings.ballRadius + 0.6;
        return this.state.discs.map((disc, slot) => {
            if (!disc) return {};
            const attack = disc.team === 3 ? 1 : -1;
            const dx = ball.x - disc.x;
            const dy = ball.y - disc.y;
            const distance = Math.hypot(dx, dy);
            const behindBall = attack * dx > 0;
            const approach = radius + this.settings.ballRadius + 0.45;
            // Approach from the team's own side, with a small deterministic
            // lateral waypoint so the two players do not form a static scrum.
            let targetX = ball.x - attack * approach;
            let targetY = ball.y + Math.sin(this.ticks / 38 + slot * 2.4) * 1.8;
            if (behindBall && distance < approach + 1.3) {
                targetX = ball.x + attack * 0.3;
                targetY = ball.y;
            }
            targetX = clamp(targetX, radius + 0.1, geometry.width - radius - 0.1);
            targetY = clamp(targetY, radius + 0.1, geometry.height - radius - 0.1);
            return {
                left: targetX < disc.x - 0.12,
                right: targetX > disc.x + 0.12,
                up: targetY < disc.y - 0.12,
                down: targetY > disc.y + 0.12,
                action: behindBall && distance < reach && this.ticks % 6 === slot * 3,
                action2: false,
            };
        });
    }

    step(now) {
        if (!Number.isFinite(now)) return this.state;
        if (this.lastAt === null) {
            this.lastAt = now;
            return this.state;
        }
        this.accumulator += clamp(now - this.lastAt, 0, 250);
        this.lastAt = now;
        let steps = 0;
        while (this.accumulator + 1e-7 >= STEP_MS && steps < 8) {
            this.accumulator -= STEP_MS;
            // This unattended scene skips the next kickoff's waiting period.
            // Real room countdowns remain entirely owned by the server.
            if (this.state.fte === 0) this.resetRound(this.state.scores);
            this.state = this.physics.step(this.state, this.inputs());
            this.ticks++;
            steps++;
        }
        return this.state;
    }
}
