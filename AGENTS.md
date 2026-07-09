# AGENTS.md — pingpong-server (중계 서버)

> 이 파일은 OpenAI Codex 등 코딩 에이전트를 위한 프로젝트 가이드입니다.
> 응답·주석·커밋 메시지는 **한국어**로 작성하세요.

## 프로젝트 개요

웹 보드게임용 **WebSocket 중계(relay) 서버** (Node + [`ws`]). 클라이언트 저장소 **`pingpong`**(탁구 `versus.html`, 다빈치코드 `davinci.html`)와 함께 동작합니다.

- **역할**: 방(room) 관리 + 같은 방 피어 간 메시지 **단순 중계**. 
- **게임 로직은 없음** — 물리/추리 계산은 전부 **호스트(방장) 브라우저**가 담당하는 호스트 권한 방식. 서버는 상태를 해석하지 않습니다.

| 파일 | 설명 |
|------|------|
| `index.js` | 서버 전체 (ESM 단일 파일) |
| `package.json` | `type:module`, Node≥20, dep은 `ws`만, `npm start`=`node index.js` |
| `render.yaml` | Render 배포 Blueprint |
| `README.md` | 문서 |

## 로컬 실행

```bash
npm install
PORT=8080 npm start      # PORT 미지정 시 8080
# 상태 확인: http://localhost:8080/  → "pingpong-server ok"
```

클라이언트와 붙여서 테스트: `pingpong/davinci.html?server=ws://localhost:8080`
(클라이언트를 `file://` 로 열면 자동으로 `ws://localhost:8080` 사용)

## 프로토콜 (index.js)

방: `code -> { slots:[{ws, token, connected, graceTimer}], capacity, createdAt, reconnect }` (slots[0]=호스트)

클라이언트 → 서버:
- `create { capacity(2~4), reconnect(bool) }` → `created`
- `join { code }` → `joined` / `error`
- `rejoin { code, index, token }` → `rejoined` / `rejoin-failed` (새로고침 재접속)
- 그 외 게임 메시지: `to`(특정 슬롯 지정) 있으면 그 슬롯에만, 없으면 방 전체 브로드캐스트. `from`은 서버가 발신 슬롯으로 스탬프.

서버 → 클라이언트 알림: `roster`, `peer-joined`, `peer-disconnected`, `peer-reconnected`, `peer-left`

## 불변 규칙 (매우 중요)

- **방 상태를 서버 메모리에 보관** → 반드시 **단일 인스턴스**로만 운영. 멀티 인스턴스/오토스케일 금지(방이 인스턴스별로 갈려 매칭이 깨짐). `render.yaml`의 `plan: free` 전제.
- **하위 호환**을 깨지 말 것:
  - `capacity` 미지정 = **2인**(기존 탁구).
  - `reconnect` 미지정 = 누구든 끊기면 **방 즉시 종료**(기존 탁구 동작). `reconnect:true`면 **60초 유예**(`GRACE_MS`) 후 종료 — 그 안에 `rejoin`으로 복귀 가능(다빈치코드용).
- 무료 Render는 미사용 시 슬립 → 첫 접속에 30~60초 콜드스타트. 재시작되면 메모리 방은 소멸(재접속 불가) — 알려진 한계.

## 배포

- **Render 자동 배포**: `main`에 push하면 `render.yaml`의 `autoDeploy: true`로 자동 재배포.
- 운영 주소: `wss://pingpong-server-hgl2.onrender.com` (클라이언트 `RENDER_URL` 상수와 일치해야 함 — 주소 변경 시 클라이언트도 함께 수정).
- 커밋만으로는 배포되지 않습니다. **push** 필요.

## 컨벤션 / 규칙

- **한국어** 주석·커밋 메시지. 주석은 '무엇'보다 '왜'.
- **시크릿 하드코딩 금지**: 포트 등은 `process.env` 사용(`PORT`). 토큰/키/DB 정보를 코드에 넣지 말 것.
- 새 외부 의존성 추가 시 이유·대안을 한 줄로 명시. 현재 런타임 의존성은 `ws` 하나뿐(가볍게 유지).
- 커밋 메시지 마지막 줄:
  ```
  Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
  ```
  (Codex로 작업 시 해당 도구 표기로 바꿔도 됩니다.)
