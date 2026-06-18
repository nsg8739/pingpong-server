// 웹 탁구 2인 대전용 WebSocket 중계 서버.
//
// 역할: 방(room) 관리 + 두 피어 사이의 메시지 "단순 중계"만 한다.
// 게임 물리는 호스트(방장) 브라우저가 권한을 갖고 계산하며, 서버는 게임 로직을 전혀 모른다.
// 왜 WebSocket인가: 탁구는 실시간 액션이라 폴링(웹도블 방식)으론 지연이 커서 끊겨 보임 → 양방향 푸시 필요.
//
// 의존성:
// - ws: 표준 경량 WebSocket 서버. 대안은 Node 내장 http의 upgrade를 직접 처리하는 것이지만 보일러플레이트가 큼.
// - http(내장): Render 헬스체크 및 무료 티어 콜드스타트 깨우기용 HTTP GET 응답.

import http from "node:http";
import { WebSocketServer } from "ws";

const PORT = process.env.PORT || 8080;

// 방 저장: code -> { host: ws, guest: ws|null, createdAt: number }
// 메모리에만 보관(휘발). 단일 인스턴스 전제 — Render 무료 플랜은 단일 인스턴스이므로 OK.
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

// 방에서 보낸 쪽의 "상대" 피어를 반환
function peerOf(room, ws) {
  return room.host === ws ? room.guest : room.host;
}

const server = http.createServer((req, res) => {
  // Render 헬스체크 + 콜드스타트 깨우기. 모든 경로를 200으로 단순 응답.
  res.writeHead(200, { "Content-Type": "text/plain" });
  res.end("pingpong-server ok");
});

const wss = new WebSocketServer({ server });

wss.on("connection", (ws) => {
  ws.roomCode = null;
  ws.role = null;

  ws.on("message", (data) => {
    let msg;
    try { msg = JSON.parse(data); } catch { return; } // 깨진 메시지는 무시

    // 방 생성 → 방장(host)
    if (msg.type === "create") {
      const code = makeCode();
      rooms.set(code, { host: ws, guest: null, createdAt: Date.now() });
      ws.roomCode = code;
      ws.role = "host";
      send(ws, { type: "created", code, role: "host" });
      return;
    }

    // 방 입장 → 참가자(guest)
    if (msg.type === "join") {
      const code = String(msg.code || "").toUpperCase();
      const room = rooms.get(code);
      if (!room) { send(ws, { type: "error", reason: "no-room", message: "방을 찾을 수 없습니다." }); return; }
      if (room.guest) { send(ws, { type: "error", reason: "full", message: "이미 두 명이 입장한 방입니다." }); return; }
      room.guest = ws;
      ws.roomCode = code;
      ws.role = "guest";
      send(ws, { type: "joined", code, role: "guest" });
      // 양쪽에 상대 입장 알림 → 호스트가 게임을 시작할 수 있음
      send(room.host, { type: "peer-joined" });
      send(room.guest, { type: "peer-joined" });
      return;
    }

    // 그 외(state/input/restart 등) 게임 메시지는 상대에게 그대로 중계
    const room = rooms.get(ws.roomCode);
    if (!room) return;
    send(peerOf(room, ws), msg);
  });

  ws.on("close", () => {
    const room = rooms.get(ws.roomCode);
    if (!room) return;
    send(peerOf(room, ws), { type: "peer-left" });
    // 1:1 세션 모델: 누구든 나가면 방을 제거(남은 쪽은 메뉴로 돌아가 새 방을 만들면 됨).
    rooms.delete(ws.roomCode);
  });
});

// 좀비 방 정리: 2시간 지난 방 제거(폴링이 아니라 연결이 끊기면 close로 정리되지만, 안전망).
setInterval(() => {
  const now = Date.now();
  for (const [code, room] of rooms) {
    if (now - room.createdAt > 2 * 60 * 60 * 1000) rooms.delete(code);
  }
}, 10 * 60 * 1000);

server.listen(PORT, () => console.log(`pingpong-server listening on ${PORT}`));
