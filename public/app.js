// ===== 상태 =====
let worker = localStorage.getItem('worker') || '';
let username = localStorage.getItem('username') || '';
let session = null;          // { id, partNo, targetQty }
let scanMode = 'box';        // 'box' | 'product'
let scannerRunning = false;
let lastCode = '';
let lastCodeAt = 0;
let busy = false;

const $ = (id) => document.getElementById(id);
const screens = ['screen-login', 'screen-home', 'screen-scan', 'screen-history', 'screen-detail'];

function show(id) {
  screens.forEach((s) => $(s).classList.toggle('hidden', s !== id));
}

function fmtTime(iso) {
  if (!iso) return '-';
  return new Date(iso).toLocaleString('ko-KR', { hour12: false });
}

async function api(path, opts = {}) {
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    ...opts,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `요청 실패 (${res.status})`);
  return data;
}

// ===== 소리 / 진동 =====
let audioCtx = null;
function beep(freq, duration, when = 0, type = 'square') {
  if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  const osc = audioCtx.createOscillator();
  const gain = audioCtx.createGain();
  osc.type = type;
  osc.frequency.value = freq;
  gain.gain.value = 0.4;
  osc.connect(gain).connect(audioCtx.destination);
  const t = audioCtx.currentTime + when;
  osc.start(t);
  osc.stop(t + duration);
}
function soundOK() { beep(1400, 0.12, 0, 'sine'); }
function soundNG() { beep(300, 0.25); beep(300, 0.25, 0.3); beep(300, 0.5, 0.6); if (navigator.vibrate) navigator.vibrate([300, 100, 300, 100, 500]); }
function soundInfo() { beep(900, 0.1, 0, 'sine'); beep(1200, 0.1, 0.12, 'sine'); }

// ===== 판정 오버레이 =====
let flashTimer = null;
function showFlash(kind, icon, text, detail, holdMs) {
  const flash = $('flash');
  flash.className = `flash ${kind}`;
  $('flash-icon').textContent = icon;
  $('flash-text').textContent = text;
  $('flash-detail').textContent = detail || '';
  clearTimeout(flashTimer);
  flashTimer = setTimeout(() => flash.classList.add('hidden'), holdMs);
}

// ===== 로그인 / 회원가입 =====
$('tab-login').onclick = () => setAuthTab('login');
$('tab-register').onclick = () => setAuthTab('register');
function setAuthTab(tab) {
  $('tab-login').classList.toggle('active', tab === 'login');
  $('tab-register').classList.toggle('active', tab === 'register');
  $('form-login').classList.toggle('hidden', tab !== 'login');
  $('form-register').classList.toggle('hidden', tab !== 'register');
  authMsg('');
}
function authMsg(msg, ok = false) {
  const el = $('auth-msg');
  el.textContent = msg;
  el.classList.toggle('ok', ok);
}

$('btn-register').onclick = async () => {
  try {
    await api('/api/register', {
      method: 'POST',
      body: JSON.stringify({
        name: $('reg-name').value,
        username: $('reg-username').value,
        password: $('reg-password').value,
      }),
    });
    authMsg('회원가입 완료! 로그인해 주세요.', true);
    $('login-username').value = $('reg-username').value;
    setAuthTab('login');
    authMsg('회원가입 완료! 로그인해 주세요.', true);
  } catch (e) {
    authMsg(e.message);
  }
};

$('btn-login').onclick = async () => {
  try {
    const data = await api('/api/login', {
      method: 'POST',
      body: JSON.stringify({ username: $('login-username').value, password: $('login-password').value }),
    });
    worker = data.worker;
    username = data.username;
    localStorage.setItem('worker', worker);
    localStorage.setItem('username', username);
    enterHome();
  } catch (e) {
    authMsg(e.message);
  }
};
$('login-password').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('btn-login').click(); });

$('btn-logout').onclick = () => {
  worker = ''; username = '';
  localStorage.removeItem('worker');
  localStorage.removeItem('username');
  show('screen-login');
};

function enterHome() {
  $('home-worker').textContent = `👷 ${worker} (${username})`;
  show('screen-home');
}

// ===== 스캐너 =====
// 네이티브 BarcodeDetector(안드로이드 크롬, ML Kit 가속)를 우선 사용하고,
// 미지원 브라우저(iOS 사파리 등)는 zxing-wasm 폴리필로 자동 대체
const SCAN_FORMATS = ['qr_code', 'data_matrix', 'code_128', 'code_39', 'ean_13'];
let detector = null;
let mediaStream = null;
let videoTrack = null;
let scanTimer = null;
let frameCount = 0;
const cropCanvas = document.createElement('canvas');
const cropCtx = cropCanvas.getContext('2d', { willReadFrequently: true });

async function getDetector() {
  if (detector) return detector;
  let D = null;
  if (window.BarcodeDetector) {
    try {
      const supported = await window.BarcodeDetector.getSupportedFormats();
      if (SCAN_FORMATS.every((f) => supported.includes(f))) D = window.BarcodeDetector;
    } catch (e) {}
  }
  if (!D) {
    const mod = await import('https://fastly.jsdelivr.net/npm/barcode-detector@3/dist/es/pure.min.js');
    D = mod.BarcodeDetector;
  }
  detector = new D({ formats: SCAN_FORMATS });
  return detector;
}

// 제약 조건을 단계적으로 낮춰가며 카메라 열기
async function getCameraStream() {
  const attempts = [
    // 고해상도 + 후면 카메라 (인식률 최상)
    { audio: false, video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1080 } } },
    // 후면 카메라만 지정
    { audio: false, video: { facingMode: 'environment' } },
    // 아무 카메라나
    { audio: false, video: true },
  ];
  let lastErr = null;
  for (const c of attempts) {
    try {
      return await navigator.mediaDevices.getUserMedia(c);
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr || new Error('카메라를 열 수 없습니다.');
}

// 실제 영상 프레임이 나올 때까지 대기 (검은 화면 감지)
function waitForFrames(video, timeoutMs = 4000) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    (function check() {
      if (video.videoWidth > 0 && video.readyState >= 2) return resolve(true);
      if (Date.now() - t0 > timeoutMs) return resolve(false);
      setTimeout(check, 100);
    })();
  });
}

function releaseStream() {
  if (mediaStream) {
    mediaStream.getTracks().forEach((t) => t.stop());
    mediaStream = null;
    videoTrack = null;
  }
}

// 재생을 여러 번 재시도하고, 끝내 거부되면 "탭하여 시작" 안내 표시
async function safePlay(video) {
  for (let i = 0; i < 6; i++) {
    try {
      await video.play();
      if (!video.paused) return true;
    } catch (e) {}
    await new Promise((r) => setTimeout(r, 250));
  }
  // 자동재생 거부 → 사용자 탭으로 시작
  const hint = $('tap-hint');
  hint.classList.remove('hidden');
  return new Promise((resolve) => {
    const onTap = async () => {
      hint.classList.add('hidden');
      try { await video.play(); } catch (e) {}
      resolve(!video.paused);
    };
    hint.addEventListener('click', onTap, { once: true });
  });
}

let starting = false; // 시작 도중 visibilitychange 등이 개입하지 못하게 하는 잠금

async function startScanner() {
  if (scannerRunning || starting) return;
  starting = true;
  try {
    const video = $('cam');
    // 디코더는 병렬로 로드 (카메라 시작을 지연시키지 않음 — 사용자 제스처 컨텍스트 유지)
    const detectorPromise = getDetector();

    mediaStream = await getCameraStream();
    video.srcObject = mediaStream;
    video.muted = true;
    await safePlay(video);

    // 프레임이 안 나오면(엉뚱한 렌즈가 잡힌 경우 등) 기본 설정으로 1회 재시도
    let ok = await waitForFrames(video);
    if (!ok) {
      releaseStream();
      mediaStream = await navigator.mediaDevices.getUserMedia({ audio: false, video: { facingMode: 'environment' } });
      video.srcObject = mediaStream;
      await safePlay(video);
      ok = await waitForFrames(video);
    }
    if (!ok) {
      releaseStream();
      throw new Error('카메라 영상이 나오지 않습니다. 다른 앱이 카메라를 사용 중인지 확인하거나, 브라우저(크롬 권장)를 완전히 종료 후 다시 시도해 주세요. 수동 입력은 계속 사용 가능합니다.');
    }

    videoTrack = mediaStream.getVideoTracks()[0];
    // 시스템이 카메라를 끊으면 자동 재시작
    videoTrack.addEventListener('ended', scheduleRestart);
    videoTrack.addEventListener('mute', scheduleRestart);
    await setupCameraControls();
    await detectorPromise;
    scannerRunning = true;
    frameCount = 0;
    scanLoop();
  } finally {
    starting = false;
  }
}

let restartTimer = null;
function scheduleRestart() {
  if (restartTimer) return;
  restartTimer = setTimeout(async () => {
    restartTimer = null;
    const onScanScreen = !$('screen-scan').classList.contains('hidden');
    if (!onScanScreen || starting) return;
    const video = $('cam');
    // 여전히 끊긴 상태일 때만 재시작
    if (videoTrack && videoTrack.readyState === 'live' && !videoTrack.muted && video.videoWidth > 0 && !video.paused) return;
    await stopScanner();
    try { await startScanner(); } catch (e) {}
  }, 1200);
}

async function setupCameraControls() {
  const caps = videoTrack.getCapabilities ? videoTrack.getCapabilities() : {};
  // 연속 자동초점
  try {
    if (caps.focusMode && caps.focusMode.includes('continuous')) {
      await videoTrack.applyConstraints({ advanced: [{ focusMode: 'continuous' }] });
    }
  } catch (e) {}
  // 줌 슬라이더 (지원 기기만)
  const slider = $('zoom-slider');
  if (caps.zoom) {
    slider.min = caps.zoom.min;
    slider.max = Math.min(caps.zoom.max, caps.zoom.min + (caps.zoom.max - caps.zoom.min));
    slider.step = caps.zoom.step || 0.1;
    slider.value = videoTrack.getSettings().zoom || caps.zoom.min;
    slider.classList.remove('hidden');
    slider.oninput = () => {
      videoTrack.applyConstraints({ advanced: [{ zoom: Number(slider.value) }] }).catch(() => {});
    };
  } else {
    slider.classList.add('hidden');
  }
  // 손전등 (지원 기기만)
  const torchBtn = $('btn-torch');
  if (caps.torch) {
    torchBtn.classList.remove('hidden');
    torchBtn.classList.remove('on');
    let torchOn = false;
    torchBtn.onclick = () => {
      torchOn = !torchOn;
      torchBtn.classList.toggle('on', torchOn);
      videoTrack.applyConstraints({ advanced: [{ torch: torchOn }] }).catch(() => {});
    };
  } else {
    torchBtn.classList.add('hidden');
  }
}

// 화면 가이드 박스(중앙 80%×60%) 영역을 원본 해상도 그대로 잘라 디코딩 → 디지털 줌 효과
function grabGuideCrop(video) {
  const vw = video.videoWidth, vh = video.videoHeight;
  if (!vw || !vh) return null;
  const cw = Math.floor(vw * 0.8), ch = Math.floor(vh * 0.6);
  cropCanvas.width = cw;
  cropCanvas.height = ch;
  cropCtx.drawImage(video, (vw - cw) / 2, (vh - ch) / 2, cw, ch, 0, 0, cw, ch);
  return cropCanvas;
}

async function scanLoop() {
  if (!scannerRunning) return;
  const video = $('cam');
  try {
    frameCount++;
    // 3프레임 중 2번은 가이드 박스 크롭, 1번은 전체 프레임으로 디코딩
    let source = frameCount % 3 === 0 ? video : grabGuideCrop(video);
    if (source) {
      const codes = await detector.detect(source);
      if (codes.length > 0 && codes[0].rawValue) onScanSuccess(codes[0].rawValue);
    }
  } catch (e) {}
  scanTimer = setTimeout(scanLoop, 120);
}

async function stopScanner() {
  scannerRunning = false;
  clearTimeout(scanTimer);
  clearTimeout(restartTimer);
  restartTimer = null;
  if (videoTrack) {
    videoTrack.removeEventListener('ended', scheduleRestart);
    videoTrack.removeEventListener('mute', scheduleRestart);
  }
  $('tap-hint').classList.add('hidden');
  const video = $('cam');
  if (video) { video.pause(); video.srcObject = null; }
  releaseStream();
}

// 앱 전환 등으로 카메라가 끊겼다가 돌아오면 자동 재시작 (시작 도중에는 개입하지 않음)
document.addEventListener('visibilitychange', () => {
  const onScanScreen = !$('screen-scan').classList.contains('hidden');
  if (!onScanScreen || starting) return;
  if (document.visibilityState === 'visible') {
    const video = $('cam');
    if (!scannerRunning || !video.srcObject || video.videoWidth === 0 || video.paused) {
      scheduleRestart();
    }
  }
});

function onScanSuccess(decodedText) {
  const nowMs = Date.now();
  // 같은 코드가 2.5초 안에 연속 인식되면 무시 (중복 방지)
  if (decodedText === lastCode && nowMs - lastCodeAt < 2500) return;
  lastCode = decodedText;
  lastCodeAt = nowMs;
  handleCode(decodedText);
}

async function handleCode(code) {
  if (busy) return;
  busy = true;
  try {
    if (scanMode === 'box') await handleBoxScan(code);
    else await handleProductScan(code);
  } catch (e) {
    soundNG();
    showFlash('ng', '⚠️', '오류', e.message, 2500);
  } finally {
    busy = false;
  }
}

async function handleBoxScan(code) {
  const data = await api('/api/sessions', {
    method: 'POST',
    body: JSON.stringify({ worker: `${worker}(${username})`, boxQr: code }),
  });
  session = data;
  scanMode = 'product';
  soundInfo();
  showFlash('info', '📦', '상자 등록', `품번 ${data.partNo}${data.targetQty ? ` · 수량 ${data.targetQty}` : ''}`, 1500);
  $('scan-title').textContent = '제품 바코드를 스캔하세요';
  $('session-info').classList.remove('hidden');
  $('btn-end-session').classList.remove('hidden');
  $('info-part').textContent = data.partNo;
  $('count-ok').textContent = '0';
  $('count-ng').textContent = '0';
  $('count-target').textContent = data.targetQty ?? '-';
  $('scan-log').innerHTML = '';
}

async function handleProductScan(code) {
  const data = await api(`/api/sessions/${session.id}/scan`, {
    method: 'POST',
    body: JSON.stringify({ barcode: code }),
  });
  $('count-ok').textContent = data.okCount;
  $('count-ng').textContent = data.ngCount;

  if (data.result === 'OK') {
    soundOK();
    showFlash('ok', '✅', 'OK', `${data.productPartNo} 일치 (${data.okCount}${data.targetQty ? '/' + data.targetQty : ''})`, 1000);
  } else {
    soundNG();
    showFlash('ng', '🚫', '이종!', `제품 ${data.productPartNo} ≠ 상자 ${data.boxPartNo}`, 3000);
  }
  addLog(data.result, code);

  // 목표 수량 도달 시 알림
  if (data.targetQty && data.okCount >= data.targetQty) {
    setTimeout(() => {
      soundInfo();
      showFlash('info', '📦', '수량 도달', `OK ${data.okCount}/${data.targetQty} — 적입 완료 버튼을 눌러 마감하세요`, 2500);
    }, 1100);
  }
}

function addLog(result, code) {
  const li = document.createElement('li');
  const time = new Date().toLocaleTimeString('ko-KR', { hour12: false });
  li.innerHTML = `<span>${time} · ${escapeHtml(code)}</span><span class="badge ${result.toLowerCase()}">${result}</span>`;
  $('scan-log').prepend(li);
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// ===== 화면 전환 =====
$('btn-start-box').onclick = async () => {
  session = null;
  scanMode = 'box';
  $('scan-title').textContent = '상자 QR을 스캔하세요';
  $('session-info').classList.add('hidden');
  $('btn-end-session').classList.add('hidden');
  $('scan-log').innerHTML = '';
  show('screen-scan');
  try {
    await startScanner();
  } catch (e) {
    let msg = e && e.message ? e.message : String(e);
    if (e && e.name === 'NotAllowedError') {
      msg = '카메라 권한이 거부되었습니다.\n브라우저 주소창의 자물쇠(🔒) 아이콘 → 권한 → 카메라 허용 후 새로고침해 주세요.';
    } else if (e && e.name === 'NotFoundError') {
      msg = '사용 가능한 카메라를 찾을 수 없습니다.';
    } else if (e && e.name === 'NotReadableError') {
      msg = '다른 앱이 카메라를 사용 중입니다. 카메라를 쓰는 앱을 종료한 뒤 다시 시도해 주세요.';
    }
    alert('카메라를 시작할 수 없습니다.\n\n' + msg + '\n\n(수동 입력은 계속 사용할 수 있습니다)');
  }
};

$('btn-scan-back').onclick = async () => {
  await stopScanner();
  show('screen-home');
};

$('btn-end-session').onclick = async () => {
  if (!session) return;
  try {
    const s = await api(`/api/sessions/${session.id}/end`, { method: 'POST' });
    soundInfo();
    await stopScanner();
    alert(`상자 마감 완료\n품번: ${s.part_no}\nOK: ${s.ok_count} / NG: ${s.ng_count}`);
    show('screen-home');
  } catch (e) {
    alert(e.message);
  }
};

$('btn-manual').onclick = () => {
  const code = $('manual-code').value.trim();
  if (!code) return;
  $('manual-code').value = '';
  handleCode(code);
};
$('manual-code').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); $('btn-manual').click(); }
});

// ===== 이종검사 내역 =====
$('btn-history').onclick = () => { show('screen-history'); loadHistory(); };
$('btn-history-back').onclick = () => show('screen-home');
$('btn-detail-back').onclick = () => show('screen-history');
$('btn-filter').onclick = loadHistory;

async function loadHistory() {
  const list = $('history-list');
  list.innerHTML = '<div class="empty">불러오는 중...</div>';
  try {
    const params = new URLSearchParams();
    const date = $('filter-date').value;
    if (date) {
      // 로컬(한국) 날짜 기준 하루를 UTC 범위로 변환
      const from = new Date(`${date}T00:00:00`);
      const to = new Date(`${date}T23:59:59.999`);
      params.set('from', from.toISOString());
      params.set('to', to.toISOString());
    }
    const w = $('filter-worker').value.trim();
    if (w) params.set('worker', w);
    const sessions = await api(`/api/sessions?${params}`);
    if (sessions.length === 0) {
      list.innerHTML = '<div class="empty">내역이 없습니다.</div>';
      return;
    }
    list.innerHTML = '';
    sessions.forEach((s) => {
      const card = document.createElement('div');
      card.className = 'session-card' + (s.ng_count > 0 ? ' has-ng' : '');
      card.innerHTML = `
        <div class="row1">
          <span>${escapeHtml(s.part_no)}</span>
          <span><span class="stat-ok">OK ${s.ok_count}</span> / <span class="stat-ng">NG ${s.ng_count}</span></span>
        </div>
        <div class="row2">
          <span>${escapeHtml(s.worker)}</span>
          <span>${fmtTime(s.started_at)}${s.ended_at ? '' : ' · 진행중'}</span>
        </div>`;
      card.onclick = () => loadDetail(s.id);
      list.appendChild(card);
    });
  } catch (e) {
    list.innerHTML = `<div class="empty">${escapeHtml(e.message)}</div>`;
  }
}

async function loadDetail(id) {
  show('screen-detail');
  $('detail-summary').innerHTML = '불러오는 중...';
  $('detail-scans').innerHTML = '';
  try {
    const { session: s, scans } = await api(`/api/sessions/${id}/scans`);
    $('detail-summary').innerHTML = `
      품번: <b>${escapeHtml(s.part_no)}</b><br>
      작업자: ${escapeHtml(s.worker)}<br>
      상자 QR: ${escapeHtml(s.box_qr)}<br>
      시작: ${fmtTime(s.started_at)} · 종료: ${fmtTime(s.ended_at)}<br>
      결과: <span class="stat-ok">OK ${s.ok_count}</span> / <span class="stat-ng">NG ${s.ng_count}</span>
      ${s.target_qty ? ` (목표 ${s.target_qty})` : ''}`;
    const wrap = $('detail-scans');
    if (scans.length === 0) {
      wrap.innerHTML = '<div class="empty">스캔 기록이 없습니다.</div>';
      return;
    }
    scans.forEach((sc) => {
      const row = document.createElement('div');
      row.className = 'scan-row';
      row.innerHTML = `
        <span>${fmtTime(sc.scanned_at)}<br>${escapeHtml(sc.barcode)}</span>
        <span class="badge ${sc.result.toLowerCase()}">${sc.result}</span>`;
      wrap.appendChild(row);
    });
  } catch (e) {
    $('detail-summary').innerHTML = escapeHtml(e.message);
  }
}

// ===== 초기 진입 =====
if (worker && username) enterHome();
else show('screen-login');
