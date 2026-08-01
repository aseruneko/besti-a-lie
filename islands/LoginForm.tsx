import {
  createClient,
  type SupabaseClient,
  type User,
} from "@supabase/supabase-js";
import { useEffect, useMemo, useState } from "preact/hooks";

type Props = {
  supabaseUrl: string;
  supabaseAnonKey: string;
  isConfigured: boolean;
  onAuthenticated?: (profile: AuthProfile) => void;
};

type Profile = {
  id: string;
  username: string;
};

export type AuthProfile = {
  user: User;
  username: string;
};

type FormState = "checking" | "ready" | "submitting" | "registered" | "error";

function validateUsername(value: string): string | null {
  const name = value.trim();
  const length = Array.from(name).length;

  if (length < 2) return "ユーザネームは2文字以上にしてください。";
  if (length > 24) return "ユーザネームは24文字以内にしてください。";
  if (/[\r\n\t]/.test(name)) return "改行やタブは使えません。";
  if (!/^[\p{L}\p{N}_\- 　]+$/u.test(name)) {
    return "文字、数字、スペース、ハイフン、アンダースコアだけ使えます。";
  }

  return null;
}

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

export default function LoginForm(
  { supabaseUrl, supabaseAnonKey, isConfigured, onAuthenticated }: Props,
) {
  const [username, setUsername] = useState("");
  const [registeredName, setRegisteredName] = useState("");
  const [userId, setUserId] = useState("");
  const [message, setMessage] = useState("");
  const [state, setState] = useState<FormState>(
    isConfigured ? "checking" : "error",
  );

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

    async function loadSession() {
      const { data: sessionData, error: sessionError } = await client.auth
        .getSession();

      if (!isMounted) return;

      if (sessionError) {
        setMessage(sessionError.message);
        setState("error");
        return;
      }

      const user = sessionData.session?.user;
      if (!user) {
        setState("ready");
        return;
      }

      const { data: profile } = await client
        .from("profiles")
        .select("username")
        .eq("id", user.id)
        .maybeSingle<Pick<Profile, "username">>();

      const loadedName = profile?.username ??
        String(user.user_metadata?.username ?? "名無しの回答者");
      setUserId(user.id);
      setRegisteredName(loadedName);
      setState("registered");
      onAuthenticated?.({ user, username: loadedName });
    }

    loadSession();

    return () => {
      isMounted = false;
    };
  }, [isConfigured, supabase]);

  async function saveProfile(client: SupabaseClient, user: User, name: string) {
    return await client.from("profiles").upsert({
      id: user.id,
      username: name,
      updated_at: new Date().toISOString(),
    }, {
      onConflict: "id",
    }).select("id, username").single<Pick<Profile, "id" | "username">>();
  }

  async function handleSubmit(event: Event) {
    event.preventDefault();

    if (!supabase) {
      setMessage("Supabase の設定が見つかりません。");
      setState("error");
      return;
    }

    const name = username.trim();
    const validationError = validateUsername(name);
    if (validationError) {
      setMessage(validationError);
      setState("ready");
      return;
    }

    setMessage("");
    setState("submitting");

    const { data: sessionData, error: sessionError } = await supabase.auth
      .getSession();

    if (sessionError) {
      setMessage(sessionError.message);
      setState("error");
      return;
    }

    let user = sessionData.session?.user ?? null;

    if (!user) {
      const { data, error } = await supabase.auth.signInAnonymously({
        options: {
          data: { username: name },
        },
      });

      if (error || !data.user) {
        setMessage(error?.message ?? "匿名サインインに失敗しました。");
        setState("error");
        return;
      }

      user = data.user;
    }

    const { data: profile, error: profileError } = await saveProfile(
      supabase,
      user,
      name,
    );

    if (profileError || !profile) {
      setMessage(profileError?.message ?? "プロフィールの保存に失敗しました。");
      setState("error");
      return;
    }

    setUserId(profile.id);
    setRegisteredName(profile.username);
    setState("registered");
    onAuthenticated?.({ user, username: profile.username });
  }

  async function handleSignOut() {
    if (!supabase) return;

    await supabase.auth.signOut();
    setRegisteredName("");
    setUserId("");
    setUsername("");
    setMessage("");
    setState("ready");
  }

  if (state === "checking") {
    return (
      <div class="card" aria-live="polite">
        <p class="status-text">セッションを確認しています。</p>
      </div>
    );
  }

  if (state === "registered") {
    return (
      <div class="card success-card">
        <p class="status-label">ログイン中</p>
        <h2>{registeredName}</h2>
        <p class="muted">このブラウザでは、次回も同じ名前で遊べます。</p>
        <p class="user-id">user: {userId}</p>
        <button type="button" class="secondary-button" onClick={handleSignOut}>
          サインアウト
        </button>
      </div>
    );
  }

  return (
    <form class="card" onSubmit={handleSubmit}>
      <label class="field-label" htmlFor="username">
        ユーザネーム
      </label>
      <input
        id="username"
        name="username"
        type="text"
        inputMode="text"
        autoComplete="nickname"
        minLength={2}
        maxLength={24}
        value={username}
        disabled={!isConfigured || state === "submitting"}
        onInput={(event) =>
          setUsername((event.currentTarget as HTMLInputElement).value)}
        placeholder="例: 辞書読み"
      />

      {message && <p class="form-message" role="alert">{message}</p>}

      <button
        type="submit"
        disabled={!isConfigured || state === "submitting"}
      >
        {state === "submitting" ? "登録しています" : "この名前ではじめる"}
      </button>
    </form>
  );
}
