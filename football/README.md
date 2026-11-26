# Football

The unlisted game page is available at `/football/`. It is excluded from the
site navigation and asks search engines not to index it. Share the room's invite
link to bring another player into the same match.

## Playing

Create a room, or paste a room code or invite link. Choose Blue, Red or Spectate.
The host can assign teams, remove members, set the winning score from 1 to 9,
start a match, return to the lobby or start a rematch. Each side supports four
players, with up to sixteen room members including spectators.

Move with WASD or the arrow keys. X, Space and Shift kick; releasing the key
rearms the next successful kick. Holding a kick reduces movement force to 70%.
Z supplies no movement force, allowing normal damping to slow the player.
Enter focuses room chat and Escape releases controls. Touch buttons support
holding movement and kick together. Fullscreen and sound controls are below the
pitch.

Guests choose a room display name. If a visitor is already signed into Bonk
Critic, the server uses that verified Bonk identity. Room hosting is separate
from site administrator permissions. Reloading the same tab resumes its seat
using a room-specific credential, without placing account credentials in the
invite link.

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
Only the server changes positions, scores, membership and host permissions.

The Worker exposes room creation, room information, joining and a ticketed
WebSocket under `/api/football/rooms`. WebSocket tickets are single-use and expire
after 30 seconds. Resume credentials rotate, inputs expire after one second,
silent connections close after fifteen seconds, and disconnected seats have a
fifteen-second grace period. Empty rooms expire after thirty minutes. Chat,
message sizes, input rates and roster sizes are bounded.

Deploy the existing Worker with its `FOOTBALL_ROOMS` binding and `football-v1`
SQLite Durable Object migration, then publish the `football/` directory to Pages:

```powershell
npx wrangler deploy --config worker/wrangler.toml
```

No player-database D1 migration is required. Match checkpoints live in the room's
Durable Object storage, separate from assessments, comments and account sessions.
