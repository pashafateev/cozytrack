import { notFound } from "next/navigation";
import { db } from "@/lib/db";
import { verifyInviteToken } from "@/lib/auth";
import JoinForm from "./JoinForm";

// Guest invite landing page. Validates the token server-side, shows a minimal
// "enter your name" form, and POSTs to /api/auth/accept-invite which sets a
// session-scoped guest cookie.
export default async function JoinPage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;
  const payload = await verifyInviteToken(token);
  if (!payload) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-neutral-950 text-neutral-100 px-4">
        <div className="max-w-sm space-y-2 text-center">
          <h1 className="text-xl font-semibold">Invite link invalid or expired</h1>
          <p className="text-sm text-neutral-400">
            Ask your host to send a fresh link.
          </p>
        </div>
      </div>
    );
  }

  const session = await db.session.findUnique({
    where: { id: payload.sessionId },
    select: { id: true, name: true },
  });
  if (!session) notFound();

  return <JoinForm token={token} sessionName={session.name} sessionId={session.id} />;
}

export const dynamic = "force-dynamic";
