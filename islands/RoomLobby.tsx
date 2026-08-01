import {
  createClient,
  type SupabaseClient,
  type User,
} from "@supabase/supabase-js";
import { useEffect, useMemo, useState } from "preact/hooks";
import LoginForm, { type AuthProfile } from "./LoginForm.tsx";

type Props = {
  roomId: string;
  supabaseUrl: string;
  supabaseAnonKey: string;
  isConfigured: boolean;
};

type ViewState =
  | "checking"
  | "needs-auth"
  | "joining"
  | "ready"
  | "saving"
  | "error";

type RoomPhase =
  | "waiting"
  | "prompt"
  | "writing"
  | "editing"
  | "voting"
  | "results";

type RoomState = {
  id: string;
  ownerId: string;
  currentPhase: RoomPhase;
  includeMasterAsPlayer: boolean;
  currentRound: number;
};

type Member = {
  userId: string;
  aiParticipantId?: string | null;
  username: string;
  joinedAt: string;
  isAi?: boolean;
  isMaster: boolean;
  isWriter: boolean;
  isVoter: boolean;
  hasSubmitted: boolean;
  hasVoted: boolean;
};

type PromptState = {
  word: string;
  correctDefinition?: string;
};

type OwnDefinition = {
  id: string;
  body: string;
};

type DraftDefinition = {
  id: string;
  body: string;
};

type Choice = {
  id: string;
  body: string;
  displayOrder: number;
  isOwn: boolean;
};

type ResultChoice = {
  id: string;
  body: string;
  displayOrder: number;
  isCorrect: boolean;
  submittedByUsername: string | null;
  voteCount: number;
  voters: string[];
};

type Score = {
  userId: string;
  username: string;
  correctPoints: number;
  bluffPoints: number;
  totalPoints: number;
};

type GameState = {
  room: RoomState;
  members: Member[];
  prompt: PromptState | null;
  ownDefinition: OwnDefinition | null;
  draftDefinitions: DraftDefinition[];
  choices: Choice[];
  ownVoteChoiceId: string | null;
  results: ResultChoice[];
  scores: Score[];
};

type EditChoice = {
  key: string;
  sourceDefinitionId: string | null;
  isCorrect: boolean;
  body: string;
};

type AiPersonality = "normal" | "weird" | "formal" | "archaic" | "technical";

type AiParticipantSetting = {
  id: string;
  slot: number;
  display_name: string;
  personality: AiPersonality;
};

const aiPersonalityOptions: { value: AiPersonality; label: string }[] = [
  { value: "normal", label: "ふつう" },
  { value: "weird", label: "へんな" },
  { value: "formal", label: "硬派な辞書" },
  { value: "archaic", label: "古語っぽい" },
  { value: "technical", label: "それっぽい専門用語" },
];

function makeClient(
  supabaseUrl: string,
  supabaseAnonKey: string,
): SupabaseClient | null {
  if (!supabaseUrl || !supabaseAnonKey) return null;

  return createClient(supabaseUrl, supabaseAnonKey, {
    auth: {
      autoRefreshToken: true,
      detectSessionInUrl: false,
      persistSession: true,
    },
  });
}

function phaseLabel(phase: RoomPhase) {
  if (phase === "waiting") return "待合";
  if (phase === "prompt") return "出題";
  if (phase === "writing") return "意味提出";
  if (phase === "editing") return "整形";
  if (phase === "voting") return "投票";
  return "結果";
}

function makeEditKey(prefix: string, value: string) {
  return `${prefix}:${value}`;
}

export default function RoomLobby(
  { roomId, supabaseUrl, supabaseAnonKey, isConfigured }: Props,
) {
  const [viewState, setViewState] = useState<ViewState>(
    isConfigured ? "checking" : "error",
  );
  const [user, setUser] = useState<User | null>(null);
  const [gameState, setGameState] = useState<GameState | null>(null);
  const [message, setMessage] = useState("");
  const [wordInput, setWordInput] = useState("");
  const [correctInput, setCorrectInput] = useState("");
  const [definitionInput, setDefinitionInput] = useState("");
  const [includeMasterInput, setIncludeMasterInput] = useState(false);
  const [aiParticipantCountInput, setAiParticipantCountInput] = useState(0);
  const [aiParticipants, setAiParticipants] = useState<
    AiParticipantSetting[]
  >([]);
  const [aiPersonalitySavingId, setAiPersonalitySavingId] = useState("");
  const [editChoices, setEditChoices] = useState<EditChoice[]>([]);
  const [editLoadedKey, setEditLoadedKey] = useState("");
  const [voteChoiceId, setVoteChoiceId] = useState("");
  const [promptGenerating, setPromptGenerating] = useState(false);
  const [aiWritingRunning, setAiWritingRunning] = useState(false);
  const [aiWritingBlockedKey, setAiWritingBlockedKey] = useState("");

  const supabase = useMemo(
    () => makeClient(supabaseUrl, supabaseAnonKey),
    [supabaseUrl, supabaseAnonKey],
  );

  const roomUrl = typeof location === "undefined" ? "" : location.href;
  const room = gameState?.room ?? null;
  const members = gameState?.members ?? [];
  const isOwner = Boolean(user && room && user.id === room.ownerId);
  const selfMember = user
    ? members.find((member) => member.userId === user.id) ?? null
    : null;
  const pendingWriters = members.filter((member) =>
    member.isWriter && !member.hasSubmitted
  );
  const pendingVoters = members.filter((member) =>
    member.isVoter && !member.hasVoted
  );
  const pendingAiMembers = pendingWriters.filter((member) => member.isAi);
  const aiWritingRunKey = room && pendingAiMembers.length > 0
    ? [
      room.id,
      room.currentPhase,
      pendingAiMembers.map((member) => member.userId).join(","),
    ].join(":")
    : "";

  async function joinRoom(client: SupabaseClient) {
    const { error } = await client.rpc("join_room", {
      target_room_id: roomId,
    });

    if (error) {
      setMessage(error.message);
      setViewState("error");
      return false;
    }

    return true;
  }

  async function loadGameState(client: SupabaseClient) {
    const { data, error } = await client.rpc("get_room_game_state", {
      target_room_id: roomId,
    });

    if (error || !data) {
      setMessage(error?.message ?? "ゲーム状態を取得できません。");
      setViewState("error");
      return;
    }

    const nextState = data as GameState;
    const { data: aiRows, error: aiRowsError } = await client
      .from("room_ai_participants")
      .select("id,slot,display_name,personality")
      .eq("room_id", roomId)
      .order("slot")
      .returns<AiParticipantSetting[]>();

    if (aiRowsError) setMessage(aiRowsError.message);

    setGameState(nextState);
    setAiParticipants(aiRows ?? []);
    setAiParticipantCountInput(aiRows?.length ?? 0);
    setIncludeMasterInput(nextState.room.includeMasterAsPlayer);
    setWordInput(nextState.prompt?.word ?? wordInput);
    setCorrectInput(nextState.prompt?.correctDefinition ?? correctInput);
    setDefinitionInput(nextState.ownDefinition?.body ?? definitionInput);
    setVoteChoiceId(nextState.ownVoteChoiceId ?? voteChoiceId);
    setViewState("ready");
  }

  useEffect(() => {
    if (!isConfigured || !supabase) {
      setMessage("SUPABASE_URL と SUPABASE_ANON_KEY を設定してください。");
      setViewState("error");
      return;
    }

    let isMounted = true;
    const client = supabase;

    async function boot() {
      const { data, error } = await client.auth.getSession();
      if (!isMounted) return;

      if (error) {
        setMessage(error.message);
        setViewState("error");
        return;
      }

      const sessionUser = data.session?.user ?? null;
      if (!sessionUser) {
        setViewState("needs-auth");
        return;
      }

      setUser(sessionUser);
      setViewState("joining");
      const joined = await joinRoom(client);
      if (!joined || !isMounted) return;
      await loadGameState(client);
    }

    boot();

    return () => {
      isMounted = false;
    };
  }, [isConfigured, supabase, roomId]);

  useEffect(() => {
    if (!supabase || !user || viewState === "needs-auth") return;

    const reload = () => loadGameState(supabase);
    const channel = supabase
      .channel(`besti-a-lie:${roomId}`)
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: "room_ai_participants",
          filter: `room_id=eq.${roomId}`,
        },
        reload,
      )
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: "room_members",
          filter: `room_id=eq.${roomId}`,
        },
        reload,
      )
      .on(
        "postgres_changes",
        {
          event: "UPDATE",
          schema: "public",
          table: "rooms",
          filter: `id=eq.${roomId}`,
        },
        reload,
      )
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: "prompts",
          filter: `room_id=eq.${roomId}`,
        },
        reload,
      )
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: "definitions",
          filter: `room_id=eq.${roomId}`,
        },
        reload,
      )
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: "published_choices",
          filter: `room_id=eq.${roomId}`,
        },
        reload,
      )
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: "votes",
          filter: `room_id=eq.${roomId}`,
        },
        reload,
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [supabase, user, roomId, viewState]);

  useEffect(() => {
    if (!supabase || !user || !gameState || aiWritingRunning) return;
    if (gameState.room.currentPhase !== "writing") return;
    if (pendingAiMembers.length === 0) return;
    if (aiWritingBlockedKey && aiWritingBlockedKey === aiWritingRunKey) return;

    runAiParticipants();
  }, [
    supabase,
    user,
    gameState,
    aiWritingRunning,
    pendingAiMembers.length,
    aiWritingBlockedKey,
    aiWritingRunKey,
  ]);

  useEffect(() => {
    if (!gameState || !isOwner || gameState.room.currentPhase !== "editing") {
      return;
    }

    const nextKey = [
      gameState.room.id,
      gameState.room.currentRound,
      gameState.draftDefinitions.map((definition) => definition.id).join(","),
      gameState.prompt?.correctDefinition ?? "",
    ].join(":");

    if (nextKey === editLoadedKey) return;

    setEditChoices([
      {
        key: "correct",
        sourceDefinitionId: null,
        isCorrect: true,
        body: gameState.prompt?.correctDefinition ?? "",
      },
      ...gameState.draftDefinitions.map((definition) => ({
        key: makeEditKey("definition", definition.id),
        sourceDefinitionId: definition.id,
        isCorrect: false,
        body: definition.body,
      })),
    ]);
    setEditLoadedKey(nextKey);
  }, [gameState, isOwner, editLoadedKey]);

  async function handleAuthenticated(authProfile: AuthProfile) {
    if (!supabase) return;
    setUser(authProfile.user);
    setViewState("joining");
    const joined = await joinRoom(supabase);
    if (!joined) return;
    await loadGameState(supabase);
  }

  async function handleCopyUrl() {
    await navigator.clipboard.writeText(roomUrl);
    setMessage("URLをコピーしました。");
  }

  async function handleSetIncludeMaster() {
    if (!supabase) return;

    setMessage("");
    setViewState("saving");
    const { error } = await supabase.rpc("set_room_include_master", {
      target_room_id: roomId,
      next_include_master_as_player: includeMasterInput,
    });

    if (error) {
      setMessage(error.message);
      setViewState("ready");
      return;
    }

    await loadGameState(supabase);
  }

  async function handleSetAiParticipantCount() {
    if (!supabase) return;

    setMessage("");
    setViewState("saving");
    const { error } = await supabase.rpc("set_room_ai_participant_count", {
      target_room_id: roomId,
      next_ai_participant_count: Math.min(
        4,
        Math.max(0, aiParticipantCountInput),
      ),
    });

    if (error) {
      setMessage(error.message);
      setViewState("ready");
      return;
    }

    await loadGameState(supabase);
  }

  async function handleSetAiPersonality(participant: AiParticipantSetting) {
    if (!supabase) return;

    setMessage("");
    setAiPersonalitySavingId(participant.id);
    const { error } = await supabase.rpc(
      "set_room_ai_participant_personality",
      {
        target_room_id: roomId,
        target_ai_participant_id: participant.id,
        next_personality: participant.personality,
      },
    );

    setAiPersonalitySavingId("");
    if (error) {
      setMessage(error.message);
      return;
    }

    await loadGameState(supabase);
  }

  async function handleGeneratePrompt() {
    if (!supabase) return;

    setMessage("");
    setPromptGenerating(true);
    const { data, error } = await supabase.auth.getSession();
    const token = data.session?.access_token ?? "";

    if (error || !token) {
      setPromptGenerating(false);
      setMessage(error?.message ?? "Authentication is required");
      return;
    }

    const response = await fetch(
      `/api/rooms/${encodeURIComponent(roomId)}/prompt/generate`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
        },
      },
    );
    const responseText = await response.text();
    let body:
      | { word?: string; correctDefinition?: string; error?: string }
      | null = null;
    try {
      body = JSON.parse(responseText);
    } catch {
      body = responseText.trim() ? { error: responseText.trim() } : null;
    }

    setPromptGenerating(false);
    if (!response.ok || !body?.word || !body.correctDefinition) {
      setMessage(body?.error ?? "AIお題生成に失敗しました。");
      return;
    }

    setWordInput(body.word);
    setCorrectInput(body.correctDefinition);
    setMessage("AIが候補を生成しました。内容を確認してから開始してください。");
  }

  async function handleStartPrompt(event: Event) {
    event.preventDefault();
    if (!supabase) return;

    setMessage("");
    setViewState("saving");
    const { error } = await supabase.rpc("start_prompt", {
      target_room_id: roomId,
      next_word: wordInput,
      next_correct_definition: correctInput,
    });

    if (error) {
      setMessage(error.message);
      setViewState("ready");
      return;
    }

    await loadGameState(supabase);
  }

  async function handleSubmitDefinition(event: Event) {
    event.preventDefault();
    if (!supabase) return;

    setMessage("");
    setViewState("saving");
    const { error } = await supabase.rpc("submit_definition", {
      target_room_id: roomId,
      next_body: definitionInput,
    });

    if (error) {
      setMessage(error.message);
      setViewState("ready");
      return;
    }

    await loadGameState(supabase);
  }

  async function runAiParticipants() {
    if (!supabase || aiWritingRunning) return;

    setAiWritingRunning(true);
    const blockedKey = aiWritingRunKey;
    const { data, error } = await supabase.auth.getSession();
    const token = data.session?.access_token ?? "";

    if (error || !token) {
      setAiWritingRunning(false);
      setAiWritingBlockedKey(blockedKey);
      setMessage(error?.message ?? "Authentication is required");
      return;
    }

    const response = await fetch(
      `/api/rooms/${encodeURIComponent(roomId)}/ai-participants/run`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
        },
      },
    );
    const responseText = await response.text();
    let body: { submitted?: number; error?: string } | null = null;
    try {
      body = JSON.parse(responseText);
    } catch {
      body = responseText.trim() ? { error: responseText.trim() } : null;
    }

    setAiWritingRunning(false);
    if (!response.ok) {
      setAiWritingBlockedKey(blockedKey);
      setMessage(body?.error ?? "AI参加者の提出に失敗しました。");
      return;
    }

    setAiWritingBlockedKey("");
    await loadGameState(supabase);
  }

  async function handlePublishChoices() {
    if (!supabase) return;

    setMessage("");
    setViewState("saving");
    const payload = editChoices.map((choice, index) => ({
      sourceDefinitionId: choice.sourceDefinitionId,
      isCorrect: choice.isCorrect,
      body: choice.body,
      displayOrder: index + 1,
    }));
    const { error } = await supabase.rpc("publish_choices", {
      target_room_id: roomId,
      choices: payload,
    });

    if (error) {
      setMessage(error.message);
      setViewState("ready");
      return;
    }

    await loadGameState(supabase);
  }

  async function handleSubmitVote(event: Event) {
    event.preventDefault();
    if (!supabase || !voteChoiceId) return;

    setMessage("");
    setViewState("saving");
    const { error } = await supabase.rpc("submit_vote", {
      target_room_id: roomId,
      target_choice_id: voteChoiceId,
    });

    if (error) {
      setMessage(error.message);
      setViewState("ready");
      return;
    }

    await loadGameState(supabase);
  }

  async function handleRevealResults() {
    if (!supabase) return;

    setMessage("");
    setViewState("saving");
    const { error } = await supabase.rpc("reveal_results", {
      target_room_id: roomId,
    });

    if (error) {
      setMessage(error.message);
      setViewState("ready");
      return;
    }

    await loadGameState(supabase);
  }

  function moveEditChoice(index: number, direction: -1 | 1) {
    setEditChoices((current) => {
      const nextIndex = index + direction;
      if (nextIndex < 0 || nextIndex >= current.length) return current;
      const next = [...current];
      const [item] = next.splice(index, 1);
      next.splice(nextIndex, 0, item);
      return next;
    });
  }

  if (viewState === "checking" || viewState === "joining") {
    return (
      <div class="card" aria-live="polite">
        <p class="status-text">
          {viewState === "joining" ? "部屋に入室しています。" : "確認中です。"}
        </p>
      </div>
    );
  }

  if (viewState === "needs-auth") {
    return (
      <LoginForm
        supabaseUrl={supabaseUrl}
        supabaseAnonKey={supabaseAnonKey}
        isConfigured={isConfigured}
        onAuthenticated={handleAuthenticated}
      />
    );
  }

  if (!gameState || !room) {
    return (
      <div class="card">
        <p class="form-message" role="alert">
          {message || "部屋を読み込めません。"}
        </p>
      </div>
    );
  }

  return (
    <div class="card room-card">
      <div class="room-heading">
        <div>
          <p class="eyebrow">Room</p>
          <h1>{gameState.prompt?.word ?? "お題待ち"}</h1>
        </div>
        <span class="phase-pill">{phaseLabel(room.currentPhase)}</span>
      </div>

      <div class="share-row">
        <input type="text" readOnly value={roomUrl} aria-label="部屋URL" />
        <button
          type="button"
          class="secondary-button compact-button"
          onClick={handleCopyUrl}
        >
          コピー
        </button>
      </div>

      {message && <p class="form-message" role="status">{message}</p>}

      {room.currentPhase === "waiting" && (
        <section class="phase-block">
          <p class="muted">参加者が揃ったら、お題と正しい意味を入力します。</p>

          {isOwner && (
            <>
              <label class="toggle-row" htmlFor="include-master">
                <input
                  id="include-master"
                  type="checkbox"
                  checked={includeMasterInput}
                  disabled={viewState === "saving"}
                  onChange={(event) =>
                    setIncludeMasterInput(
                      (event.currentTarget as HTMLInputElement).checked,
                    )}
                />
                <span>ルームマスターも偽の意味を書く</span>
              </label>
              <button
                type="button"
                class="secondary-button"
                disabled={viewState === "saving"}
                onClick={handleSetIncludeMaster}
              >
                設定を保存
              </button>

              <label class="field-label setting-label" htmlFor="ai-count">
                AI参加者
              </label>
              <div class="share-row">
                <select
                  id="ai-count"
                  value={String(aiParticipantCountInput)}
                  disabled={viewState === "saving"}
                  onChange={(event) =>
                    setAiParticipantCountInput(
                      Number((event.currentTarget as HTMLSelectElement).value),
                    )}
                >
                  {[0, 1, 2, 3, 4].map((count) => (
                    <option key={count} value={String(count)}>
                      {count}人
                    </option>
                  ))}
                </select>
                <button
                  type="button"
                  class="secondary-button compact-button"
                  disabled={viewState === "saving"}
                  onClick={handleSetAiParticipantCount}
                >
                  保存
                </button>
              </div>

              {aiParticipants.length > 0 && (
                <div class="ai-personality-settings">
                  {aiParticipants.map((participant) => (
                    <div key={participant.id}>
                      <label
                        class="field-label"
                        htmlFor={`ai-personality-${participant.id}`}
                      >
                        AI {participant.slot} の個性
                      </label>
                      <div class="share-row">
                        <select
                          id={`ai-personality-${participant.id}`}
                          value={participant.personality}
                          disabled={viewState === "saving" ||
                            aiPersonalitySavingId !== ""}
                          onChange={(event) => {
                            const personality =
                              (event.currentTarget as HTMLSelectElement)
                                .value as AiPersonality;
                            setAiParticipants((current) =>
                              current.map((currentParticipant) =>
                                currentParticipant.id === participant.id
                                  ? { ...currentParticipant, personality }
                                  : currentParticipant
                              )
                            );
                          }}
                        >
                          {aiPersonalityOptions.map((option) => (
                            <option key={option.value} value={option.value}>
                              {option.label}
                            </option>
                          ))}
                        </select>
                        <button
                          type="button"
                          class="secondary-button compact-button"
                          disabled={viewState === "saving" ||
                            aiPersonalitySavingId !== ""}
                          onClick={() =>
                            handleSetAiPersonality(participant)}
                        >
                          {aiPersonalitySavingId === participant.id
                            ? "保存中"
                            : "保存"}
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              )}

              <form class="writing-form" onSubmit={handleStartPrompt}>
                <button
                  type="button"
                  class="secondary-button"
                  disabled={viewState === "saving" || promptGenerating}
                  onClick={handleGeneratePrompt}
                >
                  {promptGenerating
                    ? "AIがお題を考えています"
                    : "AIにお題を作ってもらう"}
                </button>
                <label class="field-label" htmlFor="word-input">
                  お題
                </label>
                <input
                  id="word-input"
                  maxLength={80}
                  value={wordInput}
                  disabled={viewState === "saving"}
                  onInput={(event) =>
                    setWordInput(
                      (event.currentTarget as HTMLInputElement).value,
                    )}
                  placeholder="例: しるべ"
                />
                <label class="field-label setting-label" htmlFor="correct">
                  正しい意味
                </label>
                <textarea
                  id="correct"
                  maxLength={1200}
                  value={correctInput}
                  disabled={viewState === "saving"}
                  onInput={(event) =>
                    setCorrectInput(
                      (event.currentTarget as HTMLTextAreaElement).value,
                    )}
                  placeholder="辞書に載っている本当の意味"
                />
                <button type="submit" disabled={viewState === "saving"}>
                  意味提出を開始する
                </button>
              </form>
            </>
          )}

          {!isOwner && (
            <p class="muted">
              ルームマスターがお題を決めるまで待機しています。
            </p>
          )}
        </section>
      )}

      {room.currentPhase === "writing" && (
        <section class="phase-block">
          <div class="prompt-panel">
            <p class="status-label">お題</p>
            <strong>{gameState.prompt?.word}</strong>
          </div>

          {selfMember?.isWriter
            ? (
              <form class="writing-form" onSubmit={handleSubmitDefinition}>
                <label class="field-label" htmlFor="definition">
                  もっともらしい偽の意味
                </label>
                <textarea
                  id="definition"
                  maxLength={1200}
                  value={definitionInput}
                  disabled={viewState === "saving"}
                  onInput={(event) =>
                    setDefinitionInput(
                      (event.currentTarget as HTMLTextAreaElement).value,
                    )}
                  placeholder="正解っぽく、でも嘘の意味を書く"
                />
                <button type="submit" disabled={viewState === "saving"}>
                  {gameState.ownDefinition
                    ? "意味を再提出する"
                    : "意味を提出する"}
                </button>
              </form>
            )
            : (
              <p class="muted">
                今回あなたは回答者ではありません。提出が揃うまで待機します。
              </p>
            )}

          {isOwner && pendingWriters.length === 0 && (
            <p class="published-note">
              全員の意味が揃いました。整形画面に進みます。
            </p>
          )}
          {aiWritingRunning && (
            <p class="muted">AI参加者が意味を書いています。</p>
          )}
        </section>
      )}

      {room.currentPhase === "editing" && (
        <section class="phase-block">
          {isOwner
            ? (
              <>
                <p class="muted">
                  候補は匿名です。表記を整え、公開順を調整してから公開します。
                </p>
                <div class="edit-choice-list">
                  {editChoices.map((choice, index) => (
                    <div class="edit-choice" key={choice.key}>
                      <div class="edit-choice-heading">
                        <b>{choice.isCorrect ? "正解" : `候補 ${index + 1}`}</b>
                        <span>
                          <button
                            type="button"
                            class="icon-button"
                            disabled={index === 0 || viewState === "saving"}
                            onClick={() =>
                              moveEditChoice(index, -1)}
                            aria-label="上へ"
                          >
                            ↑
                          </button>
                          <button
                            type="button"
                            class="icon-button"
                            disabled={index === editChoices.length - 1 ||
                              viewState === "saving"}
                            onClick={() =>
                              moveEditChoice(index, 1)}
                            aria-label="下へ"
                          >
                            ↓
                          </button>
                        </span>
                      </div>
                      <textarea
                        maxLength={1200}
                        value={choice.body}
                        disabled={viewState === "saving"}
                        onInput={(event) => {
                          const body =
                            (event.currentTarget as HTMLTextAreaElement).value;
                          setEditChoices((current) =>
                            current.map((currentChoice) =>
                              currentChoice.key === choice.key
                                ? { ...currentChoice, body }
                                : currentChoice
                            )
                          );
                        }}
                      />
                    </div>
                  ))}
                </div>
                <button
                  type="button"
                  disabled={viewState === "saving"}
                  onClick={handlePublishChoices}
                >
                  候補を公開する
                </button>
              </>
            )
            : <p class="muted">ルームマスターが候補を整えています。</p>}
        </section>
      )}

      {room.currentPhase === "voting" && (
        <section class="phase-block">
          <p class="muted">正しいと思う意味を1つ選びます。</p>
          {selfMember?.isVoter
            ? (
              <form class="choice-list" onSubmit={handleSubmitVote}>
                {gameState.choices.map((choice) => (
                  <label class="choice-option" key={choice.id}>
                    <input
                      type="radio"
                      name="choice"
                      value={choice.id}
                      checked={voteChoiceId === choice.id}
                      disabled={choice.isOwn || viewState === "saving"}
                      onChange={(event) =>
                        setVoteChoiceId(
                          (event.currentTarget as HTMLInputElement).value,
                        )}
                    />
                    <span>{choice.body}</span>
                    {choice.isOwn && <b>自分の候補</b>}
                  </label>
                ))}
                <button
                  type="submit"
                  disabled={!voteChoiceId || viewState === "saving"}
                >
                  {gameState.ownVoteChoiceId ? "投票を変更する" : "投票する"}
                </button>
              </form>
            )
            : <p class="muted">今回は投票対象外です。結果公開を待ちます。</p>}

          {isOwner && pendingVoters.length === 0 && (
            <button
              type="button"
              class="secondary-button"
              disabled={viewState === "saving"}
              onClick={handleRevealResults}
            >
              結果を公開する
            </button>
          )}
        </section>
      )}

      {room.currentPhase === "results" && (
        <section class="phase-block results-block">
          <div class="prompt-panel">
            <p class="status-label">正しい意味</p>
            <strong>{gameState.prompt?.word}</strong>
            <p>{gameState.prompt?.correctDefinition}</p>
          </div>

          <div class="result-choice-list">
            {gameState.results.map((choice) => (
              <article
                class={choice.isCorrect
                  ? "result-choice correct-choice"
                  : "result-choice"}
                key={choice.id}
              >
                <p>{choice.body}</p>
                <div class="result-meta">
                  <span>
                    {choice.isCorrect
                      ? "正解"
                      : `作成: ${choice.submittedByUsername ?? "不明"}`}
                  </span>
                  <b>{choice.voteCount}票</b>
                </div>
                {choice.voters.length > 0 && (
                  <small>投票: {choice.voters.join("、")}</small>
                )}
              </article>
            ))}
          </div>

          <div class="score-board">
            <p class="status-label">得点</p>
            {gameState.scores.map((score) => (
              <div class="score-row" key={score.userId}>
                <span>{score.username}</span>
                <small>
                  正解 {score.correctPoints} / だまし {score.bluffPoints}
                </small>
                <b>{score.totalPoints}</b>
              </div>
            ))}
          </div>
        </section>
      )}

      <section class="member-block">
        <p class="field-label">参加者 {members.length}人</p>
        <ul class="member-list">
          {members.map((member) => (
            <li key={member.userId}>
              <span>{member.username}</span>
              <span class="member-badges">
                {member.isMaster && <b>親</b>}
                {member.isAi && <b>AI</b>}
                {member.isWriter && room.currentPhase === "writing" && (
                  <b>{member.hasSubmitted ? "提出済み" : "執筆中"}</b>
                )}
                {member.isVoter && room.currentPhase === "voting" && (
                  <b>{member.hasVoted ? "投票済み" : "投票待ち"}</b>
                )}
              </span>
            </li>
          ))}
        </ul>
      </section>

      <a class="secondary-link-button" href="/">トップページに戻る</a>
    </div>
  );
}
