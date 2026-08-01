import {
  createClient,
  type SupabaseClient,
  type User,
} from "@supabase/supabase-js";
import { useEffect, useMemo, useState } from "preact/hooks";
import LoginForm, { type AuthProfile } from "./LoginForm.tsx";

type Props = {
  supabaseUrl: string;
  supabaseAnonKey: string;
  isConfigured: boolean;
};

type HomeState = "checking" | "needs-auth" | "ready" | "creating" | "error";

type Profile = {
  id: string;
  username: string;
};

type RoomPhase =
  | "waiting"
  | "prompt"
  | "checking"
  | "writing"
  | "editing"
  | "voting"
  | "results";

type JoinedRoom = {
  id: string;
  ownerId: string;
  currentPhase: RoomPhase;
  word: string | null;
  createdAt: string;
  joinedAt: string;
};

type RoomMemberRow = {
  room_id: string;
  joined_at: string;
};

type RoomRow = {
  id: string;
  owner_id: string;
  current_phase: RoomPhase;
  current_round: number;
  created_at: string;
};

type PromptRow = {
  room_id: string;
  round_number: number;
  word: string;
};

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

export default function HomeApp(
  { supabaseUrl, supabaseAnonKey, isConfigured }: Props,
) {
  const [state, setState] = useState<HomeState>(
    isConfigured ? "checking" : "error",
  );
  const [user, setUser] = useState<User | null>(null);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [joinedRooms, setJoinedRooms] = useState<JoinedRoom[]>([]);
  const [isEditingUsername, setIsEditingUsername] = useState(false);
  const [usernameInput, setUsernameInput] = useState("");
  const [message, setMessage] = useState("");

  const supabase = useMemo(
    () => makeClient(supabaseUrl, supabaseAnonKey),
    [supabaseUrl, supabaseAnonKey],
  );

  useEffect(() => {
    if (!isConfigured || !supabase) {
      setMessage("SUPABASE_URL と SUPABASE_ANON_KEY を設定してください。");
      setState("error");
      return;
    }

    let isMounted = true;
    const client = supabase;

    async function loadJoinedRooms(sessionUser: User) {
      const { data: memberRows, error: memberError } = await client
        .from("room_members")
        .select("room_id, joined_at")
        .eq("user_id", sessionUser.id)
        .order("joined_at", { ascending: false })
        .returns<RoomMemberRow[]>();

      if (memberError) throw memberError;

      const roomIds = memberRows?.map((row) => row.room_id) ?? [];
      if (roomIds.length === 0) return [];

      const { data: roomRows, error: roomError } = await client
        .from("rooms")
        .select("id, owner_id, current_phase, current_round, created_at")
        .in("id", roomIds)
        .returns<RoomRow[]>();

      if (roomError) throw roomError;

      const { data: promptRows, error: promptError } = await client
        .from("prompts")
        .select("room_id, round_number, word")
        .in("room_id", roomIds)
        .returns<PromptRow[]>();

      if (promptError) throw promptError;

      const roomsById = new Map((roomRows ?? []).map((room) => [
        room.id,
        room,
      ]));
      const wordsByRoomId = new Map(
        (promptRows ?? []).flatMap((prompt) => {
          const room = roomsById.get(prompt.room_id);
          if (!room || room.current_round !== prompt.round_number) return [];
          return [[prompt.room_id, prompt.word] as const];
        }),
      );

      return (memberRows ?? []).flatMap((memberRow) => {
        const room = roomsById.get(memberRow.room_id);
        if (!room) return [];

        return [{
          id: room.id,
          ownerId: room.owner_id,
          currentPhase: room.current_phase,
          word: wordsByRoomId.get(room.id) ?? null,
          createdAt: room.created_at,
          joinedAt: memberRow.joined_at,
        }];
      });
    }

    async function loadSession() {
      const { data, error } = await client.auth.getSession();
      if (!isMounted) return;

      if (error) {
        setMessage(error.message);
        setState("error");
        return;
      }

      const sessionUser = data.session?.user ?? null;
      if (!sessionUser) {
        setState("needs-auth");
        return;
      }

      const { data: profileData, error: profileError } = await client
        .from("profiles")
        .select("id, username")
        .eq("id", sessionUser.id)
        .single<Profile>();

      if (!isMounted) return;

      if (profileError || !profileData) {
        setMessage(profileError?.message ?? "プロフィールを取得できません。");
        setState("error");
        return;
      }

      let nextJoinedRooms: JoinedRoom[] = [];
      try {
        nextJoinedRooms = await loadJoinedRooms(sessionUser);
      } catch (roomsError) {
        if (!isMounted) return;
        setMessage(
          roomsError instanceof Error
            ? roomsError.message
            : "参加した部屋を取得できません。",
        );
      }

      setUser(sessionUser);
      setProfile(profileData);
      setUsernameInput(profileData.username);
      setJoinedRooms(nextJoinedRooms);
      setState("ready");
    }

    loadSession();

    return () => {
      isMounted = false;
    };
  }, [isConfigured, supabase]);

  function handleAuthenticated(authProfile: AuthProfile) {
    setUser(authProfile.user);
    setProfile({ id: authProfile.user.id, username: authProfile.username });
    setUsernameInput(authProfile.username);
    setJoinedRooms([]);
    setMessage("");
    setState("ready");
  }

  async function handleUpdateUsername(event: Event) {
    event.preventDefault();
    if (!supabase || !user) return;

    const nextUsername = usernameInput.trim();
    if (nextUsername.length < 2 || nextUsername.length > 24) {
      setMessage("ユーザネームは2〜24文字で入力してください。");
      return;
    }

    setMessage("");
    const { error } = await supabase
      .from("profiles")
      .update({ username: nextUsername, updated_at: new Date().toISOString() })
      .eq("id", user.id);

    if (error) {
      setMessage(error.message);
      return;
    }

    setProfile({ id: user.id, username: nextUsername });
    setIsEditingUsername(false);
  }

  async function handleCreateRoom() {
    if (!supabase || !user) return;

    setMessage("");
    setState("creating");

    const { data: room, error: roomError } = await supabase
      .from("rooms")
      .insert({ owner_id: user.id })
      .select("id")
      .single<{ id: string }>();

    if (roomError || !room) {
      setMessage(roomError?.message ?? "部屋を作成できませんでした。");
      setState("error");
      return;
    }

    const { error: memberError } = await supabase.rpc("join_room", {
      target_room_id: room.id,
    });

    if (memberError) {
      setMessage(memberError.message);
      setState("error");
      return;
    }

    globalThis.location.href = `/rooms/${room.id}`;
  }

  async function handleSignOut() {
    if (!supabase) return;

    await supabase.auth.signOut();
    setUser(null);
    setProfile(null);
    setJoinedRooms([]);
    setIsEditingUsername(false);
    setUsernameInput("");
    setMessage("");
    setState("needs-auth");
  }

  function formatRoomDate(value: string) {
    return new Intl.DateTimeFormat("ja-JP", {
      month: "numeric",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    }).format(new Date(value));
  }

  function formatRoomPhase(phase: RoomPhase) {
    if (phase === "waiting") return "待合";
    if (phase === "prompt") return "出題";
    if (phase === "checking") return "既知確認";
    if (phase === "writing") return "意味提出";
    if (phase === "editing") return "整形";
    if (phase === "voting") return "投票";
    return "結果";
  }

  if (state === "checking") {
    return (
      <div class="card" aria-live="polite">
        <p class="status-text">セッションを確認しています。</p>
      </div>
    );
  }

  if (state === "needs-auth") {
    return (
      <LoginForm
        supabaseUrl={supabaseUrl}
        supabaseAnonKey={supabaseAnonKey}
        isConfigured={isConfigured}
        onAuthenticated={handleAuthenticated}
      />
    );
  }

  return (
    <div class="card">
      <p class="status-label">ログイン中</p>
      <div class="profile-heading">
        <h2>{profile?.username ?? "名無しの回答者"}</h2>
        <button
          type="button"
          class="secondary-button compact-button"
          onClick={() => {
            setUsernameInput(profile?.username ?? "");
            setIsEditingUsername((current) => !current);
          }}
        >
          {isEditingUsername ? "閉じる" : "名前変更"}
        </button>
      </div>
      {isEditingUsername && (
        <form class="username-edit-form" onSubmit={handleUpdateUsername}>
          <label class="field-label" htmlFor="username-edit">
            ユーザネーム
          </label>
          <div class="share-row">
            <input
              id="username-edit"
              type="text"
              maxLength={24}
              value={usernameInput}
              onInput={(event) =>
                setUsernameInput(
                  (event.currentTarget as HTMLInputElement).value,
                )}
            />
            <button type="submit" class="compact-button">
              保存
            </button>
          </div>
        </form>
      )}
      <p class="muted">
        部屋を作ると共有URLが発行されます。参加者は同じURLから入室できます。
      </p>
      {message && <p class="form-message" role="alert">{message}</p>}
      <button
        type="button"
        onClick={handleCreateRoom}
        disabled={state === "creating" || state === "error"}
      >
        {state === "creating" ? "部屋を作っています" : "部屋を作る"}
      </button>

      <section class="joined-rooms-block">
        <p class="field-label">参加した部屋</p>
        {joinedRooms.length === 0
          ? <p class="muted">まだ参加した部屋はありません。</p>
          : (
            <ul class="joined-room-list">
              {joinedRooms.map((room) => (
                <li key={room.id}>
                  <a href={`/rooms/${room.id}`}>
                    <span>{room.word ?? "お題未設定の部屋"}</span>
                    <b>{formatRoomPhase(room.currentPhase)}</b>
                    <small>参加 {formatRoomDate(room.joinedAt)}</small>
                  </a>
                </li>
              ))}
            </ul>
          )}
      </section>

      <button
        type="button"
        class="secondary-button"
        onClick={handleSignOut}
      >
        サインアウト
      </button>
    </div>
  );
}
