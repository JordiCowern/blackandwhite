// Connection settings. You normally don't need to change anything here.
window.LEVERAGE_CONFIG = {
  // Public MQTT message services the game passes messages through, tried in order.
  // Messages are end-to-end encrypted, so the service can't read hidden clues.
  // For a private, more reliable option, make a free HiveMQ Cloud or EMQX Cloud
  // deployment and put its secure WebSocket address first (wss://...:8884/mqtt).
  brokers: [
    'wss://broker.emqx.io:8084/mqtt',
    'wss://broker.hivemq.com:8884/mqtt'
  ]
};
