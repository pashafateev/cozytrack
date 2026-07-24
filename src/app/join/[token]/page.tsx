import { notFound } from "next/navigation";
import { db } from "@/lib/db";
import { verifyInviteToken } from "@/lib/auth";
import { Aurora } from "@/components/ui/Aurora";
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
      <div className="relative min-h-screen flex items-center justify-center overflow-hidden bg-bg px-4">
        <Aurora variant="auth" />
        <div className="relative max-w-sm space-y-2 text-center">
          <h1 className="text-xl font-extrabold tracking-[-0.02em] text-text">
            Invite link invalid or expired
          </h1>
          <p className="text-sm text-text-2">
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
