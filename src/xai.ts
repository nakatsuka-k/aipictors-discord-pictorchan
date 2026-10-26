import { CHAT_MODEL, GROK_API_KEY, TEXT_MODEL, VISION_MODEL } from "./config";

const CHAT_ENDPOINT = "https://api.x.ai/v1/chat/completions";
const RESPONSES_ENDPOINT = "https://api.x.ai/v1/responses";

type ChatResponse = { choices?: { message?: { content?: string } }[] };

/** 単発のテキスト生成（日記・整形など） */
export async function chatText(
  messages: Array<{ role: "system" | "user" | "assistant"; content: string }>,
  options: { model?: string; maxTokens?: number; temperature?: number } = {},
): Promise<string | null> {
  try {
    const res = await fetch(CHAT_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${GROK_API_KEY}` },
      body: JSON.stringify({
        model: options.model ?? TEXT_MODEL,
        messages,
        max_tokens: options.maxTokens ?? 500,
        temperature: options.temperature ?? 0.7,
      }),
      signal: AbortSignal.timeout(90_000),
    });
    if (!res.ok) {
      console.error("[xAI chat]", res.status, (await res.text()).slice(0, 500));
      return null;
    }
    const json = (await res.json()) as ChatResponse;
    return json.choices?.[0]?.message?.content?.trim() || null;
  } catch (error) {
    console.error("[xAI chat] error", error);
    return null;
  }
}

// ──────────────────────────────────────────────────────────
// Responses API（ツール呼び出し・画像入力）
// ──────────────────────────────────────────────────────────
export type InputContent =
  | { type: "input_text"; text: string }
  | { type: "input_image"; image_url: string; detail?: "low" | "high" | "auto" };

export type InputItem =
  | { role: "system" | "user" | "assistant"; content: string | InputContent[] }
  | { type: "function_call_output"; call_id: string; output: string }
  | Record<string, any>;

export type FunctionTool = {
  type: "function";
  name: string;
  description: string;
  parameters: Record<string, any>;
};

export type ResponseTool = FunctionTool | { type: "web_search" } | { type: "x_search" };

export type ResponseOutputItem = {
  type: string;
  id?: string;
  call_id?: string;
  name?: string;
  arguments?: string;
  content?: Array<{ type?: string; text?: string }>;
  [key: string]: any;
};

export type ResponsesResult = {
  output: ResponseOutputItem[];
  text: string;
  costUsd: number;
};

export async function createResponse(params: {
  input: InputItem[];
  tools?: ResponseTool[];
  model?: string;
  maxOutputTokens?: number;
  temperature?: number;
  /** 特定の関数を必ず呼ばせる */
  forceFunction?: string;
}): Promise<ResponsesResult | null> {
  try {
    const res = await fetch(RESPONSES_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${GROK_API_KEY}` },
      body: JSON.stringify({
        model: params.model ?? CHAT_MODEL,
        store: false,
        input: params.input,
        tools: params.tools?.length ? params.tools : undefined,
        tool_choice: params.forceFunction && params.tools?.length ? { type: "function", name: params.forceFunction } : undefined,
        max_output_tokens: params.maxOutputTokens ?? 800,
        temperature: params.temperature,
      }),
      signal: AbortSignal.timeout(120_000),
    });
    if (!res.ok) {
      console.error("[xAI responses]", res.status, (await res.text()).slice(0, 800));
      return null;
    }
    const json = (await res.json()) as { output?: ResponseOutputItem[]; usage?: { cost_in_usd_ticks?: number } };
    const output = json.output ?? [];
    const text = output
      .filter((item) => item.type === "message")
      .flatMap((item) => item.content ?? [])
      .filter((c) => c.type === "output_text")
      .map((c) => c.text ?? "")
      .join("\n")
      .trim();
    return { output, text, costUsd: (json.usage?.cost_in_usd_ticks ?? 0) / 1e10 };
  } catch (error) {
    console.error("[xAI responses] error", error);
    return null;
  }
}

/** 画像（複数可）を見てテキストで答える */
export async function visionText(
  instructions: string,
  prompt: string,
  imageUrls: string[],
  options: { model?: string; maxOutputTokens?: number } = {},
): Promise<string | null> {
  const result = await createResponse({
    model: options.model ?? VISION_MODEL,
    maxOutputTokens: options.maxOutputTokens ?? 600,
    input: [
      { role: "system", content: instructions },
      {
        role: "user",
        content: [
          ...imageUrls.map((url) => ({ type: "input_image" as const, image_url: url, detail: "high" as const })),
          { type: "input_text" as const, text: prompt },
        ],
      },
    ],
  });
  return result?.text || null;
}
