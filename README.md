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
- **Some networks block direct connections.** Most home and mobile networks are fine. Some
  strict office, school or hotel networks block peer-to-peer traffic. If players there
  can't join, add a TURN server in `PEER_OPTIONS` at the top of `net.js` (Metered, Twilio
  and Cloudflare all offer them, some with free tiers).
- **The host could peek.** Each guest only receives their own view, but the host's browser
  holds the whole game, so a host who opens the developer tools could see hidden clues.
  Fine for friends; for strangers you'd want the server version.
- **The public PeerJS broker is a free shared service.** For a game you expect lots of
  people to play, you can run your own PeerJS server and point `PEER_OPTIONS` at it.

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
