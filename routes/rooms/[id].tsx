import type { Handlers, PageProps } from "$fresh/server.ts";
import RoomLobby from "../../islands/RoomLobby.tsx";
import type { AuthPageData } from "../index.tsx";

type RoomPageData = AuthPageData & {
  roomId: string;
};

export const handler: Handlers<RoomPageData> = {
  GET(_req, ctx) {
    const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
    const supabaseAnonKey = Deno.env.get("SUPABASE_ANON_KEY") ?? "";

    return ctx.render({
      roomId: ctx.params.id,
      supabaseUrl,
      supabaseAnonKey,
      isConfigured: supabaseUrl.length > 0 && supabaseAnonKey.length > 0,
    });
  },
};

export default function RoomPage({ data }: PageProps<RoomPageData>) {
  return (
    <main class="shell">
      <section class="room-layout" aria-label="部屋">
        <RoomLobby
          roomId={data.roomId}
          supabaseUrl={data.supabaseUrl}
          supabaseAnonKey={data.supabaseAnonKey}
          isConfigured={data.isConfigured}
        />
      </section>
    </main>
  );
}
