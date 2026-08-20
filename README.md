# ASCKD 이종검사 시스템

제품 바코드와 납입상자 식별표 QR을 대조하여 오적입(이종)을 방지하는 모바일 웹 시스템.

## 동작 방식

1. **로그인** — 작업자가 아이디/비밀번호로 로그인 (회원가입: 이름 + 아이디 + 비밀번호)
2. **상자 QR 스캔** — 납입상자 식별표의 QR(DataMatrix)을 카메라로 스캔 → 품번 추출, 작업 세션 시작
3. **제품 바코드 스캔** — 적입하는 제품마다 바코드를 스캔 → 상자 품번과 대조
   - 일치: ✅ OK (짧은 비프음)
   - 불일치: 🚫 이종! (경고음 + 진동 + 빨간 화면)
4. **적입 완료** — 상자 마감, 일시/수량/OK/NG 기록 저장
5. **이종검사 내역** — 날짜·작업자별 세션 목록과 스캔 상세 조회

## 매칭 로직

- 상자 QR 예: `CPYB2LF7004` **`866A5P1630`** `000008` `9268RUUUC00SEF9`
  - 특수문자 제거 후 12~21번째 자리 = 품번 10자리, 이어지는 6자리 = 수량
- 제품 바코드 예: `NQPERRUPRSVMLH#` **`866A5-P1630`**
  - 특수문자(`#`, `-`) 제거 후 **끝 10자리** = 품번
- 두 품번이 같으면 OK, 다르면 NG(이종)

## 로컬 실행

```bash
npm install
npm start
# http://localhost:3000
```

DB: `DATABASE_URL` 환경변수가 있으면 PostgreSQL, 없으면 로컬 SQLite(`data.db`) 자동 사용.

> 휴대폰 카메라는 HTTPS에서만 동작합니다. 로컬 테스트는 PC 브라우저 또는 수동 입력을 사용하세요. Railway 배포 후에는 HTTPS가 기본 제공되어 카메라가 동작합니다.

## Railway 배포

1. GitHub에 이 저장소를 push
2. [Railway](https://railway.app) → **New Project** → **Deploy from GitHub repo** → 이 저장소 선택
3. 같은 프로젝트에 **PostgreSQL 추가**: `+ New` → `Database` → `PostgreSQL`
4. 앱 서비스 → **Variables** → `DATABASE_URL` = `${{Postgres.DATABASE_URL}}` (Reference 변수로 연결)
5. **Settings → Networking → Generate Domain** 으로 공개 URL 생성
6. 휴대폰에서 해당 URL 접속 → 회원가입/로그인 → 카메라 권한 허용 → 사용

## API

| 메서드 | 경로 | 설명 |
|---|---|---|
| POST | `/api/register` | 회원가입 (name, username, password) |
| POST | `/api/login` | 로그인 (username, password) — 로그인 기록 저장 |
| POST | `/api/sessions` | 상자 QR 스캔, 세션 시작 |
| POST | `/api/sessions/:id/scan` | 제품 바코드 스캔, OK/NG 판정 |
| POST | `/api/sessions/:id/end` | 상자 마감 |
| GET | `/api/sessions` | 세션 목록 (from/to/worker 필터) |
| GET | `/api/sessions/:id/scans` | 세션별 스캔 상세 |

## DB 테이블

- `workers` — 작업자 계정 (username, name, password_hash)
- `logins` — 로그인 기록 (작업자, 일시)
- `sessions` — 상자 단위 작업 (작업자, 상자 QR, 품번, 목표수량, OK/NG 수량, 시작/종료 일시)
- `scans` — 개별 제품 스캔 기록 (바코드, 품번, OK/NG, 일시)
