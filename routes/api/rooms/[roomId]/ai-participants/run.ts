import type { Handlers } from "$fresh/server.ts";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

type AiPersonality = "normal" | "weird" | "formal" | "archaic" | "technical";

type Member = {
  aiParticipantId?: string | null;
  username: string;
  isAi?: boolean;
  hasSubmitted: boolean;
};

type GameState = {
  room: {
    currentPhase:
      | "waiting"
      | "prompt"
      | "writing"
      | "editing"
      | "voting"
      | "results";
  };
  prompt: {
    word: string;
  } | null;
  members: Member[];
};

type AiParticipantRow = {
  id: string;
  slot: number;
  display_name: string;
  personality: AiPersonality;
};

type PersonalityPrompt = {
  label: string;
  direction: string;
};

const missingOpenAiKeyMessage = "OPENAI_API_KEY がありません。";

const personalityPrompts: Record<AiPersonality, PersonalityPrompt> = {
  normal: {
    label: "ふつうAI",
    direction: "自然な辞書調で、もっともらしい語義を書いてください。",
  },
  weird: {
    label: "へんなAI",
    direction:
      "少し意外な連想を含めつつ、辞書に載っていそうな落ち着いた語義にしてください。",
  },
  formal: {
    label: "硬派な辞書AI",
    direction: "硬めの国語辞典のように、簡潔で抽象度の高い語義にしてください。",
  },
  archaic: {
    label: "古語っぽいAI",
    direction: "古語・雅語・文語の雰囲気を少し含む語義にしてください。",
  },
  technical: {
    label: "専門用語AI",
    direction: "学術用語や専門分野の語義に見える説明にしてください。",
  },
};

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

function cleanDefinition(value: string) {
  return value
    .replace(/^["'「『]+/, "")
    .replace(/["'」』]+$/, "")
    .trim()
    .slice(0, 1200);
}

function getIncompleteReason(responseJson: Record<string, unknown>) {
  const incompleteDetails = responseJson.incomplete_details;
  if (!incompleteDetails || typeof incompleteDetails !== "object") return "";

  const reason = (incompleteDetails as { reason?: unknown }).reason;
  return typeof reason === "string" ? reason : "";
}

function extractOpenAiErrorMessage(errorBody: string) {
  if (!errorBody.trim()) return "AI参加者の意味生成に失敗しました。";

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

async function createAiDefinition(
  openAiKey: string,
  word: string,
  aiParticipant: AiParticipantRow,
  generatedDefinitions: string[],
) {
  const personality = personalityPrompts[aiParticipant.personality] ??
    personalityPrompts.normal;
  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      authorization: `Bearer ${openAiKey}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: Deno.env.get("OPENAI_MODEL") ?? "gpt-5",
      instructions: [
        "あなたは『たほいや』に参加するAI回答者です。",
        "与えられたお題語について、正解ではない偽の意味を1件だけ作ってください。",
        "ただし、プレイヤーが正解と迷うように、実在語義らしい辞書調で書いてください。",
        "正しい意味を知っているふりをして断定しすぎず、もっともらしい別語義にしてください。",
        "本文だけを出力してください。見出し、箇条書き、引用符、説明は不要です。",
        "80文字以内の短い1文で出力してください。",
        `あなたの個性: ${personality.label}`,
        personality.direction,
      ].join("\n"),
      input: [
        `お題語: ${word}`,
        `AI枠: ${aiParticipant.slot}`,
        "このリクエスト内ですでに生成済みの偽意味:",
        generatedDefinitions.length > 0
          ? generatedDefinitions.join("\n")
          : "なし",
      ].join("\n"),
      text: {
        verbosity: "low",
      },
      max_output_tokens: 2048,
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
        ? "AI参加者の意味生成が出力上限で途中終了しました。もう一度試してください。"
        : `AI参加者の意味生成が途中終了しました。${incompleteReason}`,
    );
  }

  const body = cleanDefinition(extractOutputText(responseJson));
  if (!body) throw new Error("AI参加者の意味を生成できませんでした。");
  return body;
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
    const supabase = makeSupabaseClient(token);
    const { data: userData, error: userError } = await supabase.auth.getUser(
      token,
    );

    if (userError || !userData.user) {
      return jsonResponse({ error: "Authentication is required" }, 401);
    }

    const { data: gameStateData, error: gameStateError } = await supabase.rpc(
      "get_room_game_state",
      { target_room_id: roomId },
    );

    if (gameStateError || !gameStateData) {
      return jsonResponse(
        { error: gameStateError?.message ?? "ゲーム状態を取得できません。" },
        403,
      );
    }

    const gameState = gameStateData as GameState;
    if (gameState.room.currentPhase !== "writing" || !gameState.prompt?.word) {
      return jsonResponse({ submitted: 0 });
    }

    const pendingAiIds = gameState.members.flatMap((member) =>
      member.isAi && member.aiParticipantId && !member.hasSubmitted
        ? [member.aiParticipantId]
        : []
    );

    if (pendingAiIds.length === 0) {
      return jsonResponse({ submitted: 0 });
    }

    const { data: aiRows, error: aiRowsError } = await supabase
      .from("room_ai_participants")
      .select("id,slot,display_name,personality")
      .eq("room_id", roomId)
      .in("id", pendingAiIds)
      .returns<AiParticipantRow[]>();

    if (aiRowsError || !aiRows) {
      return jsonResponse(
        { error: aiRowsError?.message ?? "AI参加者を取得できません。" },
        500,
      );
    }

    const aiById = new Map(aiRows.map((row) => [row.id, row]));
    const generatedDefinitions: string[] = [];
    let submitted = 0;

    try {
      for (const aiId of pendingAiIds) {
        const aiParticipant = aiById.get(aiId);
        if (!aiParticipant) continue;

        const body = await createAiDefinition(
          openAiKey,
          gameState.prompt.word,
          aiParticipant,
          generatedDefinitions,
        );

        const { error } = await supabase.rpc("submit_ai_definition", {
          target_room_id: roomId,
          target_ai_participant_id: aiParticipant.id,
          next_body: body,
        });

        if (error) throw new Error(error.message);
        generatedDefinitions.push(body);
        submitted += 1;
      }
    } catch (error) {
      console.error("AI participant generation failed", error);
      return jsonResponse(
        {
          error: error instanceof Error
            ? error.message
            : "AI参加者の意味生成に失敗しました。",
        },
        500,
      );
    }

    return jsonResponse({ submitted });
  },
};
