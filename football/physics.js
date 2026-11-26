import Box2D from './vendor/box2d.js';
import {DEFAULT_MATCH_SETTINGS, validateMatchSettings} from './settings.js';

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
    const {settings, error} = validateMatchSettings(options.settings === undefined ? {} : options.settings);
    if (error) throw new RangeError(error);
    const customized = Object.keys(DEFAULT_MATCH_SETTINGS).some(key => settings[key] !== DEFAULT_MATCH_SETTINGS[key]);
    const state = {
        scores: [0, 0, 0, 0],
        goalHeight: settings.goalHeight,
        borderThickness: C.BORDER_THICKNESS,
        borderThicknessXInner: C.INNER_BORDER_X,
        borderThicknessYInner: C.INNER_BORDER_Y,
        ppm: C.PPM,
        fte: -1,
        ftu: options.kickoffTicks ?? C.KICKOFF_TICKS,
        lscr: -1,
        ni: true,
        ball: {x: settings.pitchWidth / 2 / C.PPM, y: settings.pitchHeight / 2 / C.PPM, xv: 0, yv: 0},
        players: players.map(player => player ? {...player} : null),
        seed: options.seed ?? 1,
        discs: [],
        sts: [],
    };
    // Keeping the native default shape also makes historical checkpoints and
    // fixtures valid. Customized states carry every setting for replay/reset.
    if (customized) state.settings = settings;
    const perTeam = [0, 0, 0, 0];
    state.players.forEach((player, slot) => {
        if (!player || (player.team !== 2 && player.team !== 3)) return;
        const team = player.team;
        const index = perTeam[team]++;
        let rowOffset = Math.ceil(index / 2) * 80 * (settings.pitchHeight / C.HEIGHT);
        if ((team === 2 && index % 2 === 0) || (team === 3 && index % 2 === 1)) {
            rowOffset = -rowOffset;
        }
        state.discs[slot] = {
            x: (settings.pitchWidth / 2 + (team === 3 ? -250 : 250) * (settings.pitchWidth / C.WIDTH)) / C.PPM,
            y: (settings.pitchHeight / 2 + rowOffset) / C.PPM,
            xv: 0,
            yv: 0,
            team,
            kickReady: true,
        };
    });
    return state;
}

export function getPitchGeometry(state = {}) {
    const settings = {...DEFAULT_MATCH_SETTINGS, ...state.settings};
    const ppm = state.ppm ?? C.PPM;
    const goalHeight = state.goalHeight ?? settings.goalHeight;
    const goalEnabled = goalHeight !== -1;
    const width = settings.pitchWidth;
    const height = settings.pitchHeight;
    const left = (state.borderThickness ?? C.BORDER_THICKNESS) + (state.borderThicknessXInner ?? C.INNER_BORDER_X);
    const top = (state.borderThickness ?? C.BORDER_THICKNESS) + (state.borderThicknessYInner ?? C.INNER_BORDER_Y);
    const centerX = width / 2;
    const centerY = height / 2;
    const halfGoal = goalEnabled ? goalHeight * ppm / 2 : 0;
    const pixels = {
        width,
        height,
        centerX,
        centerY,
        left,
        right: width - left,
        top,
        bottom: height - top,
        goalTop: centerY - halfGoal,
        goalBottom: centerY + halfGoal,
        wallThickness: 5,
        postRadius: 8,
        ballRadius: settings.ballRadius * ppm,
        playerRadius: settings.playerRadius * ppm,
        posts: [],
    };
    if (goalEnabled) {
        pixels.posts = [
            {x: pixels.left, y: pixels.goalTop, radius: pixels.postRadius},
            {x: pixels.right, y: pixels.goalTop, radius: pixels.postRadius},
            {x: pixels.left, y: pixels.goalBottom, radius: pixels.postRadius},
            {x: pixels.right, y: pixels.goalBottom, radius: pixels.postRadius},
        ];
    }
    const world = Object.fromEntries(Object.entries(pixels).filter(([key]) => key !== 'posts').map(([key, value]) => [key, value / ppm]));
    world.posts = pixels.posts.map(post => ({x: post.x / ppm, y: post.y / ppm, radius: post.radius / ppm}));
    return {ppm, goalEnabled, pixels, world};
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
    const settings = state.settings || DEFAULT_MATCH_SETTINGS;
    const ppm = state.ppm;
    const halfWidth = (settings.pitchWidth - 2 * (state.borderThickness + state.borderThicknessXInner)) / ppm / 2;
    const halfHeight = (settings.pitchHeight - 2 * (state.borderThickness + state.borderThicknessYInner)) / ppm / 2;
    const goalEnabled = state.goalHeight !== -1;
    const halfGoal = state.goalHeight / 2;
    const wall = 5 / ppm;
    const definition = new BodyDef();
    definition.type = Body.b2_staticBody;
    definition.position.Set(settings.pitchWidth / 2 / ppm, settings.pitchHeight / 2 / ppm);
    const body = world.CreateBody(definition);
    body.SetUserData({type: 'wall'});

    const fixture = new FixtureDef();
    fixture.friction = 0;
    fixture.restitution = C.WALL_RESTITUTION;
    fixture.filter.maskBits = 4;
    // Match native vertex/fixture order whenever goals are enabled. Players
    // pass through the wall polygons, but collide with the round posts.
    const polygons = [
        [[halfWidth + wall, -halfHeight], [-halfWidth - wall, -halfHeight], [-halfWidth - wall, -halfHeight - wall], [halfWidth + wall, -halfHeight - wall]],
        [[halfWidth + wall, halfHeight + wall], [-halfWidth - wall, halfHeight + wall], [-halfWidth - wall, halfHeight], [halfWidth + wall, halfHeight]],
    ];
    if (goalEnabled) {
        polygons.push(
            [[-halfWidth, -halfGoal], [-halfWidth - wall, -halfGoal], [-halfWidth - wall, -halfHeight], [-halfWidth, -halfHeight]],
            [[halfWidth, -halfHeight], [halfWidth + wall, -halfHeight], [halfWidth + wall, -halfGoal], [halfWidth, -halfGoal]],
            [[-halfWidth, halfHeight], [-halfWidth - wall, halfHeight], [-halfWidth - wall, halfGoal], [-halfWidth, halfGoal]],
            [[halfWidth, halfGoal], [halfWidth + wall, halfGoal], [halfWidth + wall, halfHeight], [halfWidth, halfHeight]],
        );
    } else {
        polygons.push(
            [[-halfWidth, halfHeight], [-halfWidth - wall, halfHeight], [-halfWidth - wall, -halfHeight], [-halfWidth, -halfHeight]],
            [[halfWidth, -halfHeight], [halfWidth + wall, -halfHeight], [halfWidth + wall, halfHeight], [halfWidth, halfHeight]],
        );
    }
    for (const vertices of polygons) {
        fixture.shape = new Polygon();
        fixture.shape.SetAsArray(vertices.map(([x, y]) => new Vec2(x, y)));
        body.CreateFixture(fixture);
    }
    fixture.restitution = C.POST_RESTITUTION;
    fixture.filter.maskBits = 6;
    const posts = goalEnabled ? [[-halfWidth, -halfGoal], [halfWidth, -halfGoal], [-halfWidth, halfGoal], [halfWidth, halfGoal]] : [];
    for (const [x, y] of posts) {
        fixture.shape = new Circle(8 / ppm);
        fixture.shape.SetLocalPosition(new Vec2(x, y));
        body.CreateFixture(fixture);
    }
    return body;
}

function applyInputs(body, input, settings) {
    const force = new Vec2(
        input.left ? -settings.moveForce : input.right ? settings.moveForce : 0,
        input.up ? -settings.moveForce : input.down ? settings.moveForce : 0,
    );
    if (input.action) force.Multiply(C.ACTION_MOVE_MULTIPLIER);
    if (input.action2) force.Set(0, 0);
    body.ApplyForce(force, body.GetWorldCenter());
}

function kick(body, disc, input, ball, sounds, settings) {
    let kickReady = disc.kickReady;
    if (input.action && kickReady) {
        const position = body.GetPosition();
        const ballPosition = ball.GetPosition();
        const dx = ballPosition.x - position.x;
        const dy = ballPosition.y - position.y;
        const distance = Math.sqrt(dx * dx + dy * dy);
        if (distance < settings.playerRadius + settings.ballRadius + 0.6) {
            // Coincident centres are not a useful aim direction. Choosing the
            // team's attack direction keeps an overlapping spawn finite.
            const impulse = settings.kickImpulse === 0 ? new Vec2(0, 0) : distance > 0
                ? new Vec2(dx / (distance / settings.kickImpulse), dy / (distance / settings.kickImpulse))
                : new Vec2(disc.team === 2 ? -settings.kickImpulse : settings.kickImpulse, 0);
            ball.ApplyImpulse(impulse, ballPosition);
            kickReady = false;
            sounds.push({i: 'footKick', v: 1, f: 10});
        }
    }
    if (!input.action) kickReady = true;
    return kickReady;
}

function clampPlayer(body, ppm, settings) {
    const position = body.GetPosition();
    const velocity = body.GetLinearVelocity();
    const radius = settings.playerRadius;
    if (position.x < radius) {
        position.x = radius;
        velocity.x = 0;
    }
    if (position.x > settings.pitchWidth / ppm - radius) {
        position.x = settings.pitchWidth / ppm - radius;
        velocity.x = 0;
    }
    if (position.y < radius) {
        position.y = radius;
        velocity.y = 0;
    }
    if (position.y > settings.pitchHeight / ppm - radius) {
        position.y = settings.pitchHeight / ppm - radius;
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
        const settings = state.settings || DEFAULT_MATCH_SETTINGS;
        const world = this.world;
        world.novakReset();
        world.SetContactListener(this.contactListener);
        this.sounds = [];
        const left = new Set(playerChanges?.playersLeft || []);
        const pitch = createPitch(world, state);
        const ball = createCircle(world, state.ball, {
            radius: settings.ballRadius, mass: C.BALL_MASS, damping: C.BALL_LINEAR_DAMPING, category: 4, type: 'ball',
        });
        const bodies = [];
        const ready = [];
        try {
            state.discs.forEach((disc, slot) => {
                if (!disc || left.has(slot)) return;
                bodies[slot] = createCircle(world, disc, {
                    radius: settings.playerRadius, mass: C.PLAYER_MASS, damping: C.PLAYER_LINEAR_DAMPING, category: 2, type: 'disc',
                });
                ready[slot] = disc.kickReady;
            });
            if (state.ftu === -1) {
                bodies.forEach((body, slot) => {
                    const input = inputsBySlot[slot];
                    if (!input) return;
                    applyInputs(body, input, settings);
                    ready[slot] = kick(body, state.discs[slot], input, ball, this.sounds, settings);
                });
                world.Step(C.DT, C.VELOCITY_ITERATIONS, C.POSITION_ITERATIONS);
            }
            world.ClearForces();
            bodies.forEach(body => clampPlayer(body, state.ppm, settings));

            const scores = state.scores.slice();
            let lastScorer = state.lscr;
            let goalScored = false;
            if (state.ftu === -1 && state.fte === -1 && state.goalHeight !== -1) {
                const x = ball.GetPosition().x;
                const leftGoal = (state.borderThickness + state.borderThicknessXInner) / state.ppm;
                const rightGoal = (settings.pitchWidth - state.borderThickness - state.borderThicknessXInner) / state.ppm;
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
            if (state.settings) next.settings = {...settings};
            if (state.fte === 0) {
                const kickoff = createState(next.players, {seed: state.seed, settings});
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
