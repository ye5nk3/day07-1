# STEPS — 구현 순서

PRD.md의 3단계를 그대로 따른다. 각 단계는 끝에 확인 항목을 통과해야 다음으로 넘어간다.

## 준비 (한 번만)
- [ ] 사용할 Supabase 프로젝트 확인 (프로젝트 URL, publishable 키 확보)
- [ ] Secrets에 `OPENROUTER_API_KEY`가 있는지 이름만 확인 (값은 읽거나 출력하지 않음)
- [ ] 파일 구성
  ```
  index.html
  supabase/migrations/<시각>_create_guestbook_entries.sql
  supabase/functions/ai-reply/index.ts
  supabase/config.toml        # [functions.ai-reply] verify_jwt = false
  ```

## 1단계 — 글 저장과 목록
1. **표 만들기** (마이그레이션)
   - `guestbook_entries` 생성: `id, name, message, ai_reply, ai_error, created_at`
   - CHECK: `char_length(btrim(name)) between 1 and 20`, `char_length(btrim(message)) between 1 and 200`
   - 인덱스 `created_at desc`
   - RLS 켜기, anon/authenticated에 SELECT 정책, INSERT 정책(`ai_reply is null and ai_error is null`)
2. **index.html 기본 틀**
   - supabase-js CDN 로드, `SUPABASE_URL`/`SUPABASE_KEY`(publishable) 상수
   - 이름 `input`, 글 `input`(maxlength 200), 카운터, 보내기 버튼, 목록 영역
3. **동작**
   - 로드 시 `select * order by created_at desc limit 50`
   - 보내기: 검사 → insert → 성공 시 글 칸 비우고 목록 맨 위에 추가, 실패 시 오류 문구
   - 출력은 `textContent`만 사용
4. **확인**
   - [ ] 글 작성 → 새로고침 후에도 최신 글이 맨 위
   - [ ] 빈 값 / 201자 차단
   - [ ] `list_tables`/SQL로 행 생성 확인
   - [ ] Supabase 보안 어드바이저에 RLS 경고 없음

## 2단계 — AI 답글
1. **모델 사전 확인** (키는 터미널에 노출하지 않고 함수 안에서만 사용)
   - 함수를 먼저 배포해 `nvidia/nemotron-3-ultra-550b-a55b:free`가 실제로 답글 문장을 돌려주는지 확인
   - 판정문만 오거나 모델이 없거나(404)·채팅용이 아니면(400) **여기서 멈추고 사용자에게 알린다**
2. **Edge Function `ai-reply` 작성**
   - 맨 위 상수 `MODEL = "nvidia/nemotron-3-ultra-550b-a55b:free"`
   - 입력 `{ id }` 검증(uuid) → service role 클라이언트로 글 조회 → 이미 답글/오류 있으면 409
   - OpenRouter 호출: `Authorization: Bearer ${Deno.env.get("OPENROUTER_API_KEY")}`, 시스템 프롬프트(한국어 1~2문장, 따뜻하게, 300자 이내), 사용자 메시지 = `이름: …\n글: …`, `max_tokens` 1000, `AbortSignal.timeout(20000)`
   - 성공 → `ai_reply` UPDATE, 실패 → 이유를 `ai_error`에 UPDATE (키·스택 제외)
   - 응답 JSON + CORS 헤더(`OPTIONS` 처리 포함)
3. **배포**: `verify_jwt: false`로 배포 (`config.toml`에도 기록)
4. **화면 연결**
   - INSERT 성공 후 `fetch(<프로젝트 URL>/functions/v1/ai-reply, {method:"POST", body:{id}})`
   - 응답으로 해당 글 항목 갱신. 실패면 글은 그대로 두고 실패 이유 표시
   - 목록 렌더링에 `ai_reply` 말풍선 / `ai_error` 문구 추가
5. **확인**
   - [ ] 글 작성 → 답글이 붙고 새로고침 후에도 유지
   - [ ] 모델 ID를 일부러 틀리게 배포 → 글 저장 + 실패 이유 표시 → 원래 값으로 복구
   - [ ] 같은 id로 함수를 다시 호출하면 409
   - [ ] 소스·로그 어디에도 API 키 문자열 없음 (`grep sk-or`)
   - [ ] 함수 로그에 오류 없음 (`query_logs`)

## 3단계 — 대기 표시와 화면 다듬기
1. **대기 표시**: 함수 호출 중인 글 아래 “AI가 쓰는 중…” + 점 애니메이션, 응답이 오면 답글/오류로 교체
2. **새로고침 대응**: 답글·오류가 모두 없고 60초 이내면 “AI가 쓰는 중…”, 이후엔 “답글이 없습니다”
3. **스타일**: 560px 단일 칼럼, 카드 + 말풍선, CSS 변수로 라이트/다크, 모바일 폭, 포커스 링, `aria-live="polite"`, 빈 상태 문구, 상대 시각 표기
4. **확인**
   - [ ] 응답이 느려도 대기 문구가 보였다가 답글로 바뀜
   - [ ] 모바일 폭(375px)에서 가로 스크롤 없음, 다크 모드 가독성 OK
   - [ ] 1·2단계 확인 항목 재통과 (회귀 점검)

## 마무리
- [ ] 브라우저에서 처음부터 끝까지 한 번 실행해 보기 (글 작성 → 대기 → 답글 → 새로고침)
- [ ] 남은 위험(스팸, 무료 모델 한도) 결과 보고에 기록
