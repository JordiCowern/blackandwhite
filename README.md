# Leverage

An online social deduction game for 4 to 8 players. Everyone has committed a crime,
and the four clues to each crime are scattered among the other players. Take clues,
demand them with threats, bluff, and gather every clue on someone to put them in prison.
The last suspect still free wins.

## Run it locally

You need Node.js 18 or newer. There are no packages to install.

```
npm start
```

Open http://localhost:3000. To test with several players on one computer, open extra
windows in private/incognito mode (each window needs its own browser storage), or use
**Add a bot** in the lobby.

## Deploy it

The server is one Node process that serves the page and the game API on the port in the
`PORT` environment variable. Any host that runs a long-lived Node app works, for example
Render, Railway, Fly.io, or a VPS.

- **Start command:** `npm start` (or `node server.js`)
- **Health check:** `GET /healthz`
- **One instance only.** Rooms live in the server's memory, so run a single instance and
  don't autoscale. Restarting the server ends any games in progress.
- **Live updates** use server-sent events on `/api/rooms/<code>/events`. Most hosts pass
  these through. If you put nginx in front, the server already sends
  `X-Accel-Buffering: no`; also make sure `proxy_read_timeout` is at least 60 seconds.
- Serverless platforms (Vercel functions, Netlify functions, Lambda) won't work, because
  they don't keep a process running between requests.

Optional environment variables: `PORT` (default 3000), `HOST` (default 0.0.0.0),
`MAX_ROOMS` (default 2000).

## How the code is laid out

- `server.js` serves `public/`, creates and joins rooms, takes actions, and streams each
  player their own view of the game.
- `game.js` holds all the rules: lobby, dealing, turns, demands, leaks, arrests, timers,
  win conditions, how an arrest splits the prisoner's hand, bots, and `view()`, which builds what one player is allowed to see.
  Hidden clues are never sent to anyone who doesn't hold them.
- `public/` is the client: `index.html`, `style.css`, `app.js`.
- `test/simulate.js` plays 100 all-bot games and checks that no clue is ever lost or
  duplicated and that every game ends (`npm test`).

## Settings you might want to change

All in `LIMITS` at the top of `game.js`: player counts, the 25-round limit, when duplicate cards kick in (`BIG_GAME_FROM`) and the bigger hand size (`BIG_HAND`), the turn clock
(60 seconds), the clock for answering a demand (30 seconds) and for deciding whether to leak
(25 seconds), and how long bots think.

## Rules as built

- Four clues per player: crime, crime scene, motive and witness. In games of 6 or more
  players, two clues about each crime get a second copy, so hands start at 6 cards instead
  of 4. Holding either copy of a clue counts. Nobody is dealt two copies of the same clue.
- On your turn: take a random clue from a suspect, demand a specific clue (threatening to
  leak a clue about them), or pass.
- A refused demand: the demander can leak a clue they hold about the target onto the public
  record, or back down. A demander holding nothing on the target backs down automatically,
  and other players can't tell the difference.
- A leaked clue counts for everyone. Holding all four clues on someone, counting public
  ones, sends them to prison.
- An arrest splits the prisoner's hand: half (rounded up) goes to the arrester, and the rest
  is handed out at random to the other suspects still free. Each recipient sees what they
  got; everyone else only sees the counts.
- Nobody can ever hold a clue about their own crime: it isn't dealt to them, they can't
  demand it, a random take never picks it, and an arrest never hands it to them. If a
  suspect is holding only clues about your crime, you can't take from them at random.
- When a clock runs out you pass, refuse, or back down. A disconnected player gets an
  8-second clock until they reconnect. A player who leaves mid-game is replaced by a bot.
- Last suspect free wins. After 25 rounds, the player closest to completing a crime wins.
