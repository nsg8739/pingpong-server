// 웹 보드게임 2~4인 대전용 WebSocket 중계 서버.
//
// 역할: 방(room) 관리 + 같은 방 피어들 사이의 메시지 "단순 중계"만 한다.
// 게임 로직은 전혀 모른다. 게임 물리/규칙은 호스트(방장) 브라우저가 권한을 갖고 계산한다.
//   - 탁구(versus.html): 2인 실시간, 호스트 권한.
//   - 다빈치코드(davinci.html): 2~4인 턴제, 호스트 권한.
//
// 하위 호환: capacity를 지정하지 않으면 2인으로 동작(기존 탁구 대전과 동일).
//   - 예전 프로토콜(create/join/peer-joined + 상대에게 중계)을 그대로 지원한다.
//   - 확장: create에 capacity(2~4), 메시지에 to(특정 플레이어 인덱스 지정) 지원.
//
// 의존성:
// - ws: 표준 경량 WebSocket 서버.
// - http(내장): Render 헬스체크 및 무료 티어 콜드스타트 깨우기용 HTTP GET 응답.

import http from "node:http";
import { WebSocketServer } from "ws";

const PORT = process.env.PORT || 8080;

// 방 저장: code -> { players: ws[], capacity: number, createdAt: number }
// players[0] = 호스트(방장). 메모리에만 보관(휘발). 단일 인스턴스 전제.
const rooms = new Map();

// 4자리 방 코드. 사람이 불러주기 쉽게 혼동되는 글자(0/O, 1/I)는 제외.
const CODE_CHARS = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
function makeCode() {
  let code;
  do {
    code = Array.from({ length: 4 }, () =>
      CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)]
    ).join("");
  } while (rooms.has(code));
  return code;
}

function send(ws, obj) {
  if (ws && ws.readyState === ws.OPEN) ws.send(JSON.stringify(obj));
}

// 방의 모든(또는 보낸 이 제외) 플레이어에게 전송
function broadcast(room, obj, exceptWs = null) {
  for (const p of room.players) if (p && p !== exceptWs) send(p, obj);
}

const server = http.createServer((req, res) => {
  // Render 헬스체크 + 콜드스타트 깨우기. 모든 경로를 200으로 단순 응답.
  res.writeHead(200, { "Content-Type": "text/plain" });
  res.end("pingpong-server ok");
});

const wss = new WebSocketServer({ server });

wss.on("connection", (ws) => {
  ws.roomCode = null;
  ws.playerIndex = null;

  ws.on("message", (data) => {
    let msg;
    try { msg = JSON.parse(data); } catch { return; } // 깨진 메시지는 무시

    // 방 생성 → 방장(index 0). capacity 미지정 시 2인(기존 탁구와 동일).
    if (msg.type === "create") {
      const capacity = Math.min(4, Math.max(2, Number(msg.capacity) || 2));
      const code = makeCode();
      rooms.set(code, { players: [ws], capacity, createdAt: Date.now() });
      ws.roomCode = code;
      ws.playerIndex = 0;
      send(ws, { type: "created", code, index: 0, capacity, role: "host" });
      send(ws, { type: "roster", count: 1, capacity });
      return;
    }

    // 방 입장 → 참가자(index 1..capacity-1)
    if (msg.type === "join") {
      const code = String(msg.code || "").toUpperCase();
      const room = rooms.get(code);
      if (!room) { send(ws, { type: "error", reason: "no-room", message: "방을 찾을 수 없습니다." }); return; }
      if (room.players.length >= room.capacity) {
        send(ws, { type: "error", reason: "full", message: "정원이 가득 찬 방입니다." }); return;
      }
      const index = room.players.length;
      room.players.push(ws);
      ws.roomCode = code;
      ws.playerIndex = index;
      send(ws, { type: "joined", code, index, capacity: room.capacity, role: index === 0 ? "host" : "guest" });

      // 현재 인원 현황을 방 전체에 알림(로비 표시용)
      broadcast(room, { type: "roster", count: room.players.length, capacity: room.capacity });

      // 정원이 차면 시작 신호. (2인일 땐 기존 탁구가 기대하던 peer-joined와 동일 시점)
      if (room.players.length === room.capacity) {
        broadcast(room, { type: "peer-joined", count: room.players.length, capacity: room.capacity });
      }
      return;
    }

    // 그 외 게임 메시지는 중계.
    // - msg.to(숫자)가 있으면 해당 인덱스 플레이어에게만.
    // - 없으면 보낸 이를 제외한 방 전체에게(기존 2인 동작과 동일: 상대 1명).
    const room = rooms.get(ws.roomCode);
    if (!room) return;
    // 수신 측(호스트)이 보낸 이를 식별할 수 있도록 from을 덧붙인다.
    if (typeof msg.from !== "number") msg.from = ws.playerIndex;
    if (typeof msg.to === "number") {
      const target = room.players[msg.to];
      if (target && target !== ws) send(target, msg);
    } else {
      broadcast(room, msg, ws);
    }
  });

  ws.on("close", () => {
    const room = rooms.get(ws.roomCode);
    if (!room) return;
    // 세션 모델: 누구든 나가면 방을 종료(남은 사람들은 메뉴로). 단순·일관.
    broadcast(room, { type: "peer-left" }, ws);
    rooms.delete(ws.roomCode);
  });
});

// 좀비 방 정리: 2시간 지난 방 제거(연결 끊기면 close로 정리되지만 안전망).
setInterval(() => {
  const now = Date.now();
  for (const [code, room] of rooms) {
    if (now - room.createdAt > 2 * 60 * 60 * 1000) rooms.delete(code);
  }
}, 10 * 60 * 1000);

server.listen(PORT, () => console.log(`pingpong-server listening on ${PORT}`));
