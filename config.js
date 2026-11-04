// Connection settings. You only need to change this if some players can't join.
window.LEVERAGE_CONFIG = {
  // A TURN relay carries the game's traffic when two players' networks won't allow a
  // direct connection. For a free one, make an account at https://www.metered.ca/tools/openrelay/,
  // create an app, and paste its credentials URL here, for example:
  // turnCredentialsUrl: 'https://your-app-name.metered.live/api/v1/turn/credentials?apiKey=YOUR_API_KEY',
  turnCredentialsUrl: '',

  // Or list relay servers yourself: [{ urls: 'turn:host:3478', username: 'u', credential: 'p' }]
  extraIceServers: []
};
