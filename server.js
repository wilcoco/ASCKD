const express = require('express');
const path = require('path');
const crypto = require('crypto');
const { query, init, usePg } = require('./db');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
// 바코드 디코더(폴리필 + wasm)를 CDN 대신 자체 서버에서 서빙 (인앱 브라우저/CDN 차단 대응)
app.use('/vendor', express.static(path.join(__dirname, 'node_modules/barcode-detector/dist/es'), { maxAge: '7d' }));
app.use('/vendor', express.static(path.join(__dirname, 'node_modules/zxing-wasm/dist/reader'), { maxAge: '7d' }));

const now = () => new Date().toISOString();
const normalize = (s) => String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '');

// 상자 식별표 QR 예: CPYB2LF7004 866A5P1630 000008 9268RUUUC00SEF9
//  - 12~21번째 자리(정규화 후 index 11..20)가 품번 10자리
//  - 그 다음 6자리가 수량(예: 000008 → 8)
function parseBoxQr(raw) {
  const norm = normalize(raw);
  if (norm.length < 21) return null;
  const partNo = norm.substring(11, 21);
  let qty = parseInt(norm.substring(21, 27), 10);
  if (!Number.isFinite(qty) || qty <= 0 || qty > 9999) qty = null;
  return { norm, partNo, qty };
}

// 제품 바코드 예: NQPERRUPRSVMLH#866A5-P1630 → 특수문자 제거 후 끝 10자리 = 866A5P1630
function parseProduct(raw) {
  const norm = normalize(raw);
  if (norm.length < 10) return null;
  return { norm, partNo: norm.slice(-10) };
}

app.get('/api/health', (req, res) => res.json({ ok: true, db: usePg ? 'postgres' : 'sqlite' }));

// 비밀번호 해시 (scrypt, salt:hash 형식)
function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${hash}`;
}
function verifyPassword(password, stored) {
  const [salt, hash] = String(stored).split(':');
  if (!salt || !hash) return false;
  const candidate = crypto.scryptSync(password, salt, 64).toString('hex');
  return crypto.timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(candidate, 'hex'));
}

// 회원가입: 이름 + 아이디 + 비밀번호
app.post('/api/register', async (req, res) => {
  try {
    const name = String(req.body.name || '').trim();
    const username = String(req.body.username || '').trim();
    const password = String(req.body.password || '');
    if (!name || !username || !password) {
      return res.status(400).json({ error: '이름, 아이디, 비밀번호를 모두 입력하세요.' });
    }
    if (password.length < 4) return res.status(400).json({ error: '비밀번호는 4자 이상이어야 합니다.' });
    const existing = await query('SELECT id FROM workers WHERE username = $1', [username]);
    if (existing.length > 0) return res.status(409).json({ error: '이미 사용 중인 아이디입니다.' });
    await query(
      'INSERT INTO workers (username, name, password_hash, created_at) VALUES ($1, $2, $3, $4)',
      [username, name, hashPassword(password), now()]
    );
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: '서버 오류' });
  }
});

// 로그인: 아이디 + 비밀번호 → 로그인 기록 저장
app.post('/api/login', async (req, res) => {
  try {
    const username = String(req.body.username || '').trim();
    const password = String(req.body.password || '');
    if (!username || !password) return res.status(400).json({ error: '아이디와 비밀번호를 입력하세요.' });
    const rows = await query('SELECT * FROM workers WHERE username = $1', [username]);
    if (rows.length === 0 || !verifyPassword(password, rows[0].password_hash)) {
      return res.status(401).json({ error: '아이디 또는 비밀번호가 올바르지 않습니다.' });
    }
    const name = rows[0].name;
    await query('INSERT INTO logins (worker, logged_in_at) VALUES ($1, $2)', [`${name}(${username})`, now()]);
    res.json({ ok: true, worker: name, username });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: '서버 오류' });
  }
});

// 상자 QR 스캔 → 작업 세션 시작
app.post('/api/sessions', async (req, res) => {
  try {
    const worker = String(req.body.worker || '').trim();
    const boxQr = String(req.body.boxQr || '').trim();
    if (!worker) return res.status(400).json({ error: '작업자 정보가 없습니다.' });
    const parsed = parseBoxQr(boxQr);
    if (!parsed) return res.status(400).json({ error: '상자 QR 형식을 인식할 수 없습니다.' });
    const rows = await query(
      `INSERT INTO sessions (worker, box_qr, part_no, target_qty, started_at)
       VALUES ($1, $2, $3, $4, $5) RETURNING id`,
      [worker, boxQr, parsed.partNo, parsed.qty, now()]
    );
    res.json({ id: rows[0].id, partNo: parsed.partNo, targetQty: parsed.qty });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: '서버 오류' });
  }
});

// 제품 바코드 스캔 → 이종 판정 + 기록
app.post('/api/sessions/:id/scan', async (req, res) => {
  try {
    const id = Number(req.params.id);
    const barcode = String(req.body.barcode || '').trim();
    const sessions = await query('SELECT * FROM sessions WHERE id = $1', [id]);
    if (sessions.length === 0) return res.status(404).json({ error: '세션을 찾을 수 없습니다.' });
    const session = sessions[0];
    if (session.ended_at) return res.status(400).json({ error: '이미 종료된 세션입니다.' });

    const parsed = parseProduct(barcode);
    if (!parsed) return res.status(400).json({ error: '제품 바코드를 인식할 수 없습니다.' });

    const result = parsed.partNo === session.part_no ? 'OK' : 'NG';
    await query(
      `INSERT INTO scans (session_id, worker, barcode, part_no, result, scanned_at)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [id, session.worker, barcode, parsed.partNo, result, now()]
    );
    const col = result === 'OK' ? 'ok_count' : 'ng_count';
    await query(`UPDATE sessions SET ${col} = ${col} + 1 WHERE id = $1`, [id]);
    const updated = await query('SELECT ok_count, ng_count, target_qty FROM sessions WHERE id = $1', [id]);
    res.json({
      result,
      productPartNo: parsed.partNo,
      boxPartNo: session.part_no,
      okCount: updated[0].ok_count,
      ngCount: updated[0].ng_count,
      targetQty: updated[0].target_qty,
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: '서버 오류' });
  }
});

// 세션(상자 작업) 종료
app.post('/api/sessions/:id/end', async (req, res) => {
  try {
    const id = Number(req.params.id);
    await query('UPDATE sessions SET ended_at = $1 WHERE id = $2 AND ended_at IS NULL', [now(), id]);
    const rows = await query('SELECT * FROM sessions WHERE id = $1', [id]);
    if (rows.length === 0) return res.status(404).json({ error: '세션을 찾을 수 없습니다.' });
    res.json(rows[0]);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: '서버 오류' });
  }
});

// 이종검사 내역: 세션 목록 (날짜/작업자 필터)
app.get('/api/sessions', async (req, res) => {
  try {
    const conds = [];
    const params = [];
    if (req.query.date) {
      // 클라이언트가 KST 기준 하루의 UTC 범위를 계산해 보냄 (from, to ISO)
      params.push(req.query.from || `${req.query.date}T00:00:00`);
      conds.push(`started_at >= $${params.length}`);
      params.push(req.query.to || `${req.query.date}T23:59:59.999Z`);
      conds.push(`started_at <= $${params.length}`);
    } else {
      if (req.query.from) { params.push(req.query.from); conds.push(`started_at >= $${params.length}`); }
      if (req.query.to) { params.push(req.query.to); conds.push(`started_at <= $${params.length}`); }
    }
    if (req.query.worker) {
      params.push(req.query.worker);
      conds.push(`worker = $${params.length}`);
    }
    const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';
    const limit = Math.min(Number(req.query.limit) || 100, 500);
    const rows = await query(
      `SELECT * FROM sessions ${where} ORDER BY id DESC LIMIT ${limit}`,
      params
    );
    res.json(rows);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: '서버 오류' });
  }
});

// 세션별 스캔 상세 내역
app.get('/api/sessions/:id/scans', async (req, res) => {
  try {
    const id = Number(req.params.id);
    const sessions = await query('SELECT * FROM sessions WHERE id = $1', [id]);
    if (sessions.length === 0) return res.status(404).json({ error: '세션을 찾을 수 없습니다.' });
    const scans = await query('SELECT * FROM scans WHERE session_id = $1 ORDER BY id ASC', [id]);
    res.json({ session: sessions[0], scans });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: '서버 오류' });
  }
});

app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

const PORT = process.env.PORT || 3000;
init()
  .then(() => {
    app.listen(PORT, () => console.log(`이종검사 서버 시작: http://localhost:${PORT} (DB: ${usePg ? 'PostgreSQL' : 'SQLite'})`));
  })
  .catch((e) => {
    console.error('DB 초기화 실패:', e);
    process.exit(1);
  });
