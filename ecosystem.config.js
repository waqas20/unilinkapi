module.exports = {
  apps: [{
    name: "consultancy-backend",
    script: "./src/server.js",
    instances: 1,
    exec_mode: "cluster",
    env: {
      NODE_ENV: "production",
      PORT: 3000
    }
  }]
}