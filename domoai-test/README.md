# AI 캐릭터 챗 서비스

> **관리자만 설정을 바꾸면 누구나 원하는 캐릭터로 서비스를 운영할 수 있는** Node.js 기반 AI 롤플레이 채팅 서비스입니다.

---

## 목차

1. [서비스 개요](#1-서비스-개요)
2. [기술 스택](#2-기술-스택)
3. [디렉터리 구조](#3-디렉터리-구조)
4. [설치 및 실행](#4-설치-및-실행)
5. [환경변수 설정](#5-환경변수-설정)
6. [관리자 패널 사용법](#6-관리자-패널-사용법)
7. [캐릭터 데이터 저장 구조](#7-캐릭터-데이터-저장-구조)
8. [사용자 플로우](#8-사용자-플로우)
9. [API 레퍼런스](#9-api-레퍼런스)
10. [대화 기억 시스템](#10-대화-기억-시스템)
11. [DomoAI 이미지 생성](#11-domoai-이미지-생성)
12. [배포](#12-배포)

---

## 1. 서비스 개요

특정 AI 캐릭터와 1:1로 롤플레이 채팅하는 서비스입니다.

### 핵심 특징

| 기능 | 설명 |
|------|------|
| **캐릭터 완전 변수화** | 코드 수정 없이 관리자 패널에서 캐릭터 전체를 교체할 수 있습니다 |
| **설정 영속 저장** | `data/character.json`에 저장되어 서버 재시작 후에도 설정이 유지됩니다 |
| **모바일 앱 UI** | max-width 420px 다크모드 레이아웃, 네이티브 앱처럼 보이는 디자인 |
| **게스트 / 회원 이중 구조** | 비로그인 무료 체험 → 회원가입 후 계속 이용 |
| **대화 영속 저장** | 회원 대화는 파일로 저장, 재접속 후 이전 대화 복원 |
| **장기 기억 요약** | 30턴 초과 시 AI가 앞부분을 자동 요약·압축 |
| **상황 이미지 트리거** | 특정 키워드 감지 시 연동 이미지 자동 표시 |
| **DomoAI 영상 생성** | 관리자가 캐릭터 영상을 직접 생성 |

---

## 2. 기술 스택

### 백엔드
- **Node.js** v18 이상 + **Express v5**
- **@anthropic-ai/sdk** — Claude 네이티브 호출
- **openai** — GPT-4o 및 OpenAI 호환 API
- **jsonwebtoken** + **bcryptjs** — 인증
- **multer** — 이미지 업로드 (메모리 스토리지, 최대 20MB)
- **axios** — DomoAI API 호출
- **dotenv** / **js-yaml** — 설정 관리

### 프론트엔드
- **Vanilla HTML / CSS / JS** (프레임워크 없음, 단일 파일)
- **Fetch API** 기반 서버 통신
- **localStorage** 토큰·사용자 정보 캐시

### 데이터 저장
- **파일 시스템** (`data/` 폴더) — 별도 DB 없음

---

## 3. 디렉터리 구조

```
domoai-test/
├── server.js                   # 백엔드 진입점 (전체 1,000줄)
├── package.json
├── .env                        # 환경변수 (git 제외)
├── .env.example                # 환경변수 예시
├── .gitignore
│
├── public/
│   ├── index.html              # 사용자 채팅 UI (랜딩 + 채팅)
│   └── admin/
│       └── index.html          # 관리자 패널 UI
│
└── data/                       # 영속 데이터 (git 제외)
    ├── character.json          # ★ 캐릭터 설정 (관리자 패널 저장값)
    ├── users.json              # 회원 계정 정보
    └── sessions/
        └── {userId}.json       # 회원별 대화 히스토리
```

> **`data/character.json`이 핵심입니다.** 관리자 패널에서 저장하면 이 파일에 기록되고, 서버 시작 시 자동으로 불러옵니다.

---

## 4. 설치 및 실행

```bash
# 1. 저장소 클론
git clone https://github.com/ssap-pa/Character-chat.git
cd Character-chat/domoai-test

# 2. 의존성 설치
npm install

# 3. 환경변수 설정
cp .env.example .env
# .env 파일을 열어 API 키 등 입력

# 4. 서버 시작
npm start
```

서버가 시작되면 콘솔에 출력됩니다:

```
🚀 서버: http://localhost:3000
👤 사용자 채팅: http://localhost:3000/
⚙️  관리자 페이지: http://localhost:3000/admin
🔐 관리자 비밀번호: admin1234
🤖 Claude: ✅ openai_compat
🎨 DomoAI: ✅ 연동됨
🎫 게스트 토큰: 10회 / 회원 토큰: 100회
```

---

## 5. 환경변수 설정

`.env.example`을 복사해서 `.env`로 만들고 아래 값을 채웁니다.

```dotenv
# ── 서버 기본 설정 ──────────────────────────────
PORT=3000
JWT_SECRET=랜덤하고_긴_문자열_입력   # openssl rand -hex 32

# ── 관리자 패널 비밀번호 ──────────────────────────
ADMIN_PASSWORD=admin1234             # 반드시 변경하세요

# ── LLM API (둘 중 하나만 설정) ─────────────────

# [방법 A] Anthropic Claude 직접 연결
CLAUDE_API_KEY=sk-ant-api03-...
CLAUDE_BASE_URL=https://api.anthropic.com/v1

# [방법 B] OpenAI 또는 호환 API
OPENAI_API_KEY=sk-...
OPENAI_BASE_URL=https://api.openai.com/v1

# ── DomoAI (선택 — 영상 생성 기능 사용 시) ───────
DOMOAI_API_KEY=sk-...

# ── 토큰 한도 (선택) ──────────────────────────────
GUEST_TOKEN_LIMIT=10      # 비로그인 무료 대화 횟수
MEMBER_TOKEN_LIMIT=100    # 회원 대화 횟수
```

> **참고:** LLM API 키는 관리자 패널(`/admin → API 키 설정`)에서도 런타임 중에 변경할 수 있습니다. `.env`에 설정하면 서버 재시작 후에도 유지되므로 `.env` 방식을 권장합니다.

### LLM API 우선순위

서버 시작 시 아래 순서로 API 설정을 자동 감지합니다.

```
1. CLAUDE_API_KEY 환경변수 → Anthropic 네이티브 (sk-ant-...)
2. OPENAI_API_KEY + OPENAI_BASE_URL → OpenAI 호환
3. ~/.genspark_llm.yaml → Genspark 내부 API
4. 관리자 패널에서 직접 입력한 키
5. 모두 없음 → 채팅 불가
```

---

## 6. 관리자 패널 사용법

**접속:** `http://localhost:3000/admin`  
**기본 비밀번호:** `admin1234` (`.env`의 `ADMIN_PASSWORD`로 변경)

> 저장 버튼을 누르면 즉시 `data/character.json`에 기록되고, 서버 재시작 후에도 유지됩니다.

### 설정 단계 (사이드바 순서대로)

#### ① 기본 정보
| 항목 | 설명 |
|------|------|
| 캐릭터 이름 | 사이트 제목, 헤더, 랜딩 전체에 표시되는 이름 |
| 한 줄 소개 | 채팅 헤더 서브타이틀 |
| 프로필 이미지 | 파일 업로드(최대 20MB) 또는 외부 URL 입력 |

> **이미지 팁:** 파일 업로드는 `character.json`에 base64로 저장됩니다. 외부 URL 입력 방식을 권장합니다.

---

#### ② 인트로 & 예시 대화
| 항목 | 설명 |
|------|------|
| 오프닝 메시지 | 채팅 시작 시 캐릭터의 첫 메시지. `*상황묘사*` + `"대사"` 형식 권장 |
| 예시 대화 | 사용자·캐릭터 대화 예시 쌍 (여러 개 추가 가능) |
| 플레이 가이드 | 채팅 화면 상단에 표시되는 안내 문구 |

---

#### ③ 캐릭터 프롬프트
Claude에게 전달되는 시스템 프롬프트입니다. 캐릭터의 성격·말투·규칙을 정의합니다.

**`{{USER_NAME}}`** 변수를 쓰면 사용자가 설정한 호칭으로 자동 치환됩니다.

**응답 형식은 반드시 포함해야 합니다** (파싱이 이 형식을 기준으로 작동합니다):

```
===출력 형식 (반드시 준수)===
응답마다 정확히 2세트.

*[상황묘사: 캐릭터 행동·표정·환경을 3인칭으로. 2~3문장.]*
"[대사: 짧고 여운 있게.]"

*[상황묘사 2]*
"[대사 2]"
```

**좋은 프롬프트 체크리스트:**
- [ ] 캐릭터 핵심 정체성 (직업, 배경, 관계)
- [ ] 말투 특징 (존댓말/반말, 자주 쓰는 표현)
- [ ] 감정 표현 방식
- [ ] 반복·AI 티 내기 금지 규칙
- [ ] `{{USER_NAME}}` 포함
- [ ] 출력 형식 2세트 명시

---

#### ④ 상황 이미지
AI 응답에 특정 키워드가 포함되면 자동으로 이미지를 표시합니다.

| 항목 | 설명 |
|------|------|
| 트리거 키워드 | AI 응답에 이 단어가 감지되면 이미지 표시 (예: `웃음`, `포옹`) |
| 이미지 | 파일 업로드 또는 URL 입력 |
| 상황 설명 | 관리자 참고용 메모 |

> 상황 이미지를 등록하면 시스템 프롬프트에 `<<IMAGE:id>>` 트리거 규칙이 자동 추가됩니다.

---

#### ⑤ 캐릭터 상세
| 항목 | 설명 | 제한 |
|------|------|------|
| 상세 설명 | 랜딩 페이지 캐릭터 섹션에 표시 | 최대 1,000자 |
| 장르 | romance / fantasy / action / daily / thriller / sf / historical / etc | — |
| 해시태그 | 랜딩 히어로 오버레이에 표시 (Enter 또는 쉼표로 추가) | — |
| DomoAI 이미지 프롬프트 | 영상 생성 시 사용하는 기본 프롬프트 (영문) | — |

---

#### ⑥ 세계관 & 스펙
| 항목 | 설명 | 제한 |
|------|------|------|
| 세계관 설명 | 랜딩 페이지 세계관 섹션에 표시 | 최대 1,500자 |
| 캐릭터 스펙 | 레이블:값 쌍으로 랜딩 스펙 카드에 표시 | 최대 6개 |

---

#### 🎨 DomoAI 이미지 생성
- 기본 프롬프트 + 상황 프롬프트 조합으로 영상 생성
- 단일 생성 / 최대 5개 일괄 생성 지원
- 생성된 영상 URL을 상황 이미지로 바로 등록 가능

---

#### 🔑 API 키 설정
| 항목 | 설명 |
|------|------|
| Claude API 키 | `sk-ant-api03-...` 형식. [console.anthropic.com](https://console.anthropic.com) |
| DomoAI API 키 | `sk-...` 형식. [platform.domoai.com](https://platform.domoai.com/api-keys) |

> ✅ API 키는 `data/character.json`에 저장되어 서버 재시작 후에도 유지됩니다.

---

## 7. 캐릭터 데이터 저장 구조

### `data/character.json` 스키마

```json
{
  "name": "캐릭터 이름",
  "intro": "한 줄 소개",
  "profileImageUrl": "https://...",
  "profileImageBase64": null,
  "openingMessage": "*나레이션*\n\"대사\"",
  "exampleDialogues": [
    { "user": "사용자 예시 대사", "char": "캐릭터 예시 대사" }
  ],
  "playGuide": "플레이 가이드 문구",
  "characterPrompt": "시스템 프롬프트 전문",
  "characterDetail": "랜딩 페이지용 캐릭터 설명",
  "lore": "세계관 설명",
  "specs": [
    { "label": "등급", "value": "S+" },
    { "label": "신장", "value": "183cm" }
  ],
  "genre": "fantasy",
  "hashtags": ["태그1", "태그2"],
  "situationImages": [
    {
      "id": "si_1234567890",
      "trigger": "웃음",
      "description": "미소 짓는 표정",
      "imageUrl": "https://...",
      "imageBase64": null,
      "imagePrompt": ""
    }
  ],
  "claudeApiKey": "sk-ant-...",
  "domoaiApiKey": "sk-...",
  "domoImagePrompt": "anime character, ...",
  "domoImageCount": 3
}
```

### 서버 시작 시 자동 로드

```
서버 시작
  → data/character.json 존재 여부 확인
  → 존재: 설정 로드 → "캐릭터 설정 로드: 이름" 출력
  → 없음: 빈 기본값 사용 → "관리자 패널에서 설정을 입력해 주세요" 출력
```

---

## 8. 사용자 플로우

### 첫 방문 (게스트)
```
접속
  → POST /api/guest/init
  → JWT 발급 (7일 유효, isGuest: true)
  → 랜딩 페이지 → 채팅 시작
  → 게스트 대화 한도: GUEST_TOKEN_LIMIT (기본 10회)
```

### 회원가입 (3단계 온보딩)
```
이메일 / 비밀번호 / 닉네임 입력 (Step 1)
  → 장르 선택 (Step 2)
  → 캐릭터 호칭 설정 (Step 3)
  → guestToken 전달 → 게스트 대화 이어받기
  → JWT 발급 (30일 유효)
```

### 로그인
```
POST /api/user/login (guestToken 포함)
  → 게스트 대화 + 기존 회원 대화 병합
  → 이전 대화 히스토리 복원
```

### 채팅 흐름
```
메시지 입력
  → POST /api/chat
  → loadSession(userId): 파일에서 히스토리 로드
  → Claude / GPT 호출
  → compressHistory(): 30턴 초과 시 자동 요약
  → saveSession(userId): 파일에 저장
  → parseResponse(): *상황묘사* + "대사" 2세트 파싱
  → 클라이언트 렌더링
```

---

## 9. API 레퍼런스

### 공개 API

| Method | Path | 설명 |
|--------|------|------|
| `GET` | `/api/character` | 캐릭터 공개 정보 |
| `POST` | `/api/guest/init` | 게스트 세션 + JWT 발급 |
| `GET` | `/api/status` | 서버·API 연결 상태 |

### 사용자 API (Bearer JWT 필요)

| Method | Path | 설명 |
|--------|------|------|
| `POST` | `/api/user/register` | 회원가입 |
| `POST` | `/api/user/login` | 로그인 |
| `POST` | `/api/user/profile` | 프로필 업데이트 |
| `POST` | `/api/chat` | 채팅 메시지 전송 |
| `GET` | `/api/chat/history` | 대화 히스토리 조회 |
| `DELETE` | `/api/chat/history` | 대화 히스토리 초기화 |

**`POST /api/chat` 응답 예시:**
```json
{
  "success": true,
  "sets": [
    { "narrative": "캐릭터가 창밖을 바라본다.", "dialogue": "…오늘 힘들었어?" },
    { "narrative": "그가 짧게 한숨을 내쉰다.", "dialogue": "말해봐." }
  ],
  "tokenUsed": 3,
  "tokenLimit": 10,
  "isGuest": true
}
```

### 관리자 API (Bearer adminJWT 필요)

| Method | Path | 설명 |
|--------|------|------|
| `POST` | `/api/admin/login` | 관리자 로그인 |
| `GET` | `/api/admin/character` | 전체 캐릭터 설정 조회 |
| `POST` | `/api/admin/character/basic` | 이름·소개·프로필 이미지 |
| `POST` | `/api/admin/character/intro` | 오프닝 메시지·예시 대화·플레이 가이드 |
| `POST` | `/api/admin/character/prompt` | 시스템 프롬프트 |
| `POST` | `/api/admin/character/detail` | 장르·해시태그·DomoAI 프롬프트 |
| `POST` | `/api/admin/character/lore` | 세계관·스펙 |
| `POST` | `/api/admin/character/situation` | 상황 이미지 추가 |
| `PUT` | `/api/admin/character/situation/:id` | 상황 이미지 수정 |
| `DELETE` | `/api/admin/character/situation/:id` | 상황 이미지 삭제 |
| `POST` | `/api/admin/keys` | API 키 저장 |
| `POST` | `/api/admin/generate-images` | DomoAI 영상 생성 |
| `POST` | `/api/admin/reset-sessions` | 전체 세션 초기화 |

---

## 10. 대화 기억 시스템

### 저장 위치

```
data/
  character.json              # 캐릭터 설정 전체
  users.json                  # 회원 계정 (게스트 제외)
  sessions/
    user_xxx.json             # 회원별 대화 히스토리
```

### 장기 기억 압축

대화가 **30턴(60개 메시지)**을 초과하면 자동 압축됩니다.

```
전체 히스토리 (60개 이상)
  ↓ 앞부분을 AI가 3~5문장으로 요약 (max 300 tokens)
system 메시지: "[이전 대화 요약] ..."
  ↓ 최근 12개 메시지 유지
```

압축 상수 (`server.js`에서 조정 가능):
```js
const MAX_HISTORY_PAIRS  = 15;  // 이 쌍 수 초과 시 압축
const SUMMARY_KEEP_RECENT = 6;  // 압축 후 유지할 최근 쌍 수
```

---

## 11. DomoAI 이미지 생성

DomoAI는 **비디오 생성 API**입니다. 텍스트 또는 이미지를 입력해 짧은 애니메이션 클립을 생성합니다.

| 기능 | API 엔드포인트 | 설명 |
|------|--------------|------|
| 텍스트 → 영상 | `POST /v1/video/text2video` | 프롬프트만으로 영상 생성 |
| 이미지 → 영상 | `POST /v1/video/image2video` | 업로드된 상황 이미지에 애니메이션 적용 |

**생성 흐름:**
```
1. 생성 요청 → task_id 반환
2. 5초 간격 폴링 (최대 36회 = 3분)
   → status: PROCESSING ... SUCCESS
3. SUCCESS → video_url 반환
```

---

## 12. 배포

### PM2 사용 (권장)

```bash
npm install -g pm2

pm2 start server.js --name "ai-chat"
pm2 startup    # 서버 재부팅 후 자동 시작 설정
pm2 save

pm2 logs ai-chat      # 로그 확인
pm2 restart ai-chat   # 재시작
```

### 환경변수 목록

| 변수 | 기본값 | 필수 여부 |
|------|--------|-----------|
| `PORT` | 3000 | 선택 |
| `JWT_SECRET` | — | **필수** (안전한 랜덤 문자열) |
| `ADMIN_PASSWORD` | admin1234 | **권장** (반드시 변경) |
| `CLAUDE_API_KEY` | — | LLM 중 하나 필수 |
| `OPENAI_API_KEY` | — | LLM 중 하나 필수 |
| `OPENAI_BASE_URL` | — | OPENAI_API_KEY 사용 시 필요 |
| `DOMOAI_API_KEY` | — | 선택 (영상 생성 기능) |
| `GUEST_TOKEN_LIMIT` | 10 | 선택 |
| `MEMBER_TOKEN_LIMIT` | 100 | 선택 |

### 주의 사항

- **`data/` 폴더 백업 필수**: 서버 재배포 시 `data/` 폴더가 초기화되면 캐릭터 설정·회원 정보·대화 내역이 모두 사라집니다.
- **프로필 이미지**: base64 업로드는 `character.json` 파일 크기를 키웁니다. 외부 URL(S3, CDN 등) 방식을 권장합니다.
- **`.env` 파일**: 절대 git에 커밋하지 마세요. `.gitignore`에 포함되어 있습니다.

---

## 빠른 시작 체크리스트

처음 설치 후 아래 순서로 진행하세요.

- [ ] `npm install`
- [ ] `.env` 파일 생성 및 `JWT_SECRET`, `ADMIN_PASSWORD` 설정
- [ ] `npm start` 로 서버 시작
- [ ] `/admin` 접속 → 비밀번호 입력
- [ ] **① 기본 정보**: 캐릭터 이름·소개·프로필 이미지 → 저장
- [ ] **② 인트로**: 오프닝 메시지·플레이 가이드 → 저장
- [ ] **③ 프롬프트**: 시스템 프롬프트 작성 (`{{USER_NAME}}`, 2세트 형식 포함) → 저장
- [ ] **⑥ 세계관 & 스펙**: 랜딩 페이지용 세계관·스펙 입력 → 저장
- [ ] **🔑 API 키**: Claude 또는 OpenAI 키 입력 → 저장
- [ ] `/` 접속 → 채팅 테스트
