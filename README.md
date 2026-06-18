# 🏓 pingpong-server

웹 탁구 **2인 온라인 대전**용 WebSocket 중계 서버.

- 클라이언트(`versus.html`, 별도 pingpong 저장소)는 이 서버에 접속해 **방 코드**로 매칭한다.
- 서버는 **방 관리 + 메시지 중계**만 한다. 게임 물리는 **호스트(방장) 브라우저**가 계산하는 *호스트 권한 방식*이라 서버는 게임 로직을 모른다.
- 방 상태는 **메모리**에만 보관(휘발) → 반드시 **단일 인스턴스**로 운영(멀티 인스턴스 금지).

## 로컬 실행

```bash
npm install
npm start          # 기본 포트 8080 (PORT 환경변수로 변경 가능)
```

클라이언트는 `versus.html?server=ws://localhost:8080` 으로 접속해 테스트.

## 배포 (Render)

1. 이 폴더를 GitHub 저장소로 push
2. Render 대시보드 → **New + → Blueprint** → 저장소 선택 → **Apply** (`render.yaml` 자동 인식)
3. 배포되면 `wss://<서비스이름>.onrender.com` 주소가 생김 → `versus.html` 상단 `SERVER_URL`에 입력

> 무료 플랜은 미사용 시 슬립 → 첫 접속에 30~60초 콜드스타트 지연 가능.

## 메시지 프로토콜 (참고)

| type | 방향 | 의미 |
|------|------|------|
| `create` | C→S | 방 생성 요청 → `created {code, role:'host'}` |
| `join {code}` | C→S | 방 입장 → `joined {role:'guest'}` 또는 `error` |
| `peer-joined` | S→C | 상대가 들어옴(양쪽에 전송) |
| `peer-left` | S→C | 상대가 나감 |
| `state {...}` | host→guest | 권한자가 보내는 게임 스냅샷(중계) |
| `input {y}` | guest→host | 참가자 패들 위치(중계) |
| `restart` | 양방향 | 재시작 신호(중계) |
