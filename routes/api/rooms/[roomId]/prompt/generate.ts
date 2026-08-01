import type { Handlers } from "$fresh/server.ts";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

type RoomRow = {
  owner_id: string;
  current_phase:
    | "waiting"
    | "prompt"
    | "checking"
    | "writing"
    | "editing"
    | "voting"
    | "results";
};

type GeneratedPrompt = {
  word: string;
  correctDefinition: string;
};

type PromptMode = "normal" | "freeform";

const missingOpenAiKeyMessage = "OPENAI_API_KEY がありません。";
const hiraganaPattern = /^[ぁ-ゖー]+$/;

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
    },
  });
}

function getBearerToken(req: Request) {
  const authorization = req.headers.get("authorization") ?? "";
  const match = authorization.match(/^Bearer\s+(.+)$/i);
  return match?.[1] ?? "";
}

function makeSupabaseClient(token: string): SupabaseClient {
  const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
  const supabaseAnonKey = Deno.env.get("SUPABASE_ANON_KEY") ?? "";

  return createClient(supabaseUrl, supabaseAnonKey, {
    auth: {
      autoRefreshToken: false,
      detectSessionInUrl: false,
      persistSession: false,
    },
    global: {
      headers: {
        Authorization: `Bearer ${token}`,
      },
    },
  });
}

function extractOutputText(responseJson: Record<string, unknown>) {
  const directText = responseJson.output_text;
  if (typeof directText === "string" && directText.trim()) {
    return directText.trim();
  }

  const output = responseJson.output;
  if (!Array.isArray(output)) return "";

  const texts: string[] = [];
  for (const item of output) {
    if (!item || typeof item !== "object") continue;
    const content = (item as { content?: unknown }).content;
    if (!Array.isArray(content)) continue;
    for (const part of content) {
      if (!part || typeof part !== "object") continue;
      const text = (part as { text?: unknown; output_text?: unknown }).text ??
        (part as { text?: unknown; output_text?: unknown }).output_text;
      if (typeof text === "string") texts.push(text);
    }
  }

  return texts.join("\n").trim();
}

function extractJsonObject(value: string) {
  const trimmed = value
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();

  if (trimmed.startsWith("{") && trimmed.endsWith("}")) return trimmed;

  const firstBrace = trimmed.indexOf("{");
  const lastBrace = trimmed.lastIndexOf("}");
  if (firstBrace === -1 || lastBrace === -1 || firstBrace >= lastBrace) {
    return trimmed;
  }

  return trimmed.slice(firstBrace, lastBrace + 1);
}

function parseGeneratedPrompt(
  value: string,
  mode: PromptMode,
): GeneratedPrompt {
  const jsonText = extractJsonObject(value);
  const parsed = JSON.parse(jsonText) as Partial<GeneratedPrompt>;
  const word = String(parsed.word ?? "").trim();
  const correctDefinition = String(parsed.correctDefinition ?? "").trim();

  if (word.length < 1 || word.length > 80) {
    throw new Error("AIが有効なお題を返しませんでした。");
  }

  if (mode === "normal" && !hiraganaPattern.test(word)) {
    throw new Error("AIがひらがなの読みを返しませんでした。");
  }

  if (correctDefinition.length < 1 || correctDefinition.length > 1200) {
    throw new Error("AIが有効な意味を返しませんでした。");
  }

  return { word, correctDefinition };
}

function getPromptGenerationInstructions(mode: PromptMode) {
  if (mode === "freeform") {
    return [
      "あなたは雑学ゲームと事実確認に強い編集者です。",
      "友人同士で遊ぶ『自由律たほいや』のお題を1件だけ作ってください。",
      "このモードでは、プレイヤーは正解ではない架空回答を考えます。",
      "word には、明確な正解がある雑学・事実テーマまたは短い問いを入れてください。",
      "correctDefinition には、その問いへの正しい答えを具体的に書いてください。",
      "歴史、文化、科学、地理、芸術、生活史などから、意外だが確かめやすい事実を選んでください。",
      "架空回答を作る余地がある題材にしてください。単なる二択、計算問題、最新ニュース、炎上しやすい政治・事件・差別的題材は避けてください。",
      "正解は創作、推測、俗説ではなく、事実として扱える内容にしてください。",
      "JSON以外は出力しないでください。",
      '形式: {"word":"...","correctDefinition":"..."}',
    ].join("\n");
  }

  return [
    "あなたは日本語の辞書と語彙ゲームに詳しい編集者です。",
    "友人同士で遊ぶ『たほいや』のお題を1件だけ選んでください。",
    "造語は禁止です。必ず実在する日本語の難しい単語だけを選んでください。",
    "お題として表示する語は、漢字表記ではなく読みだけをひらがなで返してください。",
    "word にはひらがなの読みだけを入れてください。漢字、カタカナ、英数字、記号、括弧、送り仮名の注記は禁止です。",
    "correctDefinition には、必要に応じて漢字表記を含めて、その読みの単語の正しい意味を書いてください。",
    "意味は辞書的に正しい内容にしてください。推測、創作、俗説は禁止です。",
    "一般的すぎる語、固有名詞、専門家でないと不快になりうる語、差別語、性的な語は避けてください。",
    "プレイヤーが偽の意味を書きやすい、聞き慣れないが短めの語を優先してください。",
    "JSON以外は出力しないでください。",
    '形式: {"word":"...","correctDefinition":"..."}',
  ].join("\n");
}

function getPromptGenerationInput(mode: PromptMode) {
  return mode === "freeform"
    ? "自由律たほいや向けのお題と正解を1件生成してください。"
    : "たほいや向けのお題を1件生成してください。";
}

function getJsonSchema(mode: PromptMode) {
  return {
    type: "object",
    additionalProperties: false,
    properties: {
      word: {
        type: "string",
        description: mode === "freeform"
          ? "明確な正解がある雑学・事実テーマまたは短い問い"
          : "実在する難しい日本語単語の読み。ひらがなのみ。",
      },
      correctDefinition: {
        type: "string",
        description: mode === "freeform"
          ? "そのテーマまたは問いへの正しい答え"
          : "その単語の辞書的に正しい日本語の意味",
      },
    },
    required: ["word", "correctDefinition"],
  };
}

function getIncompleteReason(responseJson: Record<string, unknown>) {
  const incompleteDetails = responseJson.incomplete_details;
  if (!incompleteDetails || typeof incompleteDetails !== "object") return "";

  const reason = (incompleteDetails as { reason?: unknown }).reason;
  return typeof reason === "string" ? reason : "";
}

function extractOpenAiErrorMessage(errorBody: string) {
  if (!errorBody.trim()) return "AIお題生成に失敗しました。";

  try {
    const parsed = JSON.parse(errorBody) as {
      error?: { message?: unknown };
      message?: unknown;
    };
    const message = parsed.error?.message ?? parsed.message;
    if (typeof message === "string" && message.trim()) {
      return message.trim();
    }
  } catch {
    // Fall through to a compact plain-text response.
  }

  return errorBody.trim().slice(0, 500);
}

async function createGeneratedPrompt(openAiKey: string, mode: PromptMode) {
  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      authorization: `Bearer ${openAiKey}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: Deno.env.get("OPENAI_MODEL") ?? "gpt-5",
      instructions: getPromptGenerationInstructions(mode),
      input: getPromptGenerationInput(mode),
      text: {
        verbosity: "low",
        format: {
          type: "json_schema",
          name: "tahoiya_prompt",
          strict: true,
          schema: getJsonSchema(mode),
        },
      },
      max_output_tokens: 4096,
    }),
  });

  if (!response.ok) {
    const errorBody = await response.text();
    throw new Error(
      `OpenAI API error (${response.status}): ${
        extractOpenAiErrorMessage(errorBody)
      }`,
    );
  }

  const responseJson = (await response.json()) as Record<string, unknown>;
  const incompleteReason = getIncompleteReason(responseJson);
  if (responseJson.status === "incomplete") {
    throw new Error(
      incompleteReason === "max_output_tokens"
        ? "AIお題生成が出力上限で途中終了しました。もう一度生成してください。"
        : `AIお題生成が途中終了しました。${incompleteReason}`,
    );
  }

  const outputText = extractOutputText(responseJson);
  try {
    return parseGeneratedPrompt(outputText, mode);
  } catch (error) {
    console.error("Failed to parse generated prompt", {
      error,
      outputText,
      responseStatus: responseJson.status,
      incompleteDetails: responseJson.incomplete_details,
    });
    throw new Error(
      "AIの返答をJSONとして読めませんでした。もう一度生成してください。",
    );
  }
}

export const handler: Handlers = {
  async POST(req, ctx) {
    const openAiKey = Deno.env.get("OPENAI_API_KEY") ?? "";
    if (!openAiKey) {
      return jsonResponse({ error: missingOpenAiKeyMessage }, 400);
    }

    const token = getBearerToken(req);
    if (!token) {
      return jsonResponse({ error: "Authentication is required" }, 401);
    }

    const roomId = ctx.params.roomId;
    const requestBody = await req.json().catch(() => ({})) as {
      mode?: unknown;
    };
    const mode = requestBody.mode === "freeform" ? "freeform" : "normal";
    if (
      requestBody.mode !== undefined &&
      requestBody.mode !== "normal" &&
      requestBody.mode !== "freeform"
    ) {
      return jsonResponse({ error: "Unknown prompt mode" }, 400);
    }
    const supabase = makeSupabaseClient(token);
    const { data: userData, error: userError } = await supabase.auth.getUser(
      token,
    );

    if (userError || !userData.user) {
      return jsonResponse({ error: "Authentication is required" }, 401);
    }

    const { data: room, error: roomError } = await supabase
      .from("rooms")
      .select("owner_id,current_phase")
      .eq("id", roomId)
      .maybeSingle<RoomRow>();

    if (roomError || !room) {
      return jsonResponse(
        { error: roomError?.message ?? "部屋を取得できません。" },
        404,
      );
    }

    if (room.owner_id !== userData.user.id) {
      return jsonResponse({ error: "ルームマスターだけが生成できます。" }, 403);
    }

    if (room.current_phase !== "waiting" && room.current_phase !== "prompt") {
      return jsonResponse({ error: "待合中だけ生成できます。" }, 400);
    }

    try {
      return jsonResponse(await createGeneratedPrompt(openAiKey, mode));
    } catch (error) {
      console.error("Prompt generation failed", error);
      return jsonResponse(
        {
          error: error instanceof Error
            ? error.message
            : "AIお題生成に失敗しました。",
        },
        500,
      );
    }
  },
};
