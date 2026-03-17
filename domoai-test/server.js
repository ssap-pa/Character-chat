require('dotenv').config();
const express = require('express');
const cors = require('cors');
const multer = require('multer');
const axios = require('axios');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// multer: 메모리에 저장 (base64 변환용)
const storage = multer.memoryStorage();
const upload = multer({ storage, limits: { fileSize: 10 * 1024 * 1024 } });

const DOMOAI_API_KEY = process.env.DOMOAI_API_KEY || '';
const DOMOAI_BASE_URL = 'https://enterprise-api.domoai.app';

// ===================================================
// DomoAI API 연동 모듈
// ===================================================

/**
 * DomoAI - 이미지에서 이미지 생성 (img2img, character reference)
 * 레퍼런스 이미지를 유지하면서 표정/스타일만 변경
 */
async function generateImageWithReference(referenceImageBase64, prompt, style = 'anime') {
  const headers = {
    'Authorization': `Bearer ${DOMOAI_API_KEY}`,
    'Content-Type': 'application/json',
  };

  // DomoAI Enterprise API: 이미지 기반 이미지 생성
  // 캐릭터 레퍼런스를 유지하면서 프롬프트로 표정/상황 변경
  const payload = {
    prompt: prompt,
    image: {
      bytes_base64_encoded: referenceImageBase64
    },
    // style_reference: 캐릭터 일관성 유지 핵심 파라미터
    style: style,
    character_reference: true,
    strength: 0.6  // 레퍼런스 유지 강도 (0~1, 높을수록 원본에 가까움)
  };

  try {
    // Task 생성
    const createRes = await axios.post(
      `${DOMOAI_BASE_URL}/v1/generate/image-to-image`,
      payload,
      { headers, timeout: 30000 }
    );

    const taskId = createRes.data?.data?.task_id;
    if (!taskId) {
      throw new Error('task_id를 받지 못했습니다: ' + JSON.stringify(createRes.data));
    }

    console.log(`[DomoAI] Task 생성 완료: ${taskId}`);

    // Task 폴링 (최대 2분)
    return await pollTask(taskId, headers);
  } catch (err) {
    // API 키가 없거나 엔터프라이즈 플랜이 없는 경우 → 목업 반환
    console.warn('[DomoAI] API 호출 실패, 목업 이미지 반환:', err.message);
    return { 
      success: false, 
      error: err.message,
      mock: true,
      // 테스트용: 샘플 캐릭터 이미지 URL (실제 서비스에서는 DomoAI 결과로 대체)
      imageUrl: `https://picsum.photos/seed/${Date.now()}/400/500`
    };
  }
}

/**
 * Task 상태 폴링
 */
async function pollTask(taskId, headers, maxAttempts = 24, interval = 5000) {
  for (let i = 0; i < maxAttempts; i++) {
    await new Promise(r => setTimeout(r, interval));

    try {
      const statusRes = await axios.get(
        `${DOMOAI_BASE_URL}/v1/tasks/${taskId}`,
        { headers, timeout: 10000 }
      );

      const status = statusRes.data?.data?.status;
      console.log(`[DomoAI] Task ${taskId} 상태: ${status} (${i + 1}/${maxAttempts})`);

      if (status === 'COMPLETED' || status === 'SUCCESS') {
        const output = statusRes.data?.data?.output;
        const imageUrl = output?.image_url || output?.url || output?.[0]?.url;
        return { success: true, imageUrl, taskId };
      }

      if (status === 'FAILED' || status === 'ERROR') {
        throw new Error(`Task 실패: ${JSON.stringify(statusRes.data?.data)}`);
      }
    } catch (pollErr) {
      console.warn(`[DomoAI] 폴링 오류 (${i + 1}):`, pollErr.message);
    }
  }

  throw new Error('Task 시간 초과 (2분)');
}

// ===================================================
// API 엔드포인트
// ===================================================

/**
 * POST /api/generate-character-image
 * 레퍼런스 이미지 + 프롬프트로 캐릭터 이미지 생성
 */
app.post('/api/generate-character-image', upload.single('reference'), async (req, res) => {
  try {
    const { prompt, style } = req.body;
    let referenceBase64 = null;

    if (req.file) {
      referenceBase64 = req.file.buffer.toString('base64');
    } else if (req.body.reference_base64) {
      referenceBase64 = req.body.reference_base64;
    }

    if (!referenceBase64) {
      return res.status(400).json({ success: false, error: '레퍼런스 이미지가 필요합니다.' });
    }

    if (!prompt) {
      return res.status(400).json({ success: false, error: '프롬프트가 필요합니다.' });
    }

    console.log(`[API] 이미지 생성 요청 - 프롬프트: "${prompt}", 스타일: ${style || 'anime'}`);

    const result = await generateImageWithReference(referenceBase64, prompt, style || 'anime');

    if (result.mock) {
      return res.json({
        success: true,
        mock: true,
        imageUrl: result.imageUrl,
        message: 'DomoAI API 키가 없어 테스트 이미지를 반환합니다. 실제 운영 시 Enterprise API 키를 설정하세요.',
        prompt,
        style: style || 'anime'
      });
    }

    res.json({ success: true, imageUrl: result.imageUrl, taskId: result.taskId });
  } catch (err) {
    console.error('[API] 오류:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * POST /api/generate-character-image-url
 * URL로 레퍼런스 이미지 전달 + 프롬프트로 캐릭터 이미지 생성
 */
app.post('/api/generate-character-image-url', async (req, res) => {
  try {
    const { imageUrl, prompt, style } = req.body;

    if (!imageUrl || !prompt) {
      return res.status(400).json({ success: false, error: 'imageUrl과 prompt가 필요합니다.' });
    }

    console.log(`[API] URL 기반 이미지 생성 - URL: ${imageUrl}, 프롬프트: "${prompt}"`);

    // URL에서 이미지 다운로드 → base64 변환
    let referenceBase64;
    try {
      const imgRes = await axios.get(imageUrl, { responseType: 'arraybuffer', timeout: 15000 });
      referenceBase64 = Buffer.from(imgRes.data).toString('base64');
    } catch (downloadErr) {
      return res.status(400).json({ success: false, error: '레퍼런스 이미지 다운로드 실패: ' + downloadErr.message });
    }

    const result = await generateImageWithReference(referenceBase64, prompt, style || 'anime');

    if (result.mock) {
      return res.json({
        success: true,
        mock: true,
        imageUrl: result.imageUrl,
        message: 'DomoAI API 키가 없어 테스트 이미지를 반환합니다.',
        prompt,
        style: style || 'anime'
      });
    }

    res.json({ success: true, imageUrl: result.imageUrl, taskId: result.taskId });
  } catch (err) {
    console.error('[API] 오류:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * GET /api/task/:taskId
 * Task 상태 확인
 */
app.get('/api/task/:taskId', async (req, res) => {
  try {
    const { taskId } = req.params;
    const headers = {
      'Authorization': `Bearer ${DOMOAI_API_KEY}`,
      'Content-Type': 'application/json',
    };

    const statusRes = await axios.get(
      `${DOMOAI_BASE_URL}/v1/tasks/${taskId}`,
      { headers, timeout: 10000 }
    );

    res.json(statusRes.data);
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * GET /api/domoai-status
 * DomoAI API 연결 상태 확인
 */
app.get('/api/domoai-status', async (req, res) => {
  const hasKey = !!DOMOAI_API_KEY && DOMOAI_API_KEY !== 'your_domoai_api_key_here';
  res.json({
    connected: hasKey,
    apiKeyConfigured: hasKey,
    message: hasKey 
      ? 'DomoAI API 키가 설정되어 있습니다.' 
      : 'DomoAI API 키가 설정되지 않았습니다. .env 파일에 DOMOAI_API_KEY를 설정하세요.',
    baseUrl: DOMOAI_BASE_URL
  });
});

// 기본 라우트
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`\n🚀 DomoAI 테스트 서버 실행 중: http://localhost:${PORT}`);
  console.log(`📋 API 상태 확인: http://localhost:${PORT}/api/domoai-status`);
  console.log(`🔑 DomoAI API 키: ${DOMOAI_API_KEY ? '설정됨' : '미설정 (테스트 목업 모드)'}\n`);
});
