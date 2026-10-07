import { createClient } from "npm:@supabase/supabase-js@2";

const MODEL = "nvidia/nemotron-3-ultra-550b-a55b:free";
const TIMEOUT_MS = 20_000;
const SYSTEM_PROMPT =
  "너는 방명록에 답글을 다는 친절한 도우미야. 방문자의 글에 한국어로 1~2문장, 300자 이내의 따뜻한 답글만 써. 설명이나 머리말 없이 답글 본문만 출력해.";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, "Content-Type": "application/json" },
  });

const db = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
);

class AiError extends Error {}

async function askAi(name: string, message: string): Promise<string> {
  const key = Deno.env.get("OPENROUTER_API_KEY");
  if (!key) throw new AiError("서버에 AI 키가 설정되어 있지 않아요.");

  let res: Response;
  try {
    res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 1000,
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: `이름: ${name}\n글: ${message}` },
        ],
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (e) {
    if (e instanceof DOMException && (e.name === "TimeoutError" || e.name === "AbortError")) {
      throw new AiError("AI 응답이 너무 오래 걸려 중단했어요.");
    }
    throw new AiError("AI 서버에 연결하지 못했어요.");
  }

  if (!res.ok) {
    console.error("openrouter error", res.status, (await res.text()).slice(0, 500));
    if (res.status === 401 || res.status === 403) throw new AiError("AI 키 인증에 실패했어요.");
    if (res.status === 404) throw new AiError("AI 모델을 사용할 수 없어요.");
    if (res.status === 400) throw new AiError("이 모델은 답글 생성에 쓸 수 없어요.");
    if (res.status === 429) throw new AiError("AI 요청 한도를 넘었어요. 잠시 후 다시 시도해 주세요.");
    throw new AiError(`AI 서버 오류가 났어요 (${res.status}).`);
  }

  const data = await res.json().catch(() => null);
  // OpenRouter는 오류를 HTTP 200 + 본문 { error } 로 줄 때가 있다.
  if (data?.error) {
    const code = Number(data.error.code);
    console.error("openrouter body error", JSON.stringify(data.error).slice(0, 500));
    if (code === 429) throw new AiError("AI 요청 한도를 넘었어요. 잠시 후 다시 시도해 주세요.");
    throw new AiError("AI 서버가 오류를 돌려줬어요" + (code ? ` (${code})` : "") + ".");
  }
  const text = data?.choices?.[0]?.message?.content;
  if (typeof text !== "string" || !text.trim()) {
    console.error("empty reply", JSON.stringify({
      topKeys: data ? Object.keys(data) : null,
      finish: data?.choices?.[0]?.finish_reason,
    }));
    throw new AiError("AI가 빈 응답을 보냈어요.");
  }
  return text.trim().slice(0, 300);
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  if (req.method !== "POST") return json({ error: "POST만 지원해요." }, 405);

  const body = await req.json().catch(() => null);
  const id = body?.id;
  if (typeof id !== "string" || !UUID.test(id)) return json({ error: "잘못된 id예요." }, 400);

  const { data: entry, error: readErr } = await db
    .from("guestbook_entries")
    .select("id, name, message, ai_reply, ai_error")
    .eq("id", id)
    .maybeSingle();
  if (readErr) {
    console.error("read error", readErr.message);
    return json({ error: "글을 읽지 못했어요." }, 500);
  }
  if (!entry) return json({ error: "글을 찾을 수 없어요." }, 404);
  if (entry.ai_reply || entry.ai_error) return json({ error: "이미 처리된 글이에요." }, 409);

  let reply: string | null = null;
  let failure: string | null = null;
  try {
    reply = await askAi(entry.name, entry.message);
  } catch (e) {
    failure = e instanceof AiError ? e.message : "알 수 없는 오류가 났어요.";
    if (!(e instanceof AiError)) console.error(e);
  }

  const { error: writeErr } = await db
    .from("guestbook_entries")
    .update(reply ? { ai_reply: reply } : { ai_error: failure })
    .eq("id", id)
    .is("ai_reply", null)
    .is("ai_error", null);
  if (writeErr) {
    console.error("write error", writeErr.message);
    return json({ error: "결과를 저장하지 못했어요." }, 500);
  }

  return reply ? json({ ai_reply: reply }) : json({ error: failure });
});
