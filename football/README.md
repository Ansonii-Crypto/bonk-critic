# Football

The unlisted game page is available at `/football/`. It is excluded from the
site navigation and asks search engines not to index it. Everyone visiting this
link joins the same shared football lobby.

## Playing

Enter a display name and choose Join football. A voting station on the pitch
offers Balanced teams and Rockets. Each connected participant has one vote;
spectators can watch. Voting lasts fifteen seconds, or ends sooner when every
eligible player has voted. A tie selects Balanced teams.

Balanced teams keeps the sides as even as possible, with up to four players per
side. A single player can start a practice game. New arrivals join the queue and
take an available place at the next kickoff. Lobby assignments keep team sizes
within one player while moving as few existing players as possible. Players
can opt out and spectate.

Between games, each team player has a Ready button and a visible ready status.
When every participating player is ready, the server starts a new game
automatically, including solo practice. Spectators do not block the ready
check. Rockets includes its queued participants in this check. Readiness resets
when the lobby roster or match settings change. Site administrators can also
start or end a game.

If a Balanced teams player leaves, a fifteen-second Yes/No vote asks the
remaining participants whether to rebalance. A majority voting Yes starts a
fresh kickoff with even teams and preserves the score. No, a tie, or timeout
continues with the current assignments for the rest of that game. Waiting
players can still fill vacancies.

Game results appear over the dimmed pitch for ten seconds, followed by another
mode vote and the next lobby. The server owns phase deadlines and voting
eligibility.

## Rockets

Every participant gets one attacking turn in server-recorded join order. The
attacker plays Blue against up to four other participants defending Red. Other
participants wait for their turns; new arrivals enter the next game. Each turn
allows thirty seconds of active play, excluding kickoff and goal celebration.
A goal or timeout ends the turn. Solo Rockets is also supported.

A successful goal posts a system chat message such as `Player reached 19.6 m/s.`
The measurement matches `Project-002/football-ball-speed.user.js` from the
supplied references: `Math.hypot(ball.xv, ball.yv)`, captured from the scoring
physics tick. Velocity is already in metres per second. Rankings keep full
precision and only round the displayed value.

The end-of-game leaderboard ranks goals from fastest to slowest, with join
order breaking exact ties. Players without a goal appear afterward. Leaving
or disconnecting withdraws that player, skips their current turn, and removes
their leaderboard entry. A resumed seat can join the following game.

Move with WASD or the arrow keys. X, Space and Shift kick; releasing the key
rearms the next successful kick. Holding a kick reduces movement force to 70%.
Z supplies no movement force, allowing normal damping to slow the player.
Enter focuses room chat and Escape releases controls. Touch buttons support
holding movement and kick together. Fullscreen and sound controls are below the
pitch.

Guests choose a room display name. If a visitor is already signed into Bonk
Critic, the server uses that verified Bonk identity. Administrator controls
require the site's existing account sign-in and elevated administrator session;
joining first does not grant permissions. Reloading the same tab resumes its seat
using a room-specific credential, without placing account credentials in the
invite link.

## Match settings

An administrator with access enabled can change these values between games:

| Setting | Native default | Meaning |
| --- | ---: | --- |
| First to | 3 | Goals needed to win a game |
| Goal opening | 13 | Distance between the goal posts in physics units; -1 closes both goals and disables scoring |
| Kick strength | 15 | Impulse applied to the ball by a kick |
| Movement force | 32 | Player acceleration force, which also affects movement speed |
| Ball radius | 0.7 | Ball size in physics units |
| Player radius | 1 | Player/disc size in physics units |
| Pitch width | 730 | Width in display pixels |
| Pitch height | 500 | Height in display pixels |

The server validates every setting, including whether the goal opening fits in
the pitch. The same configuration drives server physics, local prediction and
the rendered field. Closed goals provide a practice game; an administrator can
return it to the lobby. Settings cannot change during an active game.

## Mechanics and provenance

`physics.js` implements the supplied football rules using the modified Box2DWeb
library that Bonk serves at:

- `https://bonk.io/js/physics/box2dweb/Box2DModuleGJMod.js`
- `https://bonk.io/js/SafeTrig.js`

The Box2D copyright and redistribution notice remain at the top of
`vendor/box2d.js`. Its AMD wrapper was adapted to an ES module with an explicit
SafeTrig import; the physics implementation is unchanged. `vendor/safe-trig.js`
implements the same seven-decimal-place rounded trigonometry.

The supplied `bonkannotated.js` and deobfuscated client provided the football
constants and rules. The new wrapper was checked against an independently
executed copy of those football functions: 400 ticks across five scenarios
matched numerically, including movement, kicks, crowded contacts, walls, posts,
goals and round resets. State-only parity fixtures are in
`worker/tests/fixtures/football-native-parity.json`.

The pitch is 730 by 500 display units at 11 pixels per physics unit. The engine
runs at 30 Hz. Blue spawns on the left and attacks right; Red spawns on the right
and attacks left. The ball collides with the inner walls; players can move
outside those markings, while both collide with the posts. Kickoff freezes for
120 ticks. A goal starts a 90-tick celebration before a new kickoff; reaching
the winning score finishes the match after that celebration.

The Canvas renderer, generated sound cues, room protocol and frontend are Bonk
Critic implementations. This page connects to Bonk Critic rooms, and does not
join Bonk's public rooms or grant Bonk account XP.

## Server and deployment

`FootballRoom` is an authoritative Cloudflare Durable Object. It advances physics
at 30 Hz and sends snapshots at 15 Hz. Clients send held input flags and use the
same physics for bounded local prediction, with remote-state interpolation.
Only the server changes positions, scores, membership, queue order, readiness
and administrator permissions. Administrator actions revalidate the existing
database sessions and linked Bonk account on the server.

The Worker exposes lobby information and joining at `/api/football/lobby`, and
a ticketed WebSocket under `/api/football/rooms`. Legacy room URLs are aliases
for the shared lobby and cannot create separate games. WebSocket tickets are single-use and expire
after 30 seconds. Resume credentials rotate, inputs expire after one second,
silent connections close after fifteen seconds, and disconnected seats have a
fifteen-second grace period. Idle membership is cleared without discarding the
shared match configuration. Mode votes, rebalance votes, turn clocks and results
are checkpointed with the game. Chat,
message sizes, input rates and roster sizes are bounded.

Deploy the existing Worker with its `FOOTBALL_ROOMS` binding and `football-v1`
SQLite Durable Object migration, then publish the `football/` directory to Pages:

```powershell
npx wrangler deploy --config worker/wrangler.toml
```

No player-database D1 migration is required. Match checkpoints live in the room's
Durable Object storage, separate from assessments, comments and account sessions.
