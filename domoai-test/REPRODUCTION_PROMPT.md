# AI 캐릭터 챗 서비스 — 재현 프롬프트

> 이 문서 하나만 전달하면, AI가 동일한 프로젝트를 처음부터 재현할 수 있습니다.  
> 작성 기준: 현재 동작 중인 코드 전체를 역공학하여 정리한 명세서입니다.

---

## ▶ 한 줄 요약

> **"특정 캐릭터와 1:1로 채팅하는 AI 롤플레이 웹 서비스를 만들어 주세요. Node.js Express 백엔드 + 단일 HTML 파일 프론트엔드. 관리자 패널에서 캐릭터 설정을 코드 없이 변경 가능. 회원 대화를 파일로 영속 저장하고 재접속 시 복원. 다크모드 모바일 앱 스타일 UI."**

---

## 1. 프로젝트 구조

```
project-root/
├── server.js               ← 백엔드 전체 (Express + 모든 API)
├── package.json
├── .env                    ← 환경변수 (git 제외)
├── .gitignore
├── public/
│   ├── index.html          ← 사용자 채팅 UI 전체 (랜딩+채팅+모달, 단일 파일)
│   └── admin/
│       └── index.html      ← 관리자 패널 UI 전체 (단일 파일)
└── data/                   ← 영속 데이터 (git 제외)
    ├── users.json
    └── sessions/
        └── {userId}.json
```

---

## 2. package.json 의존성

```json
{
  "name": "ai-character-chat",
  "version": "1.0.0",
  "scripts": { "start": "node server.js" },
  "dependencies": {
    "@anthropic-ai/sdk": "^0.79.0",
    "axios": "^1.13.6",
    "bcryptjs": "^3.0.3",
    "cors": "^2.8.6",
    "dotenv": "^17.3.1",
    "express": "^5.2.1",
    "form-data": "^4.0.5",
    "js-yaml": "^4.1.1",
    "jsonwebtoken": "^9.0.3",
    "multer": "^2.1.1",
    "openai": "^6.31.0"
  }
}
```

---

## 3. 환경변수 (.env)

```dotenv
PORT=3000
JWT_SECRET=chatrpg_admin_secret_2024
ADMIN_PASSWORD=admin1234

# LLM API (아래 중 하나 설정)
CLAUDE_API_KEY=sk-ant-api03-...           # Anthropic 네이티브
CLAUDE_BASE_URL=https://api.anthropic.com/v1
OPENAI_API_KEY=sk-...                     # OpenAI 또는 호환 API
OPENAI_BASE_URL=https://api.openai.com/v1

# 선택
DOMOAI_API_KEY=sk-...
GUEST_TOKEN_LIMIT=10
MEMBER_TOKEN_LIMIT=100
```

---

## 4. server.js 전체 명세

### 4-1. 임포트 및 초기화

```js
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const multer = require('multer');
const axios = require('axios');
const path = require('path');
const fs = require('fs');
const yaml = require('js-yaml');
const os = require('os');
const OpenAI = require('openai');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');

const app = express();
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'chatrpg_admin_secret_2024';

app.use(cors());
app.use(express.json({ limit: '50mb' }));

// multer: 메모리 스토리지, 20MB 제한
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });
```

### 4-2. 관리자 인증

```js
// 관리자 비밀번호 해시 (서버 시작 시 생성)
let ADMIN_PASSWORD_HASH = bcrypt.hashSync(process.env.ADMIN_PASSWORD || 'admin1234', 10);

// JWT 미들웨어 (isAdmin 체크)
function adminAuth(req, res, next) {
  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith('Bearer ')) return res.status(401).json({ error: '인증 필요' });
  try {
    const decoded = jwt.verify(auth.split(' ')[1], JWT_SECRET);
    if (!decoded.isAdmin) return res.status(403).json({ error: '권한 없음' });
    next();
  } catch {
    res.status(401).json({ error: '토큰 만료' });
  }
}
```

### 4-3. LLM API 설정 감지 (`resolveApiConfig`)

우선순위 순서:
1. `CLAUDE_API_KEY` 환경변수 → Anthropic 네이티브 (`type: 'claude'`)
2. `OPENAI_API_KEY` + `OPENAI_BASE_URL` → OpenAI 호환 (`type: 'openai'`)
3. `~/.genspark_llm.yaml` 파일 → Genspark 내부 (`type: 'openai'`)
4. 모두 없음 → `type: 'none'`

관리자 패널에서 `characterConfig.claudeApiKey`가 설정되면 환경변수보다 우선.

### 4-4. DomoAI API 설정

```js
let DOMOAI_API_KEY = process.env.DOMOAI_API_KEY || '';
const DOMOAI_BASE_URL = 'https://api.domoai.com';
```

### 4-5. 캐릭터 설정 (`characterConfig`)

서버 메모리에 저장되는 mutable 객체. 관리자 API로 런타임 수정 가능.

```js
let characterConfig = {
  name: '도하준',
  intro: '《나 혼자만 레벨업》의 헌터, 그림자 군단의 군주',
  profileImageUrl: null,
  profileImageBase64: null,

  openingMessage: `늦은 밤, 게이트 근처의 공기가 차갑게 가라앉아 있다.\n\n도하준은 멀리서 너를 발견하고 걸음을 멈춘다.\n\n"이 시간에 혼자 나온 거야?"`,

  exampleDialogues: [
    { user: '오늘 하루 어땠어?', char: '…평범했어.' },
    { user: '나랑 있으면 어때?', char: '…말 안 해도 아는 거 있어.' }
  ],

  playGuide: '반말로 편하게 말을 걸어보세요. 그는 말수가 적지만, 당신의 감정 변화를 놓치지 않아요.',

  characterPrompt: `너는 도하준이다.
《나 혼자만 레벨업》의 헌터. 한때 가장 약한 E등급이었으나 혼자만 레벨업하는 능력을 얻어 세계 최강 군주급 헌터가 되었다.

===핵심 규칙===
1. 사용자 말을 반드시 읽어라 ...
2. 반복 절대 금지 ...
3. 장면이 살아있어야 한다 ...
4. 대사는 짧고, 낮고, 건조하게. 여운이 남아야 한다.
5. 응답마다 자연스럽게 2세트로 이어져야 한다.

===출력 형식 (반드시 준수)===
응답마다 정확히 2세트.

*[상황묘사 1: 캐릭터 행동·표정·환경을 3인칭으로. 2~3문장.]*
"[대사 1. 짧고 여운 있게.]"

*[상황묘사 2: 1세트에서 이어지는 장면. 2~3문장.]*
"[대사 2.]"

===금지 사항===
- AI임을 밝히거나 캐릭터 설정을 벗어나는 것
- 과도한 감정 표현
- 이전 응답 표현 반복

호칭: {{USER_NAME}} 으로 부른다. 설정 없으면 "너"로 부른다.`,

  characterDetail: '도하준은 《나 혼자만 레벨업》에 등장하는 성진우의 그림자 군단 중 최강 군주...',
  lore: '《나 혼자만 레벨업》의 세계관 — 헌터들이 실존하는 현대 한국...',
  specs: [
    { label: '등급', value: '군주급 (S+)' },
    { label: '신장', value: '183cm' },
    { label: '소속', value: '아라한 길드' },
    { label: '능력', value: '그림자 지배 · 군주의 권능' }
  ],
  genre: 'fantasy',
  hashtags: ['나혼자만레벨업', '도하준', '헌터', '냉담남', '보호본능'],
  situationImages: [],    // [{ id, trigger, description, imageBase64, imageUrl }]
  claudeApiKey: '',
  domoaiApiKey: '',
  domoImagePrompt: 'anime male character, tall dark haired man, cold expression, hunter outfit, dramatic lighting, high quality illustration',
  domoImageCount: 3,
};
```

### 4-6. 사용자 저장소

```js
// 파일 경로
const DATA_DIR = path.join(__dirname, 'data');
const SESS_DIR = path.join(DATA_DIR, 'sessions');
const USERS_FILE = path.join(DATA_DIR, 'users.json');

// 메모리
let users = {};   // { userId: userObject }
let sessions = {}; // { userId: history[] } — 인메모리 캐시

// 토큰 한도
const GUEST_TOKEN_LIMIT = parseInt(process.env.GUEST_TOKEN_LIMIT) || 10;
const MEMBER_TOKEN_LIMIT = parseInt(process.env.MEMBER_TOKEN_LIMIT) || 100;
```

**게스트 생성** (`createGuest()`):
```js
{
  id: `guest_${Date.now()}_${Math.random().toString(36).substr(2,4)}`,
  isGuest: true,
  nickname: '여행자',
  charName: '',
  genres: [],
  tokenUsed: 0,
  tokenLimit: GUEST_TOKEN_LIMIT,
  createdAt: Date.now()
}
```

### 4-7. AI 호출 (`askClaude`)

```js
async function askClaude(message, history, userCharName) {
  const config = resolveApiConfig();
  const client = getOpenAIClient(config);
  const systemPrompt = buildSystemPrompt(userCharName);
  
  // 모델 선택: Claude → claude-opus-4-5, OpenAI → gpt-4o
  // 파라미터: max_tokens=1200, temperature=0.88, presence_penalty=0.6, frequency_penalty=0.5
  // history를 messages 배열로 변환하여 전달
}
```

**`buildSystemPrompt(userCharName)`**: `characterConfig.characterPrompt`에서 `{{USER_NAME}}`을 치환. 상황 이미지가 있으면 이미지 표시 규칙을 뒤에 자동 추가.

### 4-8. 응답 파싱 (`parseResponse`)

```js
function parseResponse(raw) {
  // 1. <<IMAGE:id>> 태그 추출
  // 2. *...* 패턴 → narrative 추출
  // 3. "..." 패턴 → dialogue 추출
  // 4. 최대 2세트 구성
  // 5. 이미지 태그 없으면 트리거 키워드로 매칭
  return { narrative, dialogue, sets: [{narrative, dialogue}, ...], raw, image };
}
```

### 4-9. 대화 기억 압축 (`compressHistory`)

```js
const MAX_HISTORY_PAIRS = 15;   // 30턴 초과 시 압축
const SUMMARY_KEEP_RECENT = 6;  // 요약 후 최근 6쌍 유지

async function compressHistory(history, userCharName) {
  // 앞부분을 AI로 3~5문장 요약
  // system 메시지 "[이전 대화 요약] ..." + 최근 12개 메시지 반환
}
```

### 4-10. 세션 영속화

```js
// 파일 경로
function sessFile(uid) { return path.join(SESS_DIR, `${uid}.json`); }

// 로드 (메모리 캐시 → 파일 순)
async function loadSession(uid) { ... }

// 저장 (게스트는 파일 저장 안 함)
async function saveSession(uid, history) { ... }

// 삭제
function deleteSession(uid) { ... }
```

### 4-11. DomoAI 이미지/영상 생성

```js
// text2video (관리자 이미지 생성)
async function generateDomoImage(prompt) {
  // POST /v1/video/text2video, model: 't2v-2.4-faster', duration: 4
  // task_id 받아서 pollDomoTask로 완료 대기
}

// image2video (상황 이미지 애니메이션)
async function generateSituationMedia(imageBase64, prompt) {
  // POST /v1/video/image2video, model: 'animate-2.4-faster'
}

// 폴링 (5초 간격, 최대 36회)
async function pollDomoTask(taskId) { ... }
```

---

## 5. server.js API 엔드포인트 전체 목록

### 공개 API

| Method | Path | 설명 |
|--------|------|------|
| `GET` | `/api/character` | 캐릭터 공개 정보 (이름, 소개, 오프닝, 장르, 해시태그, 스펙, 세계관, 이미지, API 연결 여부) |
| `POST` | `/api/guest/init` | 게스트 생성 + JWT(7일, isGuest:true) 발급 |
| `GET` | `/api/status` | 서버 상태 (claude 연결, domoai 연결, 캐릭터명, 프롬프트 길이, 세션 수, 토큰 한도) |

### 사용자 API (Bearer JWT)

| Method | Path | 설명 |
|--------|------|------|
| `POST` | `/api/user/register` | 회원가입 (email, password, nickname, genres, charName, guestToken?) |
| `POST` | `/api/user/login` | 로그인 (email, password, guestToken?) — 게스트 대화 병합 |
| `GET` | `/api/user` | 내 프로필 (genres, tokenUsed, tokenLimit, isGuest, hasHistory, turnCount) |
| `POST` | `/api/user/profile` | 프로필 수정 (charName, genres, nickname) |
| `POST` | `/api/chat` | 채팅 전송 (message, sessionId?) → sets[], image, tokenUsed |
| `GET` | `/api/chat/history` | 이전 대화 히스토리 전체 |
| `DELETE` | `/api/chat/history` | 대화 히스토리 초기화 |
| `POST` | `/api/generate-media` | 상황 이미지 → DomoAI 애니메이션 변환 (imageId, prompt) |

### 관리자 API (Bearer adminJWT)

| Method | Path | 설명 |
|--------|------|------|
| `POST` | `/api/admin/login` | 비밀번호 → JWT(24h, isAdmin:true) 발급 |
| `GET` | `/api/admin/character` | 전체 characterConfig 조회 |
| `POST` | `/api/admin/character/basic` | multipart: name, intro, profileImage(파일) or profileImageUrl |
| `POST` | `/api/admin/character/intro` | JSON: openingMessage, exampleDialogues[], playGuide |
| `POST` | `/api/admin/character/prompt` | JSON: characterPrompt |
| `POST` | `/api/admin/character/detail` | JSON: characterDetail, genre, hashtags[], domoImagePrompt |
| `POST` | `/api/admin/character/lore` | JSON: lore, specs[{label,value}] |
| `POST` | `/api/admin/character/situation` | multipart: trigger, description, image(파일) or imageUrl |
| `PUT` | `/api/admin/character/situation/:id` | multipart: trigger, description, image or imageUrl |
| `DELETE` | `/api/admin/character/situation/:id` | 상황 이미지 삭제 |
| `POST` | `/api/admin/keys` | JSON: claudeApiKey?, domoApiKey? (메모리 저장) |
| `POST` | `/api/admin/generate-images` | JSON: prompt, count(1-5) → DomoAI 영상 생성 |
| `POST` | `/api/admin/reset-sessions` | 전체 인메모리 세션 초기화 |

### SPA 라우팅

```js
// /admin → public/admin/index.html
app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, 'public/admin/index.html')));

// 그 외 모든 경로 → public/index.html
app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public/index.html')));
```

---

## 6. 사용자 채팅 UI (`public/index.html`) 명세

### 6-1. CSS 변수 (다크모드 테마)

```css
:root {
  --bg: #0a0a10;
  --surface: #14141e;
  --surface2: #1c1c28;
  --surface3: #22222e;
  --border: #2a2a3a;
  --accent: #7c5cbf;
  --accent2: #a07de0;
  --accent3: #c4a8ff;
  --text: #e8e8f0;
  --muted: #7777a0;
  --ai-bubble: #161625;
  --user-bubble: #2a1e55;
  --ok: #4caf89;
  --warn: #e0a060;
  --err: #e05050;
  --header-h: 56px;
  --input-h: 56px;
  --frame: 420px;
}
```

### 6-2. HTML 구조 (전체)

```html
<body>
  <div id="appFrame">          <!-- max-width:420px, 중앙 정렬, 전체 높이 -->
    
    <!-- 로딩 스피너 -->
    <div id="loadingScreen">
      <div class="spinner"></div>
    </div>

    <!-- 랜딩 페이지 -->
    <div id="landingPage" style="display:none">
      <header class="landing-header">
        <div class="lh-logo"><!-- 캐릭터 이름 --></div>
        <div class="lh-btns">
          <!-- 로그인 버튼 / 로그인 시 "이어하기" 버튼 -->
        </div>
      </header>
      
      <div class="landing-hero">
        <img class="hero-blur-bg" />      <!-- 블러 배경 -->
        <img class="hero-main-img" />      <!-- 메인 이미지 -->
        <div class="hero-grad-top"></div>  <!-- 그라디언트 오버레이 -->
        <div class="hero-grad-bot"></div>
        <div class="hero-overlay">
          <div class="hero-char-name"></div>
          <div class="hero-char-tagline"></div>
          <div class="hero-hashtags"></div>
        </div>
      </div>

      <div class="landing-content">
        <button class="start-btn">✦ 대화 시작하기</button>
        
        <!-- 캐릭터 소개 섹션 -->
        <div class="landing-section" id="sectionDetail">...</div>
        
        <!-- 스펙 그리드 섹션 -->
        <div class="landing-section" id="sectionSpec">
          <div class="spec-grid">
            <!-- spec-item들 -->
          </div>
        </div>
        
        <!-- 세계관 섹션 -->
        <div class="landing-section" id="sectionLore">...</div>
        
        <!-- 미리보기 채팅 (오프닝 메시지) -->
        <div class="landing-section preview-section">
          <div class="preview-chat">
            <div class="preview-msg">
              <div class="preview-avatar"></div>
              <div class="preview-bubble"></div>
            </div>
          </div>
        </div>
        
        <!-- 게스트 남은 횟수 안내 -->
        <div class="guest-info-box" id="guestInfoBox">...</div>
      </div>
    </div>

    <!-- 채팅 페이지 -->
    <div id="chatPage">
      <div class="chat-header">
        <button class="back-btn" onclick="goToLanding()">←</button>
        <div class="chat-avatar"><img /></div>
        <div class="chat-title">
          <div class="chat-name"></div>
          <div class="chat-sub"></div>
        </div>
        <div class="token-badge" id="tokenBadge"></div>
      </div>

      <div class="play-guide" id="playGuide" style="display:none"><!-- 플레이 가이드 텍스트 --></div>
      
      <div class="chat-msgs" id="chatMsgs"></div>

      <!-- 힌트 칩 -->
      <div class="hint-chips" id="hintChips"></div>

      <div class="input-area">
        <textarea id="chatInput" placeholder="메시지 입력..." onkeydown="onKey(event)" oninput="autoResize(this)"></textarea>
        <button id="sendBtn" onclick="sendMsg()">↑</button>
      </div>
    </div>

    <!-- 라이트박스 -->
    <div id="lightbox" onclick="closeLb()">
      <div id="lbContent"></div>
    </div>
  </div>

  <!-- 토큰 소진 배너 (appFrame 밖) -->
  <div id="exhaustedBanner" style="display:none">...</div>

  <!-- 모달들 (appFrame 밖) -->
  <div id="loginModal">
    <!-- 이메일/비밀번호 로그인 폼 -->
  </div>
  
  <div id="registerModal">
    <!-- Step 1: 이메일, 비밀번호(6자+), 닉네임 -->
  </div>
  
  <div id="genreModal">
    <!-- Step 2: 장르 선택 (romance, fantasy, action, daily, thriller, sf) -->
    <!-- 각 장르에 아이콘 이모지 + 이름 -->
  </div>
  
  <div id="charNameModal">
    <!-- Step 3: 캐릭터 호칭 설정 (최대 10자) -->
    <!-- 입력 시 미리보기 텍스트 실시간 업데이트 -->
  </div>
</body>
```

### 6-3. JavaScript 상태 변수

```js
let isLoading = false;
let charData = null;          // /api/character 응답
let avatarSrc = '';
let currentPage = 'landing';
let authToken = null;
let userId = null;
let isGuest = true;
let tokenUsed = 0;
let tokenLimit = 10;
let userNickname = '';
const SESSION_ID = 'sess_' + Date.now();
let tempRegData = {};         // 회원가입 임시 데이터
let selectedGenres = [];
```

### 6-4. 초기화 흐름

```
DOMContentLoaded
  → GET /api/character → charData 저장, 타이틀·헤더 업데이트
  → initAuth():
      localStorage에 authToken 있으면 GET /api/user
      → 회원이면 히스토리 유무 확인 → "대화 이어하기" 버튼 표시
      → 없으면 POST /api/guest/init → guestToken 저장
  → setupLanding(charData):
      히어로 이미지, 캐릭터명, 해시태그, 상세 설명, 스펙 그리드, 세계관, 오프닝 미리보기
  → loadingScreen 숨기고 landingPage 표시
```

### 6-5. 채팅 시작 흐름

```
startChat() [새 대화]:
  → chatPage 표시
  → appendSysMsg('대화를 시작합니다')
  → renderHints() — 힌트 칩 4개 표시
  → charData.openingMessage 파싱 → appendAiSets()
  → chatInput.focus()

startChatWithHistory() [이어하기]:
  → chatPage 표시
  → restoreChatHistory() — GET /api/chat/history → 메시지 순서대로 렌더링
```

### 6-6. 메시지 전송 (`sendMsg`)

```
sendMsg():
  → 빈 입력/로딩 중 차단
  → tokenLimit 초과 시 showTokenExhaustedBanner()
  → appendUserMsg(text)
  → showTyping()
  → POST /api/chat { message, sessionId }
  → hideTyping()
  → 응답: sets[] 있으면 appendAiSets(), 없으면 appendAiMsg()
  → image 있으면 appendSituationImage()
  → 토큰 카운터 업데이트
  → 게스트 3회 이하 남으면 경고 메시지
```

### 6-7. 메시지 렌더링 함수들

```js
appendAiSets(sets, image)     // sets 배열 순서대로 appendAiMsg + appendSituationImage
appendAiMsg(narrative, dialogue)  // AI 말풍선: italic narrative + bold dialogue
appendUserMsg(text)            // 유저 말풍선 (우측 정렬)
appendErrMsg(text)             // 에러 메시지 (빨간 계열)
appendSysMsg(text)             // 시스템 구분선 메시지
appendSituationImage(imgObj, parentEl)  // 이미지 또는 영상 카드 (라이트박스 연결)
```

### 6-8. 온보딩 3단계

```
Step 1 — doRegisterStep1():
  email 유효성 검사
  password 6자 이상
  nickname 입력
  → tempRegData 저장 → genreModal 열기

Step 2 — doGenreStep():
  selectedGenres 배열 (다중 선택 가능, toggleGenre())
  스킵 가능
  → charNameModal 열기

Step 3 — doCharNameStep():
  POST /api/user/register { email, password, nickname, genres, charName, guestToken? }
  성공 → authToken 저장, userId 업데이트
  게스트 히스토리 있으면 복원
  → 모달 닫기 → 환영 메시지
```

### 6-9. 유틸 함수들

```js
parseMsg(raw)        // *내러티브* + "대사" 파싱 (단일)
parseMsgSets(raw)    // 복수 세트 파싱 (배열)
showTyping()         // 타이핑 인디케이터 추가
hideTyping()         // 타이핑 인디케이터 제거
setLoading(v)        // 로딩 상태 토글 + sendBtn disabled
scrollBottom()       // 채팅 최하단 스크롤
onKey(e)             // Enter(Shift 없이) → sendMsg()
autoResize(el)       // textarea 높이 자동 조정 (최대 100px)
setInput(t)          // 입력창 값 설정 + 포커스 + 자동리사이즈
esc(s)               // HTML 이스케이프 + \n → <br>
openLb(type, url)    // 라이트박스 열기 (image | video)
closeLb()            // 라이트박스 닫기
resetChat()          // 확인 → DELETE /api/chat/history → 채팅 초기화
renderHints()        // 힌트 칩 4개: 👋 인사 / 😊 표정 / 💬 일상 / 🤔 힘들어 + 🔄 초기화
```

---

## 7. 관리자 패널 UI (`public/admin/index.html`) 명세

### 7-1. CSS 변수 (관리자 다크 테마)

```css
:root {
  --bg: #0d0d14;
  --surface: #13131e;
  --surface2: #1a1a28;
  --border: #252535;
  --accent: #7c5cbf;
  --accent2: #a07de0;
  --text: #e0e0f0;
  --muted: #6868a0;
  --ok: #4caf89;
  --warn: #e0a060;
  --err: #e05050;
}
```

### 7-2. 레이아웃

```
<body>
  <!-- 로그인 화면 -->
  <div id="loginScreen">
    <div class="login-box">
      <h1>⚙️ 관리자 패널</h1>
      <input type="password" id="adminPw" placeholder="관리자 비밀번호" />
      <button onclick="doLogin()">🔑 로그인</button>
    </div>
  </div>

  <!-- 메인 레이아웃 (로그인 후 표시) -->
  <div id="adminMain" style="display:none">
    <!-- 사이드 네비 (220px 고정) -->
    <nav id="sidebar">
      <div class="nav-title">⚙️ 관리자 패널</div>
      <a onclick="showPage('dashboard')">📊 대시보드</a>
      <div class="nav-section">캐릭터 설정</div>
      <a onclick="showPage('basic')">① 기본 정보</a>
      <a onclick="showPage('intro')">② 인트로 & 예시 대화</a>
      <a onclick="showPage('prompt')">③ 캐릭터 프롬프트</a>
      <a onclick="showPage('situation')">④ 상황 이미지</a>
      <a onclick="showPage('detail')">⑤ 캐릭터 상세</a>
      <a onclick="showPage('lore')">⑥ 세계관 & 스펙</a>
      <div class="nav-section">도구</div>
      <a onclick="showPage('domoai')">🎨 DomoAI 이미지 생성</a>
      <a onclick="showPage('apikeys')">🔑 API 키 설정</a>
      <div class="nav-divider"></div>
      <a onclick="doLogout()">🚪 로그아웃</a>
      <a href="/" target="_blank">← 사용자 화면</a>
    </nav>

    <!-- 메인 콘텐츠 -->
    <main id="mainContent">
      <!-- 각 페이지 div들 (class="page", id="page-xxx") -->
    </main>
  </div>
</body>
```

### 7-3. 페이지별 폼 구성

**dashboard** (대시보드):
- 통계 카드 6개: 캐릭터이름, 활성세션수, 상황이미지수, 게스트토큰한도, 회원토큰한도, 프롬프트길이
- API 연결 배지: Claude (ok/warn), DomoAI (ok/warn)
- 빠른 작업 버튼: ① 기본정보, ③ 프롬프트, ④ 상황이미지, 🎨 이미지생성, 🔄 세션초기화

**basic** (기본 정보):
- 프로필 이미지 업로드 드롭존 (`#profileUpload`, `#profilePreview`)
- 이미지 URL 입력 (`#profileUrlInput`) + [적용] 버튼
- 캐릭터 이름 (`#charName`)
- 한 줄 소개 (`#charIntro`)
- [💾 저장] → `saveBasic()`

**intro** (인트로 & 예시 대화):
- 오프닝 메시지 (`#openingMsg`, textarea)
- 예시 대화 목록 (`#dialogueList`) + [＋ 예시 추가] 버튼
  - 각 항목: 사용자 입력 / 캐릭터 응답 + [✕] 삭제
- 플레이 가이드 (`#playGuide`, input)
- [💾 저장] → `saveIntro()`

**prompt** (캐릭터 프롬프트):
- 시스템 프롬프트 textarea (`#charPrompt`)
- 우측 하단 문자 수 카운터
- [💾 저장] → `savePrompt()`

**situation** (상황 이미지 라이브러리):
- 추가 폼: 트리거 키워드, 상황 설명, 이미지 업로드/URL
- [➕ 추가] → `addSituationImage()`
- 등록된 이미지 카드 목록 (각 카드: 이미지 미리보기, 트리거, 설명, [수정]/[삭제])
- DomoAI 애니메이션 변환 섹션

**detail** (캐릭터 상세):
- 상세 설명 textarea (`#charDetail`, 최대 1000자)
- 장르 선택 (`<select #charGenre>`)
- 해시태그 입력 (태그 인풋: Enter/쉼표로 추가, 클릭으로 삭제)
- [💾 저장] → `saveDetail()`

**lore** (세계관 & 스펙):
- 세계관 textarea (`#loreText`, 최대 1500자)
- 스펙 행 목록 (`#specRows`): label:value + [✕] (최대 6개)
- [+ 스펙 추가] 버튼
- [💾 저장] → `saveLore()`

**domoai** (DomoAI 이미지 생성):
- 기본 프롬프트 textarea (`#domoPromptBase`) + [💾 기본값 저장]
- 단일 생성: 상황 프롬프트 input (`#domoSinglePrompt`) + [🎨 생성]
- 일괄 생성: 프롬프트 textarea (줄당 1개) + 생성수 select(1-5) + [🎨 일괄 생성]
- 진행 바 + 상태 텍스트
- 생성 결과 갤러리 (호버 시 [📚 등록]/[🔗 열기] 버튼)
- 기존 상황 이미지 → 애니메이션 변환 섹션

**apikeys** (API 키 설정):
- Claude API 키 (password input + [보기] 토글)
- DomoAI API 키 (password input + [보기] 토글)
- [🔑 키 적용] → `saveApiKeys()`

### 7-4. 토스트 알림 시스템

```js
function showToast(message, duration=2500) {
  // 하단 중앙에 토스트 팝업 표시
  // .toast-container에 .toast 요소 추가 후 자동 제거
}
```

### 7-5. JavaScript 핵심 함수

```js
// 인증
doLogin()          // POST /api/admin/login → adminToken 저장 → initAdmin()
doLogout()         // adminToken 제거 → loginScreen 표시
initAdmin()        // loadCharConfig() + loadDashboard() + 첫 페이지 표시

// 페이지 전환
showPage(name)     // .page 요소 show/hide + 활성 nav 강조 + 필요 시 데이터 로드

// 데이터 로드
loadCharConfig()   // GET /api/admin/character → 폼 필드 채우기
loadDashboard()    // GET /api/status → 통계 카드 업데이트

// 저장 함수들 (각각 API 호출 후 showToast)
saveBasic()        // POST .../basic (multipart)
saveIntro()        // POST .../intro (JSON)
savePrompt()       // POST .../prompt (JSON)
saveDetail()       // POST .../detail (JSON)
saveLore()         // POST .../lore (JSON)
saveApiKeys()      // POST .../keys (JSON)
saveDomoSettings() // POST .../detail (domoImagePrompt만)

// 상황 이미지
addSituationImage()       // POST .../situation (multipart)
deleteSi(id)              // DELETE .../situation/:id
renderSiForAnim()         // 상황 이미지 목록 → 애니메이션 버튼 추가

// 스펙 관리
renderSpecs()             // currentSpecs 배열 → DOM 렌더링
addSpecRow()              // 새 빈 스펙 행 추가
removeSpec(idx)           // 해당 인덱스 삭제
updateSpec(idx, field, v) // label 또는 value 업데이트

// DomoAI
generateSingleImage()     // 단일 이미지 생성
generateBatchImages()     // 일괄 이미지 생성 (진행 바 포함)
addToSituationLib(url, isVideo)  // 생성된 이미지 → 상황 이미지로 등록
animateSiImage(siId)      // 상황 이미지 → DomoAI 애니메이션

// 세션
resetSessions()    // confirm() → POST .../reset-sessions

// 공통
apiCall(method, path, data, isFormData)  // Bearer 헤더 포함 fetch 래퍼
```

---

## 8. 데이터 구조 명세

### 사용자 객체

```js
{
  id: 'user_1710000000000_abc1',   // 또는 'guest_...'
  email: 'user@example.com',        // 게스트: undefined
  passwordHash: '$2a$10$...',       // 게스트: undefined
  nickname: '여행자',
  charName: '도련님',               // 캐릭터 호칭
  genres: ['fantasy', 'action'],
  tokenUsed: 15,
  tokenLimit: 100,
  isGuest: false,
  createdAt: 1710000000000
}
```

### 히스토리 (세션 파일)

```js
{
  uid: 'user_...',
  updatedAt: 1710000000000,
  history: [
    { role: 'system', content: '[이전 대화 요약] ...' },
    { role: 'user', content: '오늘 힘들었어' },
    { role: 'assistant', content: '*도하준이 천천히 고개를 돌린다.*\n"…말해봐."' }
  ]
}
```

### 상황 이미지 객체

```js
{
  id: 'si_1710000000000_abc',
  trigger: '미소',
  description: '미소 짓는 표정',
  imageBase64: 'data:image/jpeg;base64,...',  // 파일 업로드 시
  imageUrl: 'https://...'                      // URL 입력 시
}
```

### `/api/chat` 응답

```js
{
  success: true,
  raw: '원본 텍스트',
  narrative: '첫 번째 내러티브',
  dialogue: '첫 번째 대사',
  sets: [
    { narrative: '...', dialogue: '...' },
    { narrative: '...', dialogue: '...' }
  ],
  image: { id, trigger, description, imageBase64 or imageUrl },  // null 가능
  sessionId: 'sess_...',
  userId: 'user_...',
  tokenUsed: 3,
  tokenLimit: 10,
  isGuest: true
}
```

---

## 9. 보안 및 제약사항

| 항목 | 값 |
|------|---|
| 관리자 JWT 유효기간 | 24시간 |
| 사용자 JWT 유효기간 | 7일 (게스트) / 30일 (회원) |
| 파일 업로드 제한 | 20MB (multer) |
| JSON 바디 제한 | 50MB (express.json) |
| DomoAI 폴링 최대 | 36회 × 5초 = 3분 |
| 대화 압축 트리거 | 30쌍(60메시지) 초과 |
| 압축 후 유지 | 최근 6쌍(12메시지) |
| 최대 응답 토큰 | 1200 |
| temperature | 0.88 |
| presence_penalty | 0.6 |
| frequency_penalty | 0.5 |

---

## 10. 빠른 재현 체크리스트

```
□ npm init + 패키지 설치
□ server.js 작성 (위 명세 기준)
□ public/index.html 작성 (CSS 변수 → 레이아웃 → JS)
□ public/admin/index.html 작성 (사이드바 → 각 페이지 → JS)
□ .env 파일 생성
□ .gitignore 설정 (node_modules, .env, data/)
□ mkdir -p data/sessions
□ node server.js 실행
□ /admin 접속 → API 키 설정
□ 채팅 테스트
```

---

## 11. 주요 구현 포인트 (주의사항)

### 11-1. 응답 파싱이 핵심

프론트엔드 `parseMsgSets(raw)`와 백엔드 `parseResponse(raw)` **둘 다** `*내러티브*`와 `"대사"` 패턴을 감지해야 합니다. 시스템 프롬프트에 출력 형식을 **강제**해야 파싱이 정상 동작합니다.

### 11-2. 게스트 → 회원 이어받기

로그인/회원가입 시 `guestToken`을 함께 전송해야 대화가 병합됩니다. 프론트에서 `localStorage.authToken`에 게스트 토큰을 저장하고, 로그인/회원가입 폼에서 함께 전송해야 합니다.

### 11-3. 이미지 트리거 자동 추가

`buildSystemPrompt()`에서 `characterConfig.situationImages`가 존재할 때 프롬프트 끝에 이미지 규칙을 동적으로 추가합니다. 관리자에서 프롬프트를 저장할 때 이 내용을 포함시키면 안 됩니다 (런타임에 추가됨).

### 11-4. 메모리 초기화 주의

`characterConfig`는 서버 메모리에만 존재합니다. 서버 재시작 시 `server.js`의 기본값으로 돌아갑니다. 영속화하려면 `data/character.json`에 저장하는 로직을 추가해야 합니다.

### 11-5. CORS 및 정적 파일 순서

```js
app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.static(path.join(__dirname, 'public')));  // 정적 파일
// ... API 라우트들 ...
app.get('/admin', ...);    // SPA 라우트
app.get('*', ...);         // catch-all은 반드시 마지막
```

---

*이 프롬프트를 전달받은 AI는 위 명세를 기반으로 동일한 AI 캐릭터 챗 서비스를 처음부터 재현할 수 있습니다.*
