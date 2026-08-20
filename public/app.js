// ===== 상태 =====
let worker = localStorage.getItem('worker') || '';
let username = localStorage.getItem('username') || '';
let session = null;          // { id, partNo, targetQty }
let scanMode = 'box';        // 'box' | 'product'
let scanner = null;          // Html5Qrcode 인스턴스
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
const SCAN_FORMATS = [
  Html5QrcodeSupportedFormats.QR_CODE,
  Html5QrcodeSupportedFormats.DATA_MATRIX,
  Html5QrcodeSupportedFormats.CODE_128,
  Html5QrcodeSupportedFormats.CODE_39,
  Html5QrcodeSupportedFormats.EAN_13,
];

async function startScanner() {
  if (scannerRunning) return;
  if (!scanner) scanner = new Html5Qrcode('reader', { formatsToSupport: SCAN_FORMATS, verbose: false });
  await scanner.start(
    { facingMode: 'environment' },
    { fps: 10, qrbox: (w, h) => ({ width: Math.floor(w * 0.8), height: Math.floor(Math.min(h, w) * 0.5) }) },
    onScanSuccess,
    () => {} // 프레임별 인식 실패는 무시
  );
  scannerRunning = true;
}

async function stopScanner() {
  if (scanner && scannerRunning) {
    try { await scanner.stop(); } catch (e) {}
    scannerRunning = false;
  }
}

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
    alert('카메라를 시작할 수 없습니다. 카메라 권한을 허용해 주세요.\n' + e);
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
