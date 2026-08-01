import type { Handlers, PageProps } from "$fresh/server.ts";
import HomeApp from "../islands/HomeApp.tsx";

export type AuthPageData = {
  supabaseUrl: string;
  supabaseAnonKey: string;
  isConfigured: boolean;
};

export const handler: Handlers<AuthPageData> = {
  GET(_req, ctx) {
    const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
    const supabaseAnonKey = Deno.env.get("SUPABASE_ANON_KEY") ?? "";

    return ctx.render({
      supabaseUrl,
      supabaseAnonKey,
      isConfigured: supabaseUrl.length > 0 && supabaseAnonKey.length > 0,
    });
  },
};

export default function Home({ data }: PageProps<AuthPageData>) {
  return (
    <main class="shell">
      <section class="home-layout" aria-labelledby="page-title">
        <div class="brand-block">
          <p class="eyebrow">Besti-a-lie</p>
          <h1 id="page-title">たほいや</h1>
          <p class="lead">
            ありそうでなさそうな意味を書き、正しい語義を見抜く言葉のブラフゲーム。
          </p>
          <div class="feature-panel">
            <p class="status-label">遊び方</p>
            <p>
              ルームマスターがお題と正しい意味を決め、参加者はもっともらしい偽の意味を書きます。
            </p>
            <p>
              集まった候補を整えて公開したら、全員で正解だと思う意味に投票します。
            </p>
          </div>
        </div>

        <HomeApp
          supabaseUrl={data.supabaseUrl}
          supabaseAnonKey={data.supabaseAnonKey}
          isConfigured={data.isConfigured}
        />
      </section>
    </main>
  );
}
