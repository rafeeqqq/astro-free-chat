import Chat from "./Chat";

export const dynamic = "force-dynamic";

export default async function ChatPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  return <Chat token={token} />;
}
