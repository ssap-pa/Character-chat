require('dotenv').config();
const express    = require('express');
const cors       = require('cors');
const multer     = require('multer');
const axios      = require('axios');
const path       = require('path');
const fs         = require('fs');
const yaml       = require('js-yaml');
const os         = require('os');
const OpenAI     = require('openai');
const jwt        = require('jsonwebtoken');
const bcrypt     = require('bcryptjs');

const app  = express();
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'chatrpg_admin_secret_2024';

app.use(cors());
app.use(express.json({ limit: '50mb' }));

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });

// ── 관리자 계정 (기본: admin / admin1234) ─────────────────
const ADMIN_PASSWORD_HASH = bcrypt.hashSync(process.env.ADMIN_PASSWORD || 'admin1234', 10);

// ── JWT 미들웨어 (관리자) ────────────────────────────────
function requireAdmin(req, res, next) {
  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith('Bearer ')) {
    return res.status(401).json({ error: '관리자 인증이 필요합니다.' });
  }
  try {
    const decoded = jwt.verify(auth.slice(7), JWT_SECRET);
    if (!decoded.isAdmin) throw new Error('권한 없음');
    req.admin = decoded;
    next();
  } catch(e) {
    return res.status(401).json({ error: '유효하지 않은 토큰입니다.' });
  }
}

// ── DomoAI API 설정 ──────────────────────────────────────
let DOMOAI_API_KEY  = process.env.DOMOAI_API_KEY || '';
const DOMOAI_BASE_URL = 'https://api.domoai.com';

// ── LLM API 설정 ─────────────────────────────────────────
function resolveApiConfig() {
  const claudeKey  = process.env.CLAUDE_API_KEY  || '';
  const claudeBase = process.env.CLAUDE_BASE_URL || 'https://api.anthropic.com/v1';
  if (claudeKey && claudeKey.length > 10 && !claudeKey.includes('PLACEHOLDER')) {
    return { apiKey: claudeKey, baseUrl: claudeBase, type: 'anthropic' };
  }
  const envKey  = process.env.OPENAI_API_KEY  || '';
  const envBase = process.env.OPENAI_BASE_URL || '';
  if (envKey && envBase) {
    return { apiKey: envKey, baseUrl: envBase, type: 'openai_compat' };
  }
  try {
    const cfgPath = path.join(os.homedir(), '.genspark_llm.yaml');
    if (fs.existsSync(cfgPath)) {
      const cfg = yaml.load(fs.readFileSync(cfgPath, 'utf8'));
      const yamlKey = cfg?.openai?.api_key || '';
      const resolvedKey = yamlKey.startsWith('${') ? process.env[yamlKey.slice(2, -1)] || '' : yamlKey;
      if (resolvedKey) return { apiKey: resolvedKey, baseUrl: cfg?.openai?.base_url || envBase, type: 'openai_compat' };
    }
  } catch(e) {}
  return { apiKey: '', baseUrl: '', type: 'none' };
}

let apiConfig = resolveApiConfig();

// ── 캐릭터 설정 기본값 (관리자 패널에서 덮어씀) ─────────────
// ⚠️ 이 값들은 data/character.json이 없을 때만 사용됩니다.
// 관리자 패널(/admin)에서 설정을 저장하면 data/character.json에 영속 보관됩니다.
let characterConfig = {
  name: '',
  intro: '',
  profileImageBase64: null,
  profileImageUrl: null,
  openingMessage: '',
  exampleDialogues: [],
  playGuide: '',
  characterPrompt: '',
  situationImages: [],
  characterDetail: '',
  lore: '',
  specs: [],
  genre: 'etc',
  hashtags: [],
  claudeApiKey: '',
  domoaiApiKey: '',
  domoImagePrompt: '',
  domoImageCount: 3,
};

// ── 사용자 저장소 ─────────────────────────────────────
const users = {};           // { userId: { id, email, nickname, charName, genres, tokenUsed, tokenLimit, isGuest, createdAt } }
const guestTokenLimit   = parseInt(process.env.GUEST_TOKEN_LIMIT   || '10');
const memberTokenLimit  = parseInt(process.env.MEMBER_TOKEN_LIMIT  || '100');

function createGuest() {
  const id = 'guest_' + Date.now() + '_' + Math.random().toString(36).slice(2,6);
  users[id] = {
    id, isGuest: true,
    nickname: null,
    charName: null,
    genres: [],
    tokenUsed: 0,
    tokenLimit: guestTokenLimit,
    createdAt: Date.now(),
  };
  return users[id];
}

// ── OpenAI 클라이언트 생성 ─────────────────────────────
function getOpenAIClient() {
  const key = characterConfig.claudeApiKey || apiConfig.apiKey;
  const base = characterConfig.claudeApiKey
    ? (characterConfig.claudeApiKey.startsWith('sk-ant-') ? 'https://api.anthropic.com/v1' : apiConfig.baseUrl)
    : apiConfig.baseUrl;
  if (!key) return null;
  return new OpenAI({ apiKey: key, baseURL: base });
}

// ── 전체 시스템 프롬프트 빌드 ─────────────────────────
function buildSystemPrompt(userCharName) {
  let prompt = characterConfig.characterPrompt;

  // 사용자 호칭 치환
  const callName = userCharName || '';
  prompt = prompt.replace('{{USER_NAME}}', callName || '너');

  // 상황 이미지 트리거 정보 추가
  if (characterConfig.situationImages.length > 0) {
    prompt += '\n\n[이미지 표시 규칙]\n답변에 아래 상황이 해당되면 반드시 응답 맨 끝에 <<IMAGE:상황ID>> 태그를 추가하세요:\n';
    characterConfig.situationImages.forEach(img => {
      prompt += `- 상황 "${img.trigger}": <<IMAGE:${img.id}>>\n`;
    });
  }

  return prompt;
}

// ── Claude 대화 ────────────────────────────────────────
async function askClaude(userMessage, conversationHistory = [], userCharName = '') {
  const client = getOpenAIClient();
  if (!client) throw new Error('API 키가 설정되지 않았습니다. 관리자에게 문의하세요.');

  const messages = [...conversationHistory, { role: 'user', content: userMessage }];
  const systemPrompt = buildSystemPrompt(userCharName);

  const currentKey = characterConfig.claudeApiKey || apiConfig.apiKey;

  // Anthropic 네이티브
  if (currentKey.startsWith('sk-ant-')) {
    try {
      const Anthropic = require('@anthropic-ai/sdk');
      const anth = new Anthropic.default({ apiKey: currentKey });
      const res = await anth.messages.create({
        model: 'claude-opus-4-5',
        max_tokens: 1024,
        system: systemPrompt,
        messages,
      });
      return res.content[0].text;
    } catch(e) {
      if (e.code !== 'MODULE_NOT_FOUND') throw e;
    }
  }

  // OpenAI 호환
  const model = currentKey.startsWith('sk-ant-') ? 'claude-opus-4-5' : 'gpt-4o';
  const res = await client.chat.completions.create({
    model,
    messages: [{ role: 'system', content: systemPrompt }, ...messages],
    max_tokens: 1200,
    temperature: 0.88,
    presence_penalty: 0.6,   // 반복 어구 억제
    frequency_penalty: 0.5,  // 단어 반복 억제
  });
  return res.choices[0].message.content;
}

// ── 응답 파싱 ──────────────────────────────────────────
function parseResponse(raw) {
  // 이미지 태그 추출
  const imageTagMatch = raw.match(/<<IMAGE:([^>]+)>>/);
  const triggeredImageId = imageTagMatch ? imageTagMatch[1].trim() : null;
  const cleanRaw = raw.replace(/<<IMAGE:[^>]+>>/g, '').trim();

  // 2세트 파싱: *상황1* "대사1" *상황2* "대사2" 형식
  // 이탤릭(*...*) 블록들 추출
  const narratives = [];
  const dialogues  = [];

  const narrativeRegex = /\*([^*]+)\*/gs;
  let nm;
  while ((nm = narrativeRegex.exec(cleanRaw)) !== null) {
    narratives.push(nm[1].trim());
  }

  // 대사("...") 추출
  const dialogueRegex = /"([^"]+)"/gs;
  let dm;
  while ((dm = dialogueRegex.exec(cleanRaw)) !== null) {
    dialogues.push(dm[1].trim());
  }

  // 세트 구성: 최대 2세트 (또는 파싱된 수만큼)
  const sets = [];
  const count = Math.max(narratives.length, dialogues.length, 1);
  for (let i = 0; i < count; i++) {
    sets.push({
      narrative: narratives[i] || '',
      dialogue:  dialogues[i]  || '',
    });
  }

  // 하위 호환: 단일 narrative/dialogue
  const narrative = narratives[0] || '';
  const dialogue  = dialogues[0]  || cleanRaw.replace(/\*[^*]+\*/gs, '').replace(/"[^"]+"/gs, '').trim();

  // 상황 이미지 처리
  let situationImage = null;
  if (triggeredImageId) {
    situationImage = characterConfig.situationImages.find(img => img.id === triggeredImageId) || null;
  }
  if (!situationImage && characterConfig.situationImages.length > 0) {
    const combined = cleanRaw;
    for (const img of characterConfig.situationImages) {
      if (img.trigger && combined.includes(img.trigger)) {
        situationImage = img;
        break;
      }
    }
  }

  return { narrative, dialogue, sets, raw: cleanRaw, situationImage };
}

// ── DomoAI 이미지 생성 (text2image 스타일: text2video 첫 프레임) ──
async function generateDomoImage(prompt) {
  const domoKey = characterConfig.domoaiApiKey || DOMOAI_API_KEY;
  if (!domoKey) return null;

  const headers = { 'Authorization': `Bearer ${domoKey}`, 'Content-Type': 'application/json' };

  // DomoAI는 비디오 API이므로 text2video로 생성 후 URL 반환
  const payload = {
    prompt: prompt || characterConfig.domoImagePrompt,
    model: 't2v-2.4-faster',
    seconds: 4,
  };

  try {
    console.log(`[DomoAI] 이미지 생성 요청: "${prompt?.substring(0,60)}"`);
    const res = await axios.post(`${DOMOAI_BASE_URL}/v1/video/text2video`, payload, { headers, timeout: 30000 });
    const taskId = res.data?.task_id || res.data?.data?.task_id;
    if (!taskId) return null;
    console.log(`[DomoAI] task_id: ${taskId}`);
    return await pollDomoTask(taskId, headers);
  } catch(e) {
    console.error('[DomoAI] 요청 오류:', e.response?.data || e.message);
    return null;
  }
}

// ── DomoAI image2video (상황 이미지 애니메이션) ──────────
async function generateSituationMedia(imageBase64, prompt) {
  const domoKey = characterConfig.domoaiApiKey || DOMOAI_API_KEY;
  if (!domoKey) return null;

  const headers = { 'Authorization': `Bearer ${domoKey}`, 'Content-Type': 'application/json' };

  const payload = {
    prompt,
    model: 'animate-2.4-faster',
    seconds: 4,
    image: { bytes_base64_encoded: imageBase64 },
  };

  try {
    console.log(`[DomoAI] image2video 요청: "${prompt?.substring(0,50)}"`);
    const res = await axios.post(`${DOMOAI_BASE_URL}/v1/video/image2video`, payload, { headers, timeout: 30000 });
    const taskId = res.data?.task_id || res.data?.data?.task_id;
    if (!taskId) return null;
    return await pollDomoTask(taskId, headers);
  } catch(e) {
    console.error('[DomoAI] 요청 오류:', e.response?.data || e.message);
    return null;
  }
}

async function pollDomoTask(taskId, headers, maxAttempts = 36, interval = 5000) {
  for (let i = 0; i < maxAttempts; i++) {
    await new Promise(r => setTimeout(r, interval));
    try {
      const res = await axios.get(`${DOMOAI_BASE_URL}/v1/tasks/${taskId}`, { headers, timeout: 10000 });
      const data = res.data?.data || res.data;
      const status = data?.status;
      console.log(`[DomoAI] ${taskId} → ${status} (${data?.process_percent ?? '?'}%)`);

      if (status === 'SUCCESS' || status === 'COMPLETED') {
        const out = data?.output || data?.result || data;
        return out?.video_url || out?.url || (Array.isArray(out) ? out[0]?.url : null);
      }
      if (status === 'FAILED' || status === 'ERROR') throw new Error(`DomoAI 실패: ${JSON.stringify(data)}`);
    } catch(e) {
      if (e.message.startsWith('DomoAI 실패')) throw e;
    }
  }
  return null;
}

// ── 영속 저장소 경로 ────────────────────────────────────
const DATA_DIR     = path.join(__dirname, 'data');
const SESS_DIR     = path.join(DATA_DIR, 'sessions');
const USERS_FILE   = path.join(DATA_DIR, 'users.json');
const CHAR_FILE    = path.join(DATA_DIR, 'character.json');

// 디렉터리 생성
[DATA_DIR, SESS_DIR].forEach(d => { if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true }); });

// ── 캐릭터 설정 영속 저장 ──────────────────────────────────
function loadCharacterConfig() {
  try {
    if (fs.existsSync(CHAR_FILE)) {
      const saved = JSON.parse(fs.readFileSync(CHAR_FILE, 'utf8'));
      Object.assign(characterConfig, saved);
      console.log(`[DB] 캐릭터 설정 로드: "${characterConfig.name || '(이름 없음)'}"`);
    } else {
      console.log('[DB] character.json 없음 — 관리자 패널에서 설정을 입력해 주세요.');
    }
  } catch(e) { console.error('[DB] character.json 로드 오류:', e.message); }
}

function saveCharacterConfig() {
  try {
    // API 키는 별도 필드로 저장 (평문, .env와 중복이지만 편의를 위해 저장)
    fs.writeFileSync(CHAR_FILE, JSON.stringify(characterConfig, null, 2), 'utf8');
    console.log(`[DB] 캐릭터 설정 저장: "${characterConfig.name}"`);
  } catch(e) { console.error('[DB] character.json 저장 오류:', e.message); }
}

// ── 사용자 영속 저장 ─────────────────────────────────────
function loadUsers() {
  try {
    if (fs.existsSync(USERS_FILE)) {
      const raw = JSON.parse(fs.readFileSync(USERS_FILE, 'utf8'));
      Object.assign(users, raw);
      console.log(`[DB] 사용자 ${Object.keys(raw).length}명 로드`);
    }
  } catch(e) { console.error('[DB] users.json 로드 오류:', e.message); }
}

function saveUsers() {
  try {
    // 게스트 제외, 회원만 영속 저장
    const toSave = {};
    for (const [k, v] of Object.entries(users)) {
      if (!v.isGuest) toSave[k] = v;
    }
    fs.writeFileSync(USERS_FILE, JSON.stringify(toSave, null, 2), 'utf8');
  } catch(e) { console.error('[DB] users.json 저장 오류:', e.message); }
}

// ── 세션(대화 히스토리) 영속 저장 ──────────────────────────
const sessions = {}; // 메모리 캐시

function sessFile(uid) { return path.join(SESS_DIR, uid.replace(/[^a-z0-9_-]/gi,'_') + '.json'); }

function loadSession(uid) {
  if (sessions[uid]) return sessions[uid];
  try {
    const f = sessFile(uid);
    if (fs.existsSync(f)) {
      const data = JSON.parse(fs.readFileSync(f, 'utf8'));
      sessions[uid] = data.history || [];
      return sessions[uid];
    }
  } catch(e) { console.error(`[DB] 세션 로드 오류 (${uid}):`, e.message); }
  sessions[uid] = [];
  return sessions[uid];
}

function saveSession(uid, history) {
  try {
    sessions[uid] = history;
    // 게스트 세션은 파일로 저장하지 않음
    if (uid.startsWith('guest_')) return;
    fs.writeFileSync(sessFile(uid), JSON.stringify({ uid, history, updatedAt: Date.now() }, null, 2), 'utf8');
  } catch(e) { console.error(`[DB] 세션 저장 오류 (${uid}):`, e.message); }
}

function deleteSession(uid) {
  delete sessions[uid];
  try {
    const f = sessFile(uid);
    if (fs.existsSync(f)) fs.unlinkSync(f);
  } catch(e) {}
}

// ── 대화 히스토리 요약 (장기 기억) ──────────────────────────
// 히스토리가 MAX_HISTORY_PAIRS 쌍을 넘으면 앞부분을 요약문으로 압축
const MAX_HISTORY_PAIRS = 15;  // 유지할 최대 대화 쌍 수 (초과 시 요약)
const SUMMARY_KEEP_RECENT = 6; // 요약 후 최근 몇 쌍은 그대로 유지

async function compressHistory(history, userCharName) {
  if (history.length <= MAX_HISTORY_PAIRS * 2) return history;

  const client = getOpenAIClient();
  if (!client) {
    // API 없으면 단순 절삭
    return history.slice(-SUMMARY_KEEP_RECENT * 2);
  }

  // 요약할 구간: 전체에서 최근 SUMMARY_KEEP_RECENT 쌍 제외한 앞부분
  const keepStart  = history.length - SUMMARY_KEEP_RECENT * 2;
  const toSummarize = history.slice(0, keepStart);
  const keepRecent  = history.slice(keepStart);

  const summaryPrompt = `다음은 ${characterConfig.name}와 사용자(호칭: ${userCharName||'너'})의 대화 내용입니다.
이 대화에서 중요한 감정적 맥락, 사건, 사용자가 밝힌 정보를 3~5문장으로 요약하세요.
캐릭터가 이 내용을 기억하고 자연스럽게 이어갈 수 있도록 핵심만 간결하게 써주세요.
요약문만 출력하세요.`;

  try {
    const model = (characterConfig.claudeApiKey||apiConfig.apiKey||'').startsWith('sk-ant-') ? 'claude-opus-4-5' : 'gpt-4o';
    const resp = await client.chat.completions.create({
      model,
      messages: [
        { role: 'system', content: summaryPrompt },
        ...toSummarize,
      ],
      max_tokens: 300,
      temperature: 0.3,
    });
    const summary = resp.choices[0].message.content.trim();
    console.log(`[Memory] 대화 요약 완료 (${toSummarize.length}개 → 요약)`);

    // 요약을 system 메시지 형태로 앞에 붙임
    return [
      { role: 'system', content: `[이전 대화 요약] ${summary}` },
      ...keepRecent,
    ];
  } catch(e) {
    console.error('[Memory] 요약 실패:', e.message);
    return history.slice(-SUMMARY_KEEP_RECENT * 2);
  }
}

// 시작 시 영속 데이터 로드
loadCharacterConfig();
loadUsers();

// ═══════════════════════════════════════════════════════
//  공개 API (사용자용)
// ═══════════════════════════════════════════════════════

app.use('/', express.static(path.join(__dirname, 'public')));
app.use('/admin', express.static(path.join(__dirname, 'public/admin')));

// ── 캐릭터 공개 정보 ──────────────────────────────────
app.get('/api/character', (req, res) => {
  const profileSrc = characterConfig.profileImageUrl
    || (characterConfig.profileImageBase64 ? `data:image/jpeg;base64,${characterConfig.profileImageBase64}` : null);

  res.json({
    name:            characterConfig.name,
    intro:           characterConfig.intro,
    openingMessage:  characterConfig.openingMessage,
    playGuide:       characterConfig.playGuide,
    profileImageSrc: profileSrc,
    genre:           characterConfig.genre,
    hashtags:        characterConfig.hashtags,
    characterDetail: characterConfig.characterDetail,
    lore:            characterConfig.lore  || '',
    specs:           characterConfig.specs || [],
    hasApi:          !!(characterConfig.claudeApiKey || apiConfig.apiKey),
  });
});

// ── 게스트 세션 생성 ─────────────────────────────────
app.post('/api/guest/init', (req, res) => {
  const guest = createGuest();
  const token = jwt.sign(
    { userId: guest.id, isGuest: true, iat: Date.now() },
    JWT_SECRET,
    { expiresIn: '7d' }
  );
  res.json({
    success: true,
    token,
    userId: guest.id,
    tokenUsed: guest.tokenUsed,
    tokenLimit: guest.tokenLimit,
    isGuest: true,
  });
});

// ── 회원가입 ─────────────────────────────────────────
app.post('/api/user/register', (req, res) => {
  const { email, password, nickname, genres, charName, guestToken } = req.body;
  if (!email || !password) return res.status(400).json({ error: '이메일과 비밀번호를 입력해 주세요.' });

  // 이메일 중복 체크
  const existing = Object.values(users).find(u => u.email === email);
  if (existing) return res.status(400).json({ error: '이미 사용 중인 이메일입니다.' });

  const userId = 'user_' + Date.now() + '_' + Math.random().toString(36).slice(2,6);
  const passwordHash = bcrypt.hashSync(password, 10);

  // 게스트 토큰이 있으면 기존 대화 이어받기
  let inheritedHistory = [];
  if (guestToken) {
    try {
      const decoded = jwt.verify(guestToken, JWT_SECRET);
      if (decoded.isGuest) {
        const guestHistory = loadSession(decoded.userId);
        if (guestHistory.length > 0) {
          inheritedHistory = guestHistory;
          console.log(`[Register] 게스트 대화 ${guestHistory.length}개 이어받기 (${decoded.userId})`);
        }
      }
    } catch(e) {}
  }

  users[userId] = {
    id: userId,
    email,
    passwordHash,
    nickname: nickname || email.split('@')[0],
    charName: charName || null,
    genres: Array.isArray(genres) ? genres : [],
    tokenUsed: 0,
    tokenLimit: memberTokenLimit,
    isGuest: false,
    createdAt: Date.now(),
  };

  if (inheritedHistory.length > 0) {
    saveSession(userId, inheritedHistory);
  }

  saveUsers(); // 영속 저장

  const token = jwt.sign(
    { userId, isGuest: false, iat: Date.now() },
    JWT_SECRET,
    { expiresIn: '30d' }
  );

  const finalHistory = loadSession(userId);
  res.json({
    success: true,
    token,
    userId,
    nickname: users[userId].nickname,
    tokenUsed: 0,
    tokenLimit: memberTokenLimit,
    isGuest: false,
    hasHistory: finalHistory.length > 0,
    historyCount: Math.floor(finalHistory.filter(m => m.role !== 'system').length / 2),
  });
});

// ── 로그인 ───────────────────────────────────────────
app.post('/api/user/login', (req, res) => {
  const { email, password } = req.body;
  const user = Object.values(users).find(u => u.email === email && !u.isGuest);
  if (!user || !bcrypt.compareSync(password, user.passwordHash)) {
    return res.status(401).json({ error: '이메일 또는 비밀번호가 올바르지 않습니다.' });
  }
  const token = jwt.sign(
    { userId: user.id, isGuest: false, iat: Date.now() },
    JWT_SECRET,
    { expiresIn: '30d' }
  );

  // 로그인 시 게스트 세션 이어받기 (guestToken 전달된 경우)
  const { guestToken } = req.body;
  if (guestToken) {
    try {
      const decoded = jwt.verify(guestToken, JWT_SECRET);
      if (decoded.isGuest) {
        const guestHistory = loadSession(decoded.userId);
        const userHistory  = loadSession(user.id);
        if (guestHistory.length > 0) {
          // 게스트 대화 + 기존 회원 대화를 합치되, 게스트 대화를 앞에 붙임
          const merged = [...guestHistory, ...userHistory];
          saveSession(user.id, merged);
          console.log(`[Login] 게스트(${guestHistory.length}) + 기존(${userHistory.length}) 대화 병합`);
        }
      }
    } catch(e) {}
  }

  // 히스토리 길이 조회
  const history = loadSession(user.id);

  res.json({
    success: true,
    token,
    userId: user.id,
    nickname: user.nickname,
    charName: user.charName,
    genres: user.genres,
    tokenUsed: user.tokenUsed,
    tokenLimit: user.tokenLimit,
    isGuest: false,
    hasHistory: history.length > 0,  // 이전 대화 있는지 여부
    historyCount: Math.floor(history.length / 2), // 대화 턴 수
  });
});

// ── 사용자 프로필 업데이트 (호칭/장르) ────────────────
app.post('/api/user/profile', (req, res) => {
  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith('Bearer ')) return res.status(401).json({ error: '인증이 필요합니다.' });
  try {
    const decoded = jwt.verify(auth.slice(7), JWT_SECRET);
    const user = users[decoded.userId];
    if (!user) return res.status(404).json({ error: '사용자를 찾을 수 없습니다.' });

    const { charName, genres, nickname } = req.body;
    if (charName  !== undefined) user.charName  = charName;
    if (genres    !== undefined) user.genres    = Array.isArray(genres) ? genres : [];
    if (nickname  !== undefined) user.nickname  = nickname;

    res.json({ success: true, charName: user.charName, genres: user.genres, nickname: user.nickname });
  } catch(e) {
    res.status(401).json({ error: '유효하지 않은 토큰입니다.' });
  }
});

// ── 채팅 ─────────────────────────────────────────────
app.post('/api/chat', async (req, res) => {
  try {
    const { message, sessionId } = req.body;
    if (!message) return res.status(400).json({ error: '메시지가 필요합니다.' });

    // 사용자 인증 확인
    const auth = req.headers.authorization;
    let userId  = null;
    let userObj = null;
    let isGuest = true;

    if (auth && auth.startsWith('Bearer ')) {
      try {
        const decoded = jwt.verify(auth.slice(7), JWT_SECRET);
        userId  = decoded.userId;
        userObj = users[userId];
        isGuest = decoded.isGuest || (userObj?.isGuest ?? true);
      } catch(e) {}
    }

    // 미인증 → 임시 게스트 생성
    if (!userId || !userObj) {
      const guest = createGuest();
      userId  = guest.id;
      userObj = guest;
      isGuest = true;
    }

    // 토큰 잔량 확인
    if (userObj.tokenUsed >= userObj.tokenLimit) {
      return res.status(402).json({
        error: 'token_exhausted',
        isGuest,
        message: isGuest
          ? `무료 대화 ${userObj.tokenLimit}회를 모두 사용했습니다. 회원가입 후 계속 이용하세요.`
          : `이용 가능한 토큰이 없습니다.`,
      });
    }

    const convId = sessionId || userId;
    const history = loadSession(userId); // 항상 userId 기반으로 로드

    console.log(`[Chat] "${message.substring(0,30)}" (user: ${userId}, history: ${history.length}, tokens: ${userObj.tokenUsed+1}/${userObj.tokenLimit})`);

    const rawResponse = await askClaude(message, history, userObj.charName || '');
    history.push({ role: 'user', content: message });
    history.push({ role: 'assistant', content: rawResponse });

    // 히스토리 압축 (MAX_HISTORY_PAIRS 초과 시 요약)
    const compressed = await compressHistory(history, userObj.charName || '');
    saveSession(userId, compressed);

    // 토큰 사용
    userObj.tokenUsed++;
    if (!userObj.isGuest) saveUsers(); // 회원 토큰 사용량 영속 저장

    const parsed = parseResponse(rawResponse);

    let imageData = null;
    if (parsed.situationImage) {
      const si = parsed.situationImage;
      if (si.imageBase64) {
        imageData = { type: 'stored', src: `data:image/jpeg;base64,${si.imageBase64}`, description: si.description, trigger: si.trigger };
      } else if (si.imageUrl) {
        imageData = { type: 'stored', src: si.imageUrl, description: si.description, trigger: si.trigger };
      }
    }

    res.json({
      success:    true,
      raw:        rawResponse,
      narrative:  parsed.narrative,
      dialogue:   parsed.dialogue,
      sets:       parsed.sets,
      imageData,
      sessionId:  userId,
      tokenUsed:  userObj.tokenUsed,
      tokenLimit: userObj.tokenLimit,
      isGuest,
      userId,
    });
  } catch(err) {
    console.error('[Chat] 오류:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── DomoAI 실시간 미디어 생성 (상황 이미지 → 애니메이션) ──
app.post('/api/generate-media', async (req, res) => {
  try {
    const { prompt, imageId } = req.body;
    const domoKey = characterConfig.domoaiApiKey || DOMOAI_API_KEY;

    if (!domoKey) {
      return res.json({ success: false, mock: true, videoUrl: null, message: 'DomoAI API 키 미설정' });
    }

    let imageBase64 = null;
    if (imageId) {
      const si = characterConfig.situationImages.find(i => i.id === imageId);
      if (si?.imageBase64) imageBase64 = si.imageBase64;
    }

    let videoUrl = null;
    if (imageBase64) {
      videoUrl = await generateSituationMedia(imageBase64, prompt || `${characterConfig.name}, anime character, dynamic scene`);
    }

    res.json({ success: true, videoUrl });
  } catch(err) {
    console.error('[Media] 오류:', err.message);
    res.json({ success: false, error: err.message });
  }
});

// ── DomoAI 추가 이미지 생성 (관리자 전용) ────────────────
app.post('/api/admin/generate-images', requireAdmin, async (req, res) => {
  try {
    const { prompt, count = 1 } = req.body;
    const domoKey = characterConfig.domoaiApiKey || DOMOAI_API_KEY;

    if (!domoKey) {
      return res.status(400).json({ error: 'DomoAI API 키가 설정되지 않았습니다.' });
    }

    const finalPrompt = prompt || characterConfig.domoImagePrompt;
    const generateCount = Math.min(parseInt(count) || 1, 5); // 최대 5개

    console.log(`[DomoAI] 추가 이미지 ${generateCount}개 생성 시작: "${finalPrompt.substring(0,60)}"`);

    // 병렬로 생성
    const promises = Array.from({ length: generateCount }, () => generateDomoImage(finalPrompt));
    const urls = await Promise.allSettled(promises);

    const results = urls.map((r, i) => ({
      index: i + 1,
      success: r.status === 'fulfilled' && !!r.value,
      url: r.status === 'fulfilled' ? r.value : null,
      error: r.status === 'rejected' ? r.reason?.message : null,
    }));

    res.json({ success: true, results, prompt: finalPrompt });
  } catch(err) {
    console.error('[Admin/GenerateImages] 오류:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ═══════════════════════════════════════════════════════
//  관리자 인증 API
// ═══════════════════════════════════════════════════════

app.post('/api/admin/login', (req, res) => {
  const { password } = req.body;
  if (!password) return res.status(400).json({ error: '비밀번호를 입력하세요.' });

  if (!bcrypt.compareSync(password, ADMIN_PASSWORD_HASH)) {
    return res.status(401).json({ error: '비밀번호가 틀렸습니다.' });
  }

  const token = jwt.sign({ isAdmin: true, iat: Date.now() }, JWT_SECRET, { expiresIn: '24h' });
  res.json({ success: true, token });
});

// ═══════════════════════════════════════════════════════
//  관리자 전용 API
// ═══════════════════════════════════════════════════════

app.get('/api/admin/character', requireAdmin, (req, res) => {
  res.json({
    ...characterConfig,
    profileImageBase64: characterConfig.profileImageBase64 ? '[설정됨]' : null,
    situationImages: characterConfig.situationImages.map(si => ({
      ...si,
      imageBase64: si.imageBase64 ? '[설정됨]' : null,
    })),
    claudeApiKey: characterConfig.claudeApiKey ? '***' + characterConfig.claudeApiKey.slice(-4) : '',
    domoaiApiKey: characterConfig.domoaiApiKey ? '***' + characterConfig.domoaiApiKey.slice(-4) : '',
  });
});

app.post('/api/admin/character/basic', requireAdmin, upload.single('profileImage'), (req, res) => {
  const { name, intro, profileImageUrl } = req.body;
  if (name)  characterConfig.name  = name;
  if (intro) characterConfig.intro = intro;
  if (req.file) {
    characterConfig.profileImageBase64 = req.file.buffer.toString('base64');
    characterConfig.profileImageUrl    = null;
  } else if (profileImageUrl) {
    characterConfig.profileImageUrl    = profileImageUrl;
    characterConfig.profileImageBase64 = null;
  }
  saveCharacterConfig();
  res.json({ success: true });
});

app.post('/api/admin/character/intro', requireAdmin, (req, res) => {
  const { openingMessage, exampleDialogues, playGuide } = req.body;
  if (openingMessage    !== undefined) characterConfig.openingMessage   = openingMessage;
  if (exampleDialogues  !== undefined) characterConfig.exampleDialogues = exampleDialogues;
  if (playGuide         !== undefined) characterConfig.playGuide        = playGuide;
  saveCharacterConfig();
  res.json({ success: true });
});

app.post('/api/admin/character/prompt', requireAdmin, (req, res) => {
  const { characterPrompt } = req.body;
  if (characterPrompt !== undefined) characterConfig.characterPrompt = characterPrompt;
  saveCharacterConfig();
  // 프롬프트 변경 시 기존 세션 맥락과 충돌 방지를 위해 세션 초기화
  clearSessions();
  res.json({ success: true });
});

// ── 상황 이미지 CRUD ──────────────────────────────────
app.post('/api/admin/character/situation', requireAdmin, upload.single('image'), (req, res) => {
  const { trigger, description, imageUrl, imagePrompt } = req.body;
  const id = 'si_' + Date.now();
  const newSi = { id, trigger: trigger || '', description: description || '', imagePrompt: imagePrompt || '', imageBase64: null, imageUrl: imageUrl || null };
  if (req.file) { newSi.imageBase64 = req.file.buffer.toString('base64'); newSi.imageUrl = null; }
  characterConfig.situationImages.push(newSi);
  saveCharacterConfig();
  res.json({ success: true, id });
});

app.put('/api/admin/character/situation/:id', requireAdmin, upload.single('image'), (req, res) => {
  const si = characterConfig.situationImages.find(i => i.id === req.params.id);
  if (!si) return res.status(404).json({ error: '없음' });
  const { trigger, description, imageUrl, imagePrompt } = req.body;
  if (trigger     !== undefined) si.trigger     = trigger;
  if (description !== undefined) si.description = description;
  if (imagePrompt !== undefined) si.imagePrompt = imagePrompt;
  if (req.file) { si.imageBase64 = req.file.buffer.toString('base64'); si.imageUrl = null; }
  else if (imageUrl) { si.imageUrl = imageUrl; si.imageBase64 = null; }
  saveCharacterConfig();
  res.json({ success: true });
});

app.delete('/api/admin/character/situation/:id', requireAdmin, (req, res) => {
  const idx = characterConfig.situationImages.findIndex(i => i.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: '없음' });
  characterConfig.situationImages.splice(idx, 1);
  saveCharacterConfig();
  res.json({ success: true });
});

app.post('/api/admin/character/detail', requireAdmin, (req, res) => {
  const { characterDetail, genre, hashtags, domoImagePrompt, domoImageCount } = req.body;
  if (characterDetail  !== undefined) characterConfig.characterDetail  = characterDetail;
  if (genre            !== undefined) characterConfig.genre            = genre;
  if (hashtags         !== undefined) characterConfig.hashtags         = Array.isArray(hashtags) ? hashtags : hashtags.split(',').map(h => h.trim()).filter(Boolean);
  if (domoImagePrompt  !== undefined) characterConfig.domoImagePrompt  = domoImagePrompt;
  if (domoImageCount   !== undefined) characterConfig.domoImageCount   = parseInt(domoImageCount) || 3;
  saveCharacterConfig();
  res.json({ success: true });
});

// ── 랜딩 페이지 정보 (세계관/스펙) 업데이트 ────────────
app.post('/api/admin/character/lore', requireAdmin, (req, res) => {
  const { lore, specs } = req.body;
  if (lore  !== undefined) characterConfig.lore  = lore;
  if (specs !== undefined) {
    characterConfig.specs = Array.isArray(specs) ? specs : [];
  }
  saveCharacterConfig();
  res.json({ success: true });
});

app.post('/api/admin/keys', requireAdmin, (req, res) => {
  const { claudeApiKey, domoaiApiKey } = req.body;
  if (claudeApiKey  !== undefined) { characterConfig.claudeApiKey = claudeApiKey; if (claudeApiKey) apiConfig = resolveApiConfig(); }
  if (domoaiApiKey  !== undefined) { characterConfig.domoaiApiKey = domoaiApiKey; if (domoaiApiKey) DOMOAI_API_KEY = domoaiApiKey; }
  saveCharacterConfig();
  res.json({ success: true });
});

app.post('/api/admin/reset-sessions', requireAdmin, (req, res) => {
  clearSessions();
  res.json({ success: true, message: '모든 세션 초기화 완료' });
});

// ── 상태 확인 (공개) ─────────────────────────────────
app.get('/api/status', (req, res) => {
  const domoKey   = !!(characterConfig.domoaiApiKey || DOMOAI_API_KEY);
  const claudeKey = !!(characterConfig.claudeApiKey || apiConfig.apiKey);
  res.json({
    domoai:    { connected: domoKey,   key: domoKey   ? '설정됨' : '미설정' },
    claude:    { connected: claudeKey, key: claudeKey ? `설정됨 (${apiConfig.type})` : '미설정' },
    character: characterConfig.name,
    systemPromptLen: buildSystemPrompt('').length,
    sessionsActive:  Object.keys(sessions).length,
    guestTokenLimit,
    memberTokenLimit,
  });
});

// ── SPA 라우팅 ────────────────────────────────────────
app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, 'public/admin/index.html')));
app.get('/admin/{*path}', (req, res) => res.sendFile(path.join(__dirname, 'public/admin/index.html')));
app.use((req, res, next) => {
  if (req.method === 'GET' && !req.path.startsWith('/api')) {
    res.sendFile(path.join(__dirname, 'public/index.html'));
  } else next();
});

// ── 대화 히스토리 조회 (로그인 후 이전 대화 복원용) ──────────
app.get('/api/chat/history', (req, res) => {
  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith('Bearer ')) return res.status(401).json({ error: '인증이 필요합니다.' });
  try {
    const decoded = jwt.verify(auth.slice(7), JWT_SECRET);
    if (decoded.isGuest) return res.json({ history: [], count: 0 });

    const history = loadSession(decoded.userId);
    // AI·유저 대화 쌍만 반환 (system 요약 메시지 포함)
    res.json({
      history,
      count: Math.floor(history.filter(m => m.role !== 'system').length / 2),
    });
  } catch(e) {
    res.status(401).json({ error: '유효하지 않은 토큰입니다.' });
  }
});

// ── 대화 히스토리 삭제 (사용자 초기화) ─────────────────────
app.delete('/api/chat/history', (req, res) => {
  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith('Bearer ')) return res.status(401).json({ error: '인증이 필요합니다.' });
  try {
    const decoded = jwt.verify(auth.slice(7), JWT_SECRET);
    deleteSession(decoded.userId);
    res.json({ success: true });
  } catch(e) {
    res.status(401).json({ error: '유효하지 않은 토큰입니다.' });
  }
});

function clearSessions() {
  // 메모리 세션 초기화
  Object.keys(sessions).forEach(k => delete sessions[k]);
  // 파일 세션 초기화 (게스트 제외 회원 세션 파일만 삭제)
  try {
    const files = fs.readdirSync(SESS_DIR);
    files.forEach(f => {
      if (f.endsWith('.json')) fs.unlinkSync(path.join(SESS_DIR, f));
    });
  } catch(e) {}
  console.log('[Server] 세션 초기화');
}

app.listen(PORT, () => {
  console.log(`\n🚀 서버: http://localhost:${PORT}`);
  console.log(`👤 사용자 채팅: http://localhost:${PORT}/`);
  console.log(`⚙️  관리자 페이지: http://localhost:${PORT}/admin`);
  console.log(`🔐 관리자 비밀번호: ${process.env.ADMIN_PASSWORD || 'admin1234'}`);
  console.log(`🤖 Claude: ${apiConfig.apiKey ? `✅ ${apiConfig.type}` : '❌ 미설정'}`);
  console.log(`🎨 DomoAI: ${DOMOAI_API_KEY ? '✅ 연동됨' : '❌ 미설정'}`);
  console.log(`🎫 게스트 토큰: ${guestTokenLimit}회 / 회원 토큰: ${memberTokenLimit}회\n`);
});
