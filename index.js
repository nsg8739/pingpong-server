// 웹 보드게임 2~4인 대전용 WebSocket 중계 서버.
//
// 역할: 방(room) 관리 + 같은 방 피어들 사이의 메시지 "단순 중계". 게임 로직은 모른다.
//   - 탁구(versus.html): 2인 실시간, 호스트 권한.
//   - 다빈치코드(davinci.html): 2~4인 턴제, 호스트 권한.
//
// 하위 호환:
//   - capacity 미지정 = 2인(기존 탁구).
//   - reconnect 미지정 = 끊기면 방 즉시 종료(기존 동작). reconnect:true면 유예 후 재접속 허용.
//
// 확장:
//   - create: capacity(2~4), reconnect(bool)
//   - 메시지 to(특정 슬롯 지정) — 없으면 방 전체 브로드캐스트, from은 서버가 보낸 이 슬롯으로 스탬프
//   - rejoin{code,index,token}: 새로고침 등으로 끊긴 슬롯에 재접속(유예 시간 내). 게임 상태는 호스트 브라우저가 복원.
//   - 알림: roster, peer-joined, peer-disconnected, peer-reconnected, peer-left, rejoined, rejoin-failed

import http from "node:http";
import { WebSocketServer } from "ws";

const PORT = process.env.PORT || 8080;
const GRACE_MS = 60 * 1000;  // 재접속 유예: 이 시간 안에 안 돌아오면 방 종료

// code -> { slots:[{ws, token, connected, graceTimer}], capacity, createdAt, reconnect }
// slots[0] = 호스트. 슬롯은 끊겨도 유지(재접속용) — reconnect 방에서만.
const rooms = new Map();

const CODE_CHARS = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
function makeCode() {
  let code;
  do { code = Array.from({ length: 4 }, () => CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)]).join(""); }
  while (rooms.has(code));
  return code;
}
function makeToken() { return Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2); }

function send(ws, obj) { if (ws && ws.readyState === ws.OPEN) ws.send(JSON.stringify(obj)); }
function broadcast(room, obj, exceptWs = null) {
  for (const s of room.slots) if (s && s.connected && s.ws && s.ws !== exceptWs) send(s.ws, obj);
}
function rosterCount(room) { return room.slots.filter((s) => s && s.connected).length; }
function endRoom(code) {
  const room = rooms.get(code);
  if (!room) return;
  broadcast(room, { type: "peer-left" });
  for (const s of room.slots) if (s && s.graceTimer) clearTimeout(s.graceTimer);
  rooms.delete(code);
}

const server = http.createServer((req, res) => {
  res.writeHead(200, { "Content-Type": "text/plain" });
  res.end("pingpong-server ok");
});

const wss = new WebSocketServer({ server });

wss.on("connection", (ws) => {
  ws.roomCode = null;
  ws.slotIndex = null;

  ws.on("message", (data) => {
    let msg;
    try { msg = JSON.parse(data); } catch { return; }

    // 방 생성 → 호스트(슬롯 0)
    if (msg.type === "create") {
      const capacity = Math.min(4, Math.max(2, Number(msg.capacity) || 2));
      const code = makeCode();
      const token = makeToken();
      const room = { slots: [{ ws, token, connected: true, graceTimer: null }], capacity, createdAt: Date.now(), reconnect: !!msg.reconnect };
      rooms.set(code, room);
      ws.roomCode = code; ws.slotIndex = 0;
      send(ws, { type: "created", code, index: 0, capacity, token, role: "host", reconnect: room.reconnect });
      broadcast(room, { type: "roster", count: rosterCount(room), capacity });
      return;
    }

    // 방 입장 → 슬롯 1..capacity-1
    if (msg.type === "join") {
      const code = String(msg.code || "").toUpperCase();
      const room = rooms.get(code);
      if (!room) { send(ws, { type: "error", reason: "no-room", message: "방을 찾을 수 없습니다." }); return; }
      if (room.slots.length >= room.capacity) { send(ws, { type: "error", reason: "full", message: "정원이 가득 찬 방입니다." }); return; }
      const index = room.slots.length;
      const token = makeToken();
      room.slots.push({ ws, token, connected: true, graceTimer: null });
      ws.roomCode = code; ws.slotIndex = index;
      send(ws, { type: "joined", code, index, capacity: room.capacity, token, role: index === 0 ? "host" : "guest", reconnect: room.reconnect });
      broadcast(room, { type: "roster", count: rosterCount(room), capacity: room.capacity });
      if (room.slots.length === room.capacity && rosterCount(room) === room.capacity) {
        broadcast(room, { type: "peer-joined", count: room.capacity, capacity: room.capacity });
      }
      return;
    }

    // 재접속 → 끊긴 슬롯에 새 소켓을 다시 연결(토큰 검증)
    if (msg.type === "rejoin") {
      const code = String(msg.code || "").toUpperCase();
      const room = rooms.get(code);
      const idx = Number(msg.index);
      const slot = room && room.slots[idx];
      if (!room || !slot || slot.token !== msg.token) {
        send(ws, { type: "rejoin-failed", message: "이전 게임에 재접속할 수 없습니다. (방이 종료되었을 수 있어요)" });
        return;
      }
      if (slot.graceTimer) { clearTimeout(slot.graceTimer); slot.graceTimer = null; }
      slot.ws = ws; slot.connected = true;
      ws.roomCode = code; ws.slotIndex = idx;
      send(ws, { type: "rejoined", code, index: idx, capacity: room.capacity, token: slot.token, count: rosterCount(room), reconnect: room.reconnect });
      broadcast(room, { type: "peer-reconnected", index: idx }, ws);
      broadcast(room, { type: "roster", count: rosterCount(room), capacity: room.capacity });
      return;
    }

    // 그 외 게임 메시지 중계
    const room = rooms.get(ws.roomCode);
    if (!room) return;
    if (typeof msg.from !== "number") msg.from = ws.slotIndex;  // 수신 측이 보낸 이 식별
    if (typeof msg.to === "number") {
      const s = room.slots[msg.to];
      if (s && s.connected && s.ws && s.ws !== ws) send(s.ws, msg);
    } else {
      broadcast(room, msg, ws);
    }
  });

  ws.on("close", () => {
    const room = rooms.get(ws.roomCode);
    if (!room) return;
    const slot = room.slots[ws.slotIndex];
    if (!slot || slot.ws !== ws) return;  // 이미 rejoin으로 교체된 낡은 소켓이면 무시
    slot.connected = false; slot.ws = null;
    if (room.reconnect) {
      // 유예: 잠깐 끊긴 것으로 보고 재접속을 기다린다. 안 돌아오면 방 종료.
      broadcast(room, { type: "peer-disconnected", index: ws.slotIndex });
      slot.graceTimer = setTimeout(() => { if (!slot.connected) endRoom(ws.roomCode); }, GRACE_MS);
    } else {
      endRoom(ws.roomCode);  // 기존 동작(탁구): 누구든 나가면 즉시 종료
    }
  });
});

// 좀비 방 정리(안전망)
setInterval(() => {
  const now = Date.now();
  for (const [code, room] of rooms) if (now - room.createdAt > 2 * 60 * 60 * 1000) endRoom(code);
}, 10 * 60 * 1000);

server.listen(PORT, () => console.log(`pingpong-server listening on ${PORT}`));
