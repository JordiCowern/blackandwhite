# Leverage

An online social deduction game for 4 to 8 players. Everyone has committed a crime, and
the clues to each crime are scattered among the other players. Take clues, demand them
with threats, bluff, and gather every clue on someone to put them in prison. The last
suspect still free wins.

This version is a static site, so it runs on GitHub Pages with no server.

## Put it on GitHub Pages

1. Create a GitHub repository and upload everything in this folder to it (keep
   `index.html` at the top level, and keep the empty `.nojekyll` file).
2. In the repository, open **Settings**, then **Pages**.
3. Under **Build and deployment**, set **Source** to **Deploy from a branch**, pick your
   main branch and the **/ (root)** folder, and save.
4. After a minute or two the site is live at `https://<your-username>.github.io/<repo-name>/`.

Every file uses relative paths, so it also works from any other static host (Netlify,
Cloudflare Pages, itch.io) or a subfolder.

## How multiplayer works without a server

The host's browser runs the room. Every other player connects straight to the host over
WebRTC, using [PeerJS](https://peerjs.com) and its free public broker to find each other.
The room code is how guests find the host.

What that means in practice:

- **The host has to keep the page open.** If the host closes or reloads the tab, the room
  closes for everyone. The page warns the host before they leave. Hosts on a phone should
  keep the game in the foreground.
- **Guests can reload.** A guest who reloads or briefly loses connection rejoins the same
  seat automatically. A guest who leaves mid-game is replaced by a bot.
- **Some networks block direct connections.** Many home and mobile networks are fine, but
  some routers, office, school and hotel networks block peer-to-peer traffic. A TURN relay
  fixes this; see "If players can't join" below.
- **The host could peek.** Each guest only receives their own view, but the host's browser
  holds the whole game, so a host who opens the developer tools could see hidden clues.
  Fine for friends; for strangers you'd want the server version.
- **The public PeerJS broker is a free shared service.** For a game you expect lots of
  people to play, you can run your own PeerJS server and point the `Peer` options in
  `net.js` at it.

## If players can't join

The join screen says which step failed:

- **"Couldn't reach the service the game uses to find rooms"**: the PeerJS broker couldn't
  be reached. Check the internet connection, or try again later in case the free broker is
  having trouble.
- **"There's no open room with that code"**: the code is wrong, or the host's page closed.
- **"Found the room, but couldn't open a connection to the host's browser"**: the most
  common one. The two networks won't allow a direct connection. Add a relay:
  1. Make a free account at https://www.metered.ca/tools/openrelay/ (20 GB a month free).
  2. Create an app and copy its TURN credentials URL. It looks like
     `https://your-app-name.metered.live/api/v1/turn/credentials?apiKey=...`.
  3. Paste it into `turnCredentialsUrl` in `config.js` and push the change.
  The key is visible to anyone who views the page source. That's normal for this kind of
  free relay key, and the worst case is someone using up your monthly allowance.
- **"Connected to the host, but their page didn't answer"**: the host may be on an older
  copy of the site. Have everyone hard-reload the page and make a new room.

For more detail, add `?debug` to the address (for example `index.html?debug`) on both the
host's and the guest's page, open the browser's developer console, and try again. Every
connection step is logged.

## Test it on one computer

Open the site in several tabs of the same browser and add `?net=local` to the address in
each one (for example `index.html?net=local`). Tabs then talk to each other directly inside
the browser, with no internet needed. Each tab is its own player. **Add a bot** in the lobby
also fills seats.

To run locally, any static file server works, for example `python3 -m http.server` in
this folder, then open http://localhost:8000/?net=local.

`node test/simulate.js` plays 200 all-bot games and checks the rules hold (no lost or
doubled cards, nobody ever holds their own clue, every game ends).

## Files

- `index.html`, `style.css`: the page.
- `game.js`: all the rules, the lobby, turns, timers, bots, and `view()`, which builds what
  one player is allowed to see.
- `net.js`: hosting and joining rooms over PeerJS, plus the `?net=local` stand-in.
- `config.js`: optional relay (TURN) settings for players on strict networks.
- `app.js`: the interface.

Game settings (player counts, round limit, clocks, when duplicate cards start) are in
`LIMITS` at the top of `game.js`.

## Rules as built

- Four clues per player: crime, crime scene, motive and witness. In games of 6 or more,
  two clues about each crime get a second copy, so hands start at 6 cards instead of 4.
  Holding either copy counts.
- Nobody can ever hold a clue about their own crime: it isn't dealt to them, they can't
  demand it, a random take never picks it, and an arrest never hands it to them.
- On your turn: take a random clue from a suspect, demand a specific clue (threatening to
  leak a clue about them), or pass.
- A refused demand: the demander can leak a clue they hold about the target onto the
  public record, or back down. A demander with nothing on the target backs down
  automatically, and nobody else can tell the difference.
- A leaked clue counts for everyone. Holding every clue on someone, counting public ones,
  sends them to prison. Half the prisoner's cards (rounded up) go to the arrester and the
  rest go at random to the other suspects still free.
- Clocks: 60 seconds per turn, 30 to answer a demand, 25 to decide on a leak. When time
  runs out you pass, refuse, or back down.
- Last suspect free wins. After 25 rounds, whoever came closest to solving a crime wins.
