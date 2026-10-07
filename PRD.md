# PRD — AI 답글 방명록

## 1. 한 줄 요약
이름과 한 줄 글을 남기면 AI가 짧은 답글을 달아 주는 방명록 웹앱. 3단계(저장 → AI 답글 → 다듬기)로 나누어 만든다.

## 2. 기술 구성
| 영역 | 선택 |
|---|---|
| 화면 | `index.html` 한 개 (HTML + CSS + JS, npm/빌드 없음) |
| 라이브러리 | `@supabase/supabase-js` v2를 CDN `<script>`로 로드 (jsdelivr) |
| DB | Supabase Postgres, 새 표 `guestbook_entries` |
| AI 호출 | Supabase Edge Function `ai-reply` (Deno), **`verify_jwt = false`** |
| AI 모델 | OpenRouter `nvidia/nemotron-3.5-content-safety:free` |
| 비밀 키 | `OPENROUTER_API_KEY` — 이미 Supabase Secrets에 있음. 코드·저장소·HTML 어디에도 쓰지 않는다 |

브라우저에 들어가는 값은 Supabase 프로젝트 URL과 **publishable(anon) 키**뿐이다. 이 키는 공개돼도 되도록 설계된 키이고, 권한은 RLS로 제한한다.

## 3. 정한 사항 (요청에 없어 내가 정한 것)
- 표 이름 `guestbook_entries`. 기존 표는 건드리지 않는다.
- 이름 1~20자, 글 1~200자(공백만은 불가). 서버(DB CHECK)와 화면 양쪽에서 검사한다.
- 로그인 없음. 누구나 쓰고 읽을 수 있다.
- 수정·삭제 기능 없음 (방명록은 쓰기/읽기만).
- 목록은 최신 글 먼저, 최근 50개. 페이지 넘김 없음.
- 브라우저는 표에 **INSERT와 SELECT만** 가능. AI 답글 컬럼 UPDATE는 Edge Function(service role)만 한다.
- 글 내용은 클라이언트가 함수로 보내지 않고, 함수가 **글 id로 DB에서 읽어** 온다 (조작 방지).
- 답글 생성은 `ai_reply`와 `ai_error`가 둘 다 비어 있는 글에만 1회 허용한다 (중복 호출로 비용 낭비 방지).
- AI 답글은 한국어, 1~2문장, 따뜻하고 짧게, 최대 300자. 시스템 프롬프트로 지시한다.
- OpenRouter 호출 제한 시간 20초, `max_tokens` 200.
- 모델 ID는 Edge Function 맨 위의 상수 한 곳에만 둔다.

## 4. 데이터 모델
표 `public.guestbook_entries`

| 컬럼 | 타입 | 설명 |
|---|---|---|
| `id` | uuid, PK, default `gen_random_uuid()` | |
| `name` | text, NOT NULL, CHECK 길이 1~20 | 작성자 이름 |
| `message` | text, NOT NULL, CHECK 길이 1~200 | 한 줄 글 |
| `ai_reply` | text, NULL | AI 답글 (2단계~) |
| `ai_error` | text, NULL | AI 실패 이유 (2단계~) |
| `created_at` | timestamptz, NOT NULL, default `now()` | 정렬 기준, 인덱스 `created_at desc` |

RLS 켬. 정책: `anon`·`authenticated`에 SELECT 허용, INSERT 허용(`ai_reply`, `ai_error`는 NULL일 때만). UPDATE/DELETE 정책 없음.

## 5. 단계별 요구사항

### 1단계 — 글 저장과 목록
- 이름 입력, 글 입력(textarea 아님, 한 줄 `input`), 글자 수 카운터 `0/200`, 보내기 버튼.
- 보내기 → `guestbook_entries`에 INSERT → 성공하면 입력칸(글)만 비우고 목록 맨 위에 반영.
- 목록은 `created_at` 내림차순. 각 항목에 이름, 글, 작성 시각.
- 빈 값·길이 초과는 보내기 전에 막고 안내 문구 표시.
- DB 오류 시 화면에 오류 문구 표시 (글은 입력칸에 유지).
- 글/이름은 `textContent`로 출력한다 (XSS 방지, `innerHTML` 금지).

**완료 기준**: 글을 쓰면 새로고침 후에도 최신 글이 맨 위에 보인다. 201자는 입력되지 않는다. Supabase에 행이 실제로 생긴다.

### 2단계 — AI 답글
- 1단계 INSERT 성공 직후, 화면은 새 글의 `id`로 Edge Function `ai-reply`를 호출한다.
- 함수 동작:
  1. `id`로 글을 읽는다. 없거나 이미 `ai_reply`/`ai_error`가 있으면 거절(4xx).
  2. `OPENROUTER_API_KEY`(Secrets)로 `https://openrouter.ai/api/v1/chat/completions` 호출.
  3. 성공하면 `ai_reply` 저장, 실패하면 `ai_error`에 사람이 읽을 수 있는 이유 저장.
  4. 결과를 JSON으로 반환 (`{ ai_reply }` 또는 `{ error }`).
- **AI가 실패해도 글은 이미 저장돼 있다.** 화면은 글을 그대로 보여 주고, 실패 이유를 그 글 아래에 표시한다.
- 실패 이유 예: 키 없음/인증 실패, 요청 한도 초과(429), 모델 사용 불가, 시간 초과, 빈 응답. 내부 상세(키, 스택)는 노출하지 않는다.
- 함수는 `verify_jwt = false`로 배포한다. 대신 위의 id 검증, 1회 제한, CORS로 남용을 줄인다.
- 목록에는 `ai_reply`가 있으면 답글 말풍선, `ai_error`가 있으면 오류 문구를 표시한다.

**완료 기준**: 글을 쓰면 몇 초 안에 AI 답글이 붙고 새로고침해도 유지된다. 잘못된 모델 ID로 바꿔 배포하면 글은 남고 실패 이유가 보인다.

### 3단계 — 대기 표시와 화면 다듬기
- AI 답글을 기다리는 동안 해당 글 아래에 **“AI가 쓰는 중…”** (점 애니메이션) 표시. 보내기 버튼은 전송 중에만 비활성화하고, 답글을 기다리는 중에도 다른 글은 쓸 수 있다.
- 새로고침 시 `ai_reply`와 `ai_error`가 둘 다 비어 있고 작성 후 60초 이내인 글은 “AI가 쓰는 중…”으로 보인다 (60초가 지나도 비어 있으면 “답글이 없습니다” 표시).
- 디자인: 중앙 정렬 단일 칼럼(최대폭 560px), 카드형 글 + 말풍선형 AI 답글, 모바일(≥360px) 대응, 밝은/어두운 모드(`prefers-color-scheme`), 포커스 링과 `aria-live` 로 접근성 확보, 글이 없을 때 빈 상태 문구.
- 시각은 “방금 / 3분 전 / 날짜” 식 상대 표기.

**완료 기준**: 느린 응답에서도 “AI가 쓰는 중…”이 보였다가 답글로 바뀐다. 모바일 폭에서 가로 스크롤이 없다.

## 6. 범위 밖
로그인, 글 수정·삭제, 신고·관리자 화면, 무한 스크롤, 실시간 구독(Realtime), 배포 호스팅 설정.

## 7. 위험과 대응
| 위험 | 대응 |
|---|---|
| **지정 모델은 콘텐츠 안전 분류용(content-safety)이라, 일반 대화 답글 대신 `safe`/`unsafe` 같은 판정문만 돌려줄 수 있다.** 모델 존재 여부와 `:free` 제공 여부도 확인 필요 | 2단계 첫 작업으로 curl 실호출로 확인한다. 답글 형태가 나오지 않으면 사용자에게 알리고 모델 상수만 교체(예: 다른 `:free` 대화 모델)하도록 한다. 임의로 바꾸지는 않는다 |
| verify_jwt 꺼짐 → 누구나 함수 호출 가능 | 글 id 필수, 글당 1회, 길이 제한, service role은 함수 안에서만 사용 |
| 무료 모델 한도(429) | 실패 이유로 표시, 글은 보존 |
| 스팸 글 | 이번 범위 밖. 이후 과제로 기록 |
| 키 유출 | 키는 Secrets에만. HTML에는 publishable 키만 |
