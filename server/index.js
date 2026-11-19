'use strict';

const path = require('path');
const http = require('http');
const express = require('express');
const { Server } = require('socket.io');

const PORT = Number(process.env.PORT) || 3000;

const app = express();

// 서버로 실행할 때는 Socket.IO 모드. (GitHub Pages 에서는 public/config.js 가 그대로 쓰여 P2P 모드)
app.get('/config.js', (_req, res) => {
  res.type('application/javascript').send("window.PLAN_CONFIG = Object.assign({}, window.PLAN_CONFIG, { mode: 'server' });\n");
});
app.use(express.static(path.join(__dirname, '..', 'public'), { extensions: ['html'] }));
app.get('/healthz', (_req, res) => res.json({ ok: true }));

const server = http.createServer(app);
const io = new Server(server);

// 게임별 네임스페이스. 새 게임을 추가할 때 여기에 한 줄씩 추가한다.
require('./games/russianRoulette/socket')(io.of('/russian-roulette'));

server.listen(PORT, () => {
  console.log(`Plan Online — http://localhost:${PORT}`);
});
