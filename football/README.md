# Football

The unlisted game page is available at `/football/`. It is excluded from the
site navigation and asks search engines not to index it. Everyone visiting this
link watches the same shared football pitch. Watching does not reserve a place
or receive room chat. The join screen shows the actual server match; there
are no demo players. If the live stream stalls, the last real frame remains
visible while the viewer reconnects.

## Playing

Choose Join game and sign in with a Bonk account if needed. Sign-in opens over
the dimmed page without leaving football. Joining is verified by the server.
A voting station on the pitch
offers Balanced teams and Rockets. Each connected participant has one vote;
spectators can watch. Voting lasts fifteen seconds, or ends sooner when every
eligible player has voted. A tie selects Balanced teams.

Balanced teams keeps the sides as even as possible, with up to four players per
side. A single player can start a practice game. New arrivals remain in
Spectators until the next game, including across goals and rebalances. Lobby assignments keep team sizes
within one player while moving as few existing players as possible. Players
can opt out and spectate. Each team has a Join button underneath its players;
Spectate opts out of the next game. Blue, Red and Spectators share a compact
three-column row at the top of the pitch. There are no separate lobby side
preference buttons. Joining a team saves that preference while keeping the
teams balanced.

The lobby is playable. Connected team members can move around the entire canvas,
kick the ball and collide with posts and other players while waiting. This uses
the same authoritative physics as the match, with no goals, round countdowns
or results. A ball kicked through an opening bounces at the outside of the
canvas, keeping it reachable. Spectators watch without controlling a disc.

Between games, each team player has a Ready button and a visible ready status.
When every participating player is ready, the server starts a new game
automatically, including solo practice. Spectators do not block the ready
check. Rockets includes its queued participants in this check. Readiness resets
when the lobby roster or match settings change. Ready and the administrator's
Start button sit together below the team lists. Site administrators can also
end a game.

If a Balanced teams player leaves, a fifteen-second Yes/No vote asks the
remaining participants whether to rebalance. A majority voting Yes starts a
fresh kickoff with even teams and preserves the score. No, a tie, or timeout
continues with the current assignments for the rest of that game. Rebalancing
only moves players already on the pitch; waiting spectators enter the next game.

Game results appear over the dimmed pitch for ten seconds, followed by another
mode vote and the next lobby. The server owns phase deadlines and voting
eligibility.

## Rockets

Every participant gets one attacking turn in server-recorded join order. The
attacker chooses Blue, Red or Random. Only that attacker is on the pitch;
everyone else watches. Random alternates shooting sides in join order. Other
participants wait for their turns; new arrivals enter the next game. Each turn
allows thirty seconds of active play, excluding kickoff and goal celebration.
A goal or timeout ends the turn. Solo Rockets is also supported.

The current attacker can change shooting sides once per turn. This restarts
the kickoff while preserving their remaining active time, turn and queue
position. Further preference changes apply to a future turn. Waiting players can
also save a preferred side for their own attacking turn.

A successful goal posts a system chat message such as `Player reached 19.6 m/s.`
The measurement matches `Project-002/football-ball-speed.user.js` from the
supplied references: `Math.hypot(ball.xv, ball.yv)`, captured from the scoring
physics tick. Velocity is already in metres per second. Rankings keep full
precision and only round the displayed value.

Rockets displays live ball speed underneath the ball in the same font and
colour as the player names. Pitch vectors are
cached at the canvas's displayed pixel resolution so enlarging the game does
not enlarge a low-resolution image of the posts, lines and grass pattern.

The end-of-game leaderboard ranks goals from fastest to slowest, with join
order breaking exact ties. Players without a goal appear afterward. Leaving
or disconnecting withdraws that player, skips their current turn, and removes
their leaderboard entry. A resumed seat can join the following game.

Move with WASD or the arrow keys. X, Space and Shift kick; releasing the key
rearms the next successful kick. Holding a kick reduces movement force to 70%.
The obsolete brake action is disabled; Z remains available to bind to another
action. Quick heavy presses are retained until a physics tick can process them,
including while several movement keys are held.
Enter focuses room chat; Enter again sends the message and focuses the game,
including when the input is empty. Holding Enter cannot reopen chat after sending.
Escape releases controls. Touch buttons support
holding movement and kick together. Fullscreen, sound and Leave controls
sit over the pitch. Fullscreen expands the pitch and its overlays to the entire
viewport; Exit fullscreen or the browser's Escape key returns to the page.
Normal view puts chat to the left of the pitch and administrator settings to
the right, with a centred team dock capped at 760 pixels. Smaller screens
stack these panels underneath the game. Fullscreen moves chat onto the field
and puts settings in a drawer opened with the arrow on the right edge. Inputs,
pending edits and chat history survive these moves.

Teams are shown automatically between games. Hide game UI hides overlays
inside the pitch while leaving normal side panels visible. Hovering or tapping
the pitch's top-right corner reveals the toolbar without restoring other
overlays. Its Show game UI button restores them. Escape and a double tap on
the pitch also restore controls. The page scrolls underneath its header.

Visitors can watch without signing in. Joining requires a verified Bonk
identity; anonymous joins are rejected on the server. Administrator controls
require the site's existing account sign-in and elevated administrator session;
joining first does not grant permissions. Reloading the same tab resumes its seat
using a room-specific credential, without placing account credentials in the
invite link.

The football header uses the same navigation and account menu as Players and
Classes. Account opens an inline Bonk sign-in form; signed-in visitors have
their skin, Profile, eligible Admin tools and Log out.

## Controls and chat preferences

Bonk's successful login response contains its serialized account controls.
The Worker decodes supported versions 1–6 and saves only the validated movement,
keys plus the cursing-filter preference. Legacy swing/brake bindings can remain
in imported account data for compatibility but are ignored by football. Existing accounts need
to sign out and sign in once to import these settings. A later login refreshes
changes made on Bonk. Invalid or missing controls fall back to the normal keys
without rejecting a valid login.

Keyboard controls can also be customised on the football page. These overrides
are saved for that account in the current browser and do not modify the Bonk
account. Up to three keys per action are supported. Enter and Escape remain
reserved for chat and menus.

Filter profanity controls local chat display and can be toggled at any time,
including for messages already received. Original chat text remains unchanged.
Chat is sent only to currently joined room members. It has no saved backlog
in HTTP responses, WebSocket welcomes or public viewing. Leaving clears this
visit's chat. The browser keeps at most 200 rendered lines, accounting for
wrapped messages and changes in width. In fullscreen, chat sits at the bottom
left with transparent history and a separate input underneath it.
The bundled 94-term list and character folding come from `Bonk.wab`,
`Bonk.charReplacements` and `Bonk.sanitizeString` in the supplied
`Version Storage/bonkannotated.js`. Like that source, matching includes
substrings and replaces detected text with `bonk`. This is the supplied native
list, rather than a claim that every later Bonk release uses identical data.

## Match settings

An administrator with access enabled can edit these values. Each field has a
Default button that restores its input without applying it automatically:

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
return it to the lobby. Apply updates lobby practice immediately. During a
match, Apply queues the settings for the next kickoff or Rockets turn; the
current round keeps its existing geometry and physics. Changes queued during
voting or results apply to the next game. Queued settings are included in the
room checkpoint and are still checked against the administrator's server session.

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

During the ten-second results screen, bodies continue damping and colliding
naturally. Controls, kicks, scoring and kickoff resets are disabled during
this coast, and the server continues sending snapshots until voting starts.

## Server and deployment

`FootballRoom` is an authoritative Cloudflare Durable Object. It advances physics
at 30 Hz and sends snapshots at 15 Hz. Clients send held input flags and use the
same physics for bounded local prediction, with remote-state interpolation.
`prediction.js` keeps a bounded timeline of local held inputs and replays
elapsed physics ticks rather than treating wire acknowledgements as ticks.
The prediction clock continues across snapshots. Normal predicted movement
renders directly; only corrections to authoritative state are smoothed.
Replay is capped at 250 milliseconds and eight steps. Other players retain
their interpolation buffer. The server's movement force and tick rate are
unchanged.
Only the server changes positions, scores, membership, queue order, readiness
and administrator permissions. Administrator actions revalidate the existing
database sessions and linked Bonk account on the server.

The Worker exposes lobby information and joining at `/api/football/lobby`, a
read-only public WebSocket at `/api/football/watch`, and a ticketed member
WebSocket under `/api/football/rooms`. Watchers can only send heartbeat pings;
they cannot affect membership, votes, chat or game state. Legacy room URLs are aliases
for the shared lobby and cannot create separate games. WebSocket tickets are single-use and expire
after 30 seconds. Resume credentials rotate, inputs expire after one second,
silent connections close after fifteen seconds, and disconnected seats have a
fifteen-second grace period. Idle membership is cleared without discarding the
shared match configuration. Mode votes, rebalance votes, turn clocks and results
are checkpointed with the game. Chat,
message sizes, input rates and roster sizes are bounded.

Apply the account-controls table before deploying this version:

```powershell
npx wrangler d1 execute player-database --remote --config worker/wrangler.toml --file worker/migrations/0017_account_controls.sql
```

Deploy the existing Worker with its `FOOTBALL_ROOMS` binding and `football-v1`
SQLite Durable Object migration, then publish the `football/` directory to Pages:

```powershell
npx wrangler deploy --config worker/wrangler.toml --durable-objects-code-update-mode immediate
```

Immediate game-code updates reconnect active clients. Match checkpoints live in the room's
Durable Object storage, separate from assessments, comments and account sessions.
