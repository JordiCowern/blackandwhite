# Leverage

An online social deduction game for 4 to 8 players. Everyone has committed a crime, and
the clues to each crime are scattered among the other players. Copy clues, demand them
with threats, bluff, and once you hold every clue on someone, imprison them. The last
suspect still free wins.

This version is a static site, so it runs on GitHub Pages with no server.

## Put it on GitHub Pages

1. Upload everything in this folder to a GitHub repository (keep `index.html` at the top
   level, and keep the empty `.nojekyll` file).
2. In the repository, open **Settings**, then **Pages**.
3. Under **Build and deployment**, set **Source** to **Deploy from a branch**, pick your
   main branch and the **/ (root)** folder, and save.
4. After a minute or two the site is live at `https://<your-username>.github.io/<repo-name>/`.

After updating files, have everyone hard-reload the page (Ctrl+Shift+R, or Cmd+Shift+R on
a Mac) so their browser doesn't keep old copies.

## How multiplayer works without a server

The host's browser runs the room. Players' browsers exchange messages through a free
public MQTT message service (EMQX's public broker, with HiveMQ's as a fallback) over
ordinary secure WebSockets, the same kind of connection a chat website uses. Nothing needs
a direct connection between players, so networks that block peer-to-peer traffic are fine.

- **Messages are end-to-end encrypted.** Anyone can listen on a public message service, so
  each guest agrees a private key with the host when they join, and every message after
  that is encrypted. Hidden clues never travel in plain text.
- **The host has to keep the page open.** The room lives in the host's browser. If the
  host closes or reloads the tab, the room closes for everyone. The page warns the host
  before they leave. Hosts on a phone should keep the game in the foreground.
- **Guests can reload.** A guest who reloads or briefly drops out rejoins the same seat. A
  guest who leaves mid-game is replaced by a bot.
- **The host could peek.** Each guest only receives their own view, but the host's browser
  holds the whole game, so a host who opens the developer tools could see hidden clues.
- **Public services are best-effort.** If the public brokers are down or slow, you can make
  a free private one (HiveMQ Cloud and EMQX Cloud both have free tiers) and put its secure
  WebSocket address first in `brokers` in `config.js`.

If joining fails, add `?debug` to the address on both the host's and guest's pages, open
the browser console (F12), and try again. Every connection step is logged with `[net]`.

## Test it on one computer

Add `?net=local` to the address (for example `index.html?net=local`) in several tabs of
the same browser. The tabs then talk to each other directly inside the browser, with no
internet needed, and each tab is its own player. **Add a bot** in the lobby also fills
seats. Any static file server works for running it locally, for example
`python3 -m http.server` in this folder, then open http://localhost:8000/?net=local.

`node test/simulate.js` plays 200 all-bot games and checks that the rules hold.

## Files

- `index.html`, `style.css`: the page.
- `game.js`: all the rules, the lobby, turns, timers, bots, and `view()`, which builds what
  one player is allowed to see. Settings are in `LIMITS` at the top.
- `net.js`: hosting and joining rooms through the message service, the encryption, and
  the `?net=local` stand-in.
- `config.js`: which message services to use.
- `app.js`: the interface.

## Rules as built

- Four clues per player: crime, crime scene, motive and witness. In games of 6 or more,
  two clues about each crime get a second copy, so hands start at 6 cards instead of 4.
  Holding any copy of a clue counts.
- Nobody can ever hold a clue about their own crime: it isn't dealt to them, they can't
  demand or copy it, and an arrest never hands it to them.
- On your turn, pick a suspect and either:
  - **copy a random clue** from them: they keep their card and you get a duplicate (only
    clues you don't already have and that aren't public), or
  - **demand a specific clue**, threatening to leak a clue about them. If they hand it
    over, it leaves their hand. If they refuse, you can leak a clue you hold about them
    onto the public record, or back down. With nothing on them you back down
    automatically, and nobody can tell the difference.
  - or pass.
- A leaked clue counts for everyone.
- **Imprisoning is a choice.** Once you hold every clue on a suspect (counting public
  ones), an Imprison button appears above them. Press it at any moment, even on someone
  else's turn. If it interrupts that suspect's turn or a demand involving them, that turn
  ends. Half the prisoner's cards (rounded up) go to you and the rest go at random to the
  other suspects still free. Bots imprison at the start of their own turn, so people get
  a fair chance to act first.
- Clocks: 60 seconds per turn, 30 to answer a demand, 25 to decide on a leak. When time
  runs out you pass, refuse, or back down. Bots wait 3.5 seconds before a move and 2.5
  before answering, so you can follow what they do.
- Last suspect free wins. After 25 rounds, whoever came closest to solving a crime wins.
