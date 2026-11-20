import { GEMINI_API_KEY, GEMINI_CHAT_MODEL } from "./config";
import { toRequestJson } from "./util";
import type { InputContent, InputItem, ResponseOutputItem, ResponsesResult, ResponseTool } from "./xai";

// ──────────────────────────────────────────────────────────
// Gemini（会話の安い担当。Grok の Responses API と同じ形で使えるようにする）
// 入力・キャッシュ・出力の 100 万トークンあたりのドル（Grok 4.20 は $1.25・$0.20・$2.50）。
// 3.1 Flash-Lite は他の人同士の会話に割り込む（[SKIP] できない）ので 3.5 Flash-Lite を使う
// ──────────────────────────────────────────────────────────
const PRICES: Record<string, [number, number, number]> = {
  "gemini-3.5-flash-lite": [0.3, 0.03, 2.5],
  "gemini-3.1-flash-lite": [0.25, 0.025, 1.5],
};
const [inputPrice, cachedPrice, outputPrice] = (PRICES[GEMINI_CHAT_MODEL] ?? PRICES["gemini-3.5-flash-lite"]).map(
  (usd) => usd / 1e6,
);
const PRICE_PER_TOKEN = { input: inputPrice, cached: cachedPrice, output: outputPrice };
const SAFETY_CATEGORIES = [
  "HARM_CATEGORY_HARASSMENT",
  "HARM_CATEGORY_HATE_SPEECH",
  "HARM_CATEGORY_SEXUALLY_EXPLICIT",
  "HARM_CATEGORY_DANGEROUS_CONTENT",
];

type GeminiPart = Record<string, any>;
type GeminiContent = { role: "user" | "model"; parts: GeminiPart[] };

/** Gemini の返事そのもの（思考の署名・検索の呼び出しを含む）。次のラウンドにそのまま返す必要がある */
const MODEL_CONTENT = "gemini_model_content";

export function isGeminiAvailable(): boolean {
  return Boolean(GEMINI_API_KEY);
}

/** 入力に Gemini の返事が混ざっていれば、途中から Grok には切り替えられない */
export function hasGeminiTurn(input: InputItem[]): boolean {
  return input.some((item: any) => item?.type === MODEL_CONTENT);
}

async function imagePart(url: string): Promise<GeminiPart | null> {
  const dataUri = url.match(/^data:([^;,]+);base64,(.*)$/s);
  if (dataUri) return { inline_data: { mime_type: dataUri[1], data: dataUri[2] } };
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(30_000) });
    if (!res.ok) return null;
    const mimeType = res.headers.get("content-type")?.split(";")[0] ?? "image/jpeg";
    return { inline_data: { mime_type: mimeType, data: Buffer.from(await res.arrayBuffer()).toString("base64") } };
  } catch {
    return null;
  }
}

async function userParts(content: string | InputContent[]): Promise<GeminiPart[]> {
  if (typeof content === "string") return [{ text: content }];
  const parts: GeminiPart[] = [];
  for (const c of content) {
    if (c.type === "input_text") parts.push({ text: c.text });
    else {
      const part = await imagePart(c.image_url);
      parts.push(part ?? { text: "（この画像は読み込めなかった）" });
    }
  }
  return parts;
}

/** Responses API の入力を Gemini の contents に変換する（同じ役が続いたらまとめる） */
export async function toGeminiContents(input: InputItem[]): Promise<{ system: string; contents: GeminiContent[] }> {
  const system: string[] = [];
  const contents: GeminiContent[] = [];
  const callNames = new Map<string, string>();
  const push = (role: GeminiContent["role"], parts: GeminiPart[]) => {
    const last = contents[contents.length - 1];
    if (last && last.role === role && role === "user") last.parts.push(...parts);
    else contents.push({ role, parts });
  };

  for (const item of input as any[]) {
    if (item.type === MODEL_CONTENT) {
      for (const part of item.gemini?.parts ?? []) {
        if (part.functionCall?.id) callNames.set(part.functionCall.id, part.functionCall.name);
      }
      contents.push({ role: "model", parts: item.gemini?.parts ?? [] });
    } else if (item.type === "function_call") {
      // Gemini の返事（MODEL_CONTENT）に含まれているので送らない
      if (item.call_id && item.name) callNames.set(item.call_id, item.name);
    } else if (item.type === "function_call_output") {
      push("user", [
        {
          functionResponse: {
            id: item.call_id,
            name: callNames.get(item.call_id) ?? "tool",
            response: { output: item.output },
          },
        },
      ]);
    } else if (item.role === "system") {
      system.push(typeof item.content === "string" ? item.content : "");
    } else if (item.role === "assistant") {
      contents.push({ role: "model", parts: await userParts(item.content) });
    } else if (item.role === "user") {
      push("user", await userParts(item.content));
    }
  }
  return { system: system.filter(Boolean).join("\n\n"), contents };
}

function toGeminiTools(tools: ResponseTool[] | undefined, forceFunction: string | undefined) {
  const declarations = (tools ?? [])
    .filter((tool): tool is Extract<ResponseTool, { type: "function" }> => tool.type === "function")
    .map((tool) => ({ name: tool.name, description: tool.description, parametersJsonSchema: tool.parameters }));
  // 決まった関数を呼ばせるときは検索を外す（検索と「必ずこの関数」は一緒に指定できない）
  const search = !forceFunction && (tools ?? []).some((tool) => tool.type === "web_search" || tool.type === "x_search");
  const geminiTools: Record<string, any>[] = [];
  if (search) geminiTools.push({ googleSearch: {} });
  if (declarations.length) geminiTools.push({ functionDeclarations: declarations });
  const toolConfig: Record<string, any> = {};
  if (search && declarations.length) toolConfig.includeServerSideToolInvocations = true;
  if (forceFunction && declarations.length) {
    toolConfig.functionCallingConfig = { mode: "ANY", allowedFunctionNames: [forceFunction] };
  }
  return {
    tools: geminiTools.length ? geminiTools : undefined,
    toolConfig: Object.keys(toolConfig).length ? toolConfig : undefined,
  };
}

/**
 * xai.createResponse と同じ形で Gemini を呼ぶ。
 * 失敗・安全フィルターで止まった・空の返事は null（呼び出し側が Grok に回す）
 */
export async function createGeminiResponse(params: {
  input: InputItem[];
  tools?: ResponseTool[];
  maxOutputTokens?: number;
  temperature?: number;
  forceFunction?: string;
}): Promise<ResponsesResult | null> {
  try {
    const { system, contents } = await toGeminiContents(params.input);
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_CHAT_MODEL}:generateContent`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-goog-api-key": GEMINI_API_KEY ?? "" },
        body: toRequestJson({
          systemInstruction: system ? { parts: [{ text: system }] } : undefined,
          contents,
          ...toGeminiTools(params.tools, params.forceFunction),
          generationConfig: {
            temperature: params.temperature,
            maxOutputTokens: params.maxOutputTokens ?? 800,
            thinkingConfig: { thinkingLevel: "minimal" },
          },
          safetySettings: SAFETY_CATEGORIES.map((category) => ({ category, threshold: "BLOCK_NONE" })),
        }),
        signal: AbortSignal.timeout(120_000),
      },
    );
    if (!res.ok) {
      console.error("[Gemini]", res.status, (await res.text()).slice(0, 800));
      return null;
    }
    const json = (await res.json()) as {
      promptFeedback?: { blockReason?: string };
      candidates?: { content?: GeminiContent; finishReason?: string }[];
      usageMetadata?: {
        promptTokenCount?: number;
        cachedContentTokenCount?: number;
        candidatesTokenCount?: number;
        thoughtsTokenCount?: number;
        toolUsePromptTokenCount?: number;
      };
    };
    const usageMeta = json.usageMetadata ?? {};
    const input = (usageMeta.promptTokenCount ?? 0) + (usageMeta.toolUsePromptTokenCount ?? 0);
    const cached = usageMeta.cachedContentTokenCount ?? 0;
    const output = (usageMeta.candidatesTokenCount ?? 0) + (usageMeta.thoughtsTokenCount ?? 0);
    const costUsd =
      (input - cached) * PRICE_PER_TOKEN.input + cached * PRICE_PER_TOKEN.cached + output * PRICE_PER_TOKEN.output;

    const candidate = json.candidates?.[0];
    const parts = candidate?.content?.parts ?? [];
    const calls = parts.filter((part) => part.functionCall);
    const text = parts
      .filter((part) => typeof part.text === "string" && !part.thought)
      .map((part) => part.text)
      .join("")
      .trim();
    if (!text && calls.length === 0) {
      console.error(
        "[Gemini] empty",
        json.promptFeedback?.blockReason ?? candidate?.finishReason ?? "no candidate",
      );
      return null;
    }

    const outputItems: ResponseOutputItem[] = [
      { type: MODEL_CONTENT, gemini: { role: "model", parts } },
      ...calls.map((part, i) => ({
        type: "function_call",
        call_id: part.functionCall.id ?? `gemini-call-${i}`,
        name: part.functionCall.name,
        arguments: JSON.stringify(part.functionCall.args ?? {}),
      })),
    ];
    // 呼び出し ID が無いときは、返すときに対応が取れるよう振った ID を元の返事にも書く
    calls.forEach((part, i) => {
      part.functionCall.id ??= `gemini-call-${i}`;
    });
    return { output: outputItems, text, costUsd, usage: { input, cached, output } };
  } catch (error) {
    console.error("[Gemini] error", error);
    return null;
  }
}

/** 単発のテキスト生成（日記・意見整理）。失敗は null */
export async function geminiText(
  messages: Array<{ role: "system" | "user" | "assistant"; content: string }>,
  options: { maxTokens?: number; temperature?: number } = {},
): Promise<string | null> {
  const result = await createGeminiResponse({
    input: messages,
    maxOutputTokens: options.maxTokens ?? 500,
    temperature: options.temperature ?? 0.7,
  });
  return result?.text || null;
}
