import Box2D from './vendor/box2d.js';

// Mechanics and geometry checked against the supplied Bonk football client:
// bonkannotated.js:11925, 12341, 12530, 12583, 12722. World units are metres.
export const FOOTBALL_CONSTANTS = Object.freeze({
    WIDTH: 730,
    HEIGHT: 500,
    PPM: 11,
    TICK_RATE: 30,
    DT: 1 / 30,
    PLAYER_RADIUS: 1,
    BALL_RADIUS: 0.7,
    PLAYER_MASS: 1.05,
    BALL_MASS: 0.6,
    PLAYER_LINEAR_DAMPING: 2.4,
    BALL_LINEAR_DAMPING: 0.6,
    MOVE_FORCE: 32,
    ACTION_MOVE_MULTIPLIER: 0.7,
    KICK_IMPULSE: 15,
    KICK_REACH: 2.3,
    RESTITUTION: 0.4,
    WALL_RESTITUTION: 0.8,
    POST_RESTITUTION: 0.9,
    BORDER_THICKNESS: 5,
    INNER_BORDER_X: 25,
    INNER_BORDER_Y: 70,
    GOAL_HEIGHT: 13,
    POST_RADIUS: 8 / 11,
    WALL_THICKNESS: 5 / 11,
    KICKOFF_TICKS: 120,
    GOAL_TICKS: 90,
    VELOCITY_ITERATIONS: 2,
    POSITION_ITERATIONS: 6,
});

const C = FOOTBALL_CONSTANTS;
const Vec2 = Box2D.Common.Math.b2Vec2;
const BodyDef = Box2D.Dynamics.b2BodyDef;
const Body = Box2D.Dynamics.b2Body;
const FixtureDef = Box2D.Dynamics.b2FixtureDef;
const World = Box2D.Dynamics.b2World;
const Circle = Box2D.Collision.Shapes.b2CircleShape;
const Polygon = Box2D.Collision.Shapes.b2PolygonShape;

export function createState(players = [], options = {}) {
    const state = {
        scores: [0, 0, 0, 0],
        goalHeight: C.GOAL_HEIGHT,
        borderThickness: C.BORDER_THICKNESS,
        borderThicknessXInner: C.INNER_BORDER_X,
        borderThicknessYInner: C.INNER_BORDER_Y,
        ppm: C.PPM,
        fte: -1,
        ftu: options.kickoffTicks ?? C.KICKOFF_TICKS,
        lscr: -1,
        ni: true,
        ball: {x: C.WIDTH / 2 / C.PPM, y: C.HEIGHT / 2 / C.PPM, xv: 0, yv: 0},
        players: players.map(player => player ? {...player} : null),
        seed: options.seed ?? 1,
        discs: [],
        sts: [],
    };
    const perTeam = [0, 0, 0, 0];
    state.players.forEach((player, slot) => {
        if (!player || (player.team !== 2 && player.team !== 3)) return;
        const team = player.team;
        const index = perTeam[team]++;
        let rowOffset = Math.ceil(index / 2) * 80;
        if ((team === 2 && index % 2 === 0) || (team === 3 && index % 2 === 1)) {
            rowOffset = -rowOffset;
        }
        state.discs[slot] = {
            x: (C.WIDTH / 2 + (team === 3 ? -250 : 250)) / C.PPM,
            y: (C.HEIGHT / 2 + rowOffset) / C.PPM,
            xv: 0,
            yv: 0,
            team,
            kickReady: true,
        };
    });
    return state;
}

function outputBody(body) {
    const position = body.GetPosition();
    const velocity = body.GetLinearVelocity();
    return {x: position.x, y: position.y, xv: velocity.x, yv: velocity.y};
}

function createCircle(world, source, {radius, mass, damping, category, type}) {
    const definition = new BodyDef();
    definition.type = Body.b2_dynamicBody;
    definition.position.Set(source.x, source.y);
    definition.fixedRotation = true;
    definition.linearDamping = damping;
    definition.linearVelocity.Set(source.xv, source.yv);
    definition.bullet = true;
    const body = world.CreateBody(definition);
    const fixture = new FixtureDef();
    fixture.shape = new Circle(radius);
    fixture.friction = 0;
    fixture.restitution = C.RESTITUTION;
    fixture.density = mass / (Math.PI * radius * radius);
    fixture.filter.categoryBits = category;
    body.CreateFixture(fixture);
    body.SetUserData({type});
    return body;
}

function createPitch(world, state) {
    const ppm = state.ppm;
    const halfWidth = (C.WIDTH - 2 * (state.borderThickness + state.borderThicknessXInner)) / ppm / 2;
    const halfHeight = (C.HEIGHT - 2 * (state.borderThickness + state.borderThicknessYInner)) / ppm / 2;
    const halfGoal = state.goalHeight / 2;
    const wall = 5 / ppm;
    const definition = new BodyDef();
    definition.type = Body.b2_staticBody;
    definition.position.Set(C.WIDTH / 2 / ppm, C.HEIGHT / 2 / ppm);
    const body = world.CreateBody(definition);
    body.SetUserData({type: 'wall'});

    const fixture = new FixtureDef();
    fixture.friction = 0;
    fixture.restitution = C.WALL_RESTITUTION;
    fixture.filter.maskBits = 4;
    // Match the native vertex order and fixture creation order. Players pass
    // through these six wall polygons, but collide with the four round posts.
    const polygons = [
        [[halfWidth + wall, -halfHeight], [-halfWidth - wall, -halfHeight], [-halfWidth - wall, -halfHeight - wall], [halfWidth + wall, -halfHeight - wall]],
        [[halfWidth + wall, halfHeight + wall], [-halfWidth - wall, halfHeight + wall], [-halfWidth - wall, halfHeight], [halfWidth + wall, halfHeight]],
        [[-halfWidth, -halfGoal], [-halfWidth - wall, -halfGoal], [-halfWidth - wall, -halfHeight], [-halfWidth, -halfHeight]],
        [[halfWidth, -halfHeight], [halfWidth + wall, -halfHeight], [halfWidth + wall, -halfGoal], [halfWidth, -halfGoal]],
        [[-halfWidth, halfHeight], [-halfWidth - wall, halfHeight], [-halfWidth - wall, halfGoal], [-halfWidth, halfGoal]],
        [[halfWidth, halfGoal], [halfWidth + wall, halfGoal], [halfWidth + wall, halfHeight], [halfWidth, halfHeight]],
    ];
    for (const vertices of polygons) {
        fixture.shape = new Polygon();
        fixture.shape.SetAsArray(vertices.map(([x, y]) => new Vec2(x, y)));
        body.CreateFixture(fixture);
    }
    fixture.restitution = C.POST_RESTITUTION;
    fixture.filter.maskBits = 6;
    for (const [x, y] of [[-halfWidth, -halfGoal], [halfWidth, -halfGoal], [-halfWidth, halfGoal], [halfWidth, halfGoal]]) {
        fixture.shape = new Circle(8 / ppm);
        fixture.shape.SetLocalPosition(new Vec2(x, y));
        body.CreateFixture(fixture);
    }
    return body;
}

function applyInputs(body, input) {
    const force = new Vec2(
        input.left ? -C.MOVE_FORCE : input.right ? C.MOVE_FORCE : 0,
        input.up ? -C.MOVE_FORCE : input.down ? C.MOVE_FORCE : 0,
    );
    if (input.action) force.Multiply(C.ACTION_MOVE_MULTIPLIER);
    if (input.action2) force.Set(0, 0);
    body.ApplyForce(force, body.GetWorldCenter());
}

function kick(body, disc, input, ball, sounds) {
    let kickReady = disc.kickReady;
    if (input.action && kickReady) {
        const position = body.GetPosition();
        const ballPosition = ball.GetPosition();
        const dx = ballPosition.x - position.x;
        const dy = ballPosition.y - position.y;
        const distance = Math.sqrt(dx * dx + dy * dy);
        if (distance < C.KICK_REACH) {
            // Coincident centres are not a useful aim direction. Choosing the
            // team's attack direction keeps an overlapping spawn finite.
            const impulse = distance > 0
                ? new Vec2(dx / (distance / C.KICK_IMPULSE), dy / (distance / C.KICK_IMPULSE))
                : new Vec2(disc.team === 2 ? -C.KICK_IMPULSE : C.KICK_IMPULSE, 0);
            ball.ApplyImpulse(impulse, ballPosition);
            kickReady = false;
            sounds.push({i: 'footKick', v: 1, f: 10});
        }
    }
    if (!input.action) kickReady = true;
    return kickReady;
}

function clampPlayer(body, ppm) {
    const position = body.GetPosition();
    const velocity = body.GetLinearVelocity();
    if (position.x < C.PLAYER_RADIUS) {
        position.x = C.PLAYER_RADIUS;
        velocity.x = 0;
    }
    if (position.x > C.WIDTH / ppm - C.PLAYER_RADIUS) {
        position.x = C.WIDTH / ppm - C.PLAYER_RADIUS;
        velocity.x = 0;
    }
    if (position.y < C.PLAYER_RADIUS) {
        position.y = C.PLAYER_RADIUS;
        velocity.y = 0;
    }
    if (position.y > C.HEIGHT / ppm - C.PLAYER_RADIUS) {
        position.y = C.HEIGHT / ppm - C.PLAYER_RADIUS;
        velocity.y = 0;
    }
}

export class FootballPhysics {
    constructor() {
        this.world = new World(new Vec2(0, 0));
        this.world.SetWarmStarting(false);
        this.sounds = [];
        this.contactListener = {
            BeginContact() {},
            EndContact() {},
            PreSolve() {},
            PostSolve: (contact, impulse) => {
                const a = contact.GetFixtureA().GetBody().GetUserData();
                const b = contact.GetFixtureB().GetBody().GetUserData();
                const magnitude = impulse.normalImpulses[0];
                if ((a?.type === 'ball' || b?.type === 'ball') && magnitude > 1) {
                    this.sounds.push({i: 'footBounce', v: magnitude, f: 5});
                }
            },
        };
    }

    createState(players = [], options = {}) {
        return createState(players, options);
    }

    step(state, inputsBySlot = [], playerChanges = null) {
        const world = this.world;
        world.novakReset();
        world.SetContactListener(this.contactListener);
        this.sounds = [];
        const left = new Set(playerChanges?.playersLeft || []);
        const pitch = createPitch(world, state);
        const ball = createCircle(world, state.ball, {
            radius: C.BALL_RADIUS, mass: C.BALL_MASS, damping: C.BALL_LINEAR_DAMPING, category: 4, type: 'ball',
        });
        const bodies = [];
        const ready = [];
        try {
            state.discs.forEach((disc, slot) => {
                if (!disc || left.has(slot)) return;
                bodies[slot] = createCircle(world, disc, {
                    radius: C.PLAYER_RADIUS, mass: C.PLAYER_MASS, damping: C.PLAYER_LINEAR_DAMPING, category: 2, type: 'disc',
                });
                ready[slot] = disc.kickReady;
            });
            if (state.ftu === -1) {
                bodies.forEach((body, slot) => {
                    const input = inputsBySlot[slot];
                    if (!input) return;
                    applyInputs(body, input);
                    ready[slot] = kick(body, state.discs[slot], input, ball, this.sounds);
                });
                world.Step(C.DT, C.VELOCITY_ITERATIONS, C.POSITION_ITERATIONS);
            }
            world.ClearForces();
            bodies.forEach(body => clampPlayer(body, state.ppm));

            const scores = state.scores.slice();
            let lastScorer = state.lscr;
            let goalScored = false;
            if (state.ftu === -1 && state.fte === -1) {
                const x = ball.GetPosition().x;
                const leftGoal = (state.borderThickness + state.borderThicknessXInner) / state.ppm;
                const rightGoal = (C.WIDTH - state.borderThickness - state.borderThicknessXInner) / state.ppm;
                if (x < leftGoal) {
                    scores[2]++;
                    lastScorer = 2;
                    goalScored = true;
                    this.sounds.push({i: 'footGoal', v: 1, p: 'l', f: 5});
                }
                if (x > rightGoal) {
                    scores[3]++;
                    lastScorer = 3;
                    goalScored = true;
                    this.sounds.push({i: 'footGoal', v: 1, p: 'r', f: 5});
                }
            }
            const next = {
                scores,
                goalHeight: state.goalHeight,
                borderThickness: state.borderThickness,
                borderThicknessXInner: state.borderThicknessXInner,
                borderThicknessYInner: state.borderThicknessYInner,
                ppm: state.ppm,
                lscr: lastScorer,
                seed: state.seed,
                ni: false,
                players: state.players.map(player => player && !left.has(player.id) ? {...player} : null),
                sts: state.sts.filter(sound => sound && sound.f > 0).map(sound => ({...sound, f: sound.f - 1})).concat(this.sounds),
                fte: goalScored ? C.GOAL_TICKS : Math.max(-1, state.fte - 1),
                ftu: Math.max(-1, state.ftu - 1),
                ball: outputBody(ball),
                discs: bodies.map((body, slot) => ({...outputBody(body), team: state.discs[slot].team, kickReady: ready[slot]})),
            };
            if (state.fte === 0) {
                const kickoff = createState(next.players, {seed: state.seed});
                kickoff.scores = scores;
                return kickoff;
            }
            return next;
        } finally {
            world.DestroyBody(ball);
            bodies.forEach(body => world.DestroyBody(body));
            world.DestroyBody(pitch);
        }
    }
}
