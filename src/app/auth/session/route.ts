import {
  assertSameOrigin,
  createSessionFromChallenge,
  currentAuthUser,
  setAuthCookie,
} from "@/lib/auth";
import { jsonError } from "@/lib/api-errors";
import { clientFingerprint, enforceRateLimit } from "@/lib/rate-limit";

export const runtime = "nodejs";
const AUTH_SESSION_LIMIT = Number(process.env.MESHACTION_AUTH_SESSION_LIMIT ?? 10);
const AUTH_SESSION_WINDOW_MS = Number(
  process.env.MESHACTION_AUTH_SESSION_WINDOW_MS ?? 5 * 60_000
);

export async function GET() {
  try {
    const user = await currentAuthUser();
    return Response.json({ authenticated: Boolean(user), user });
  } catch (error) {
    return jsonError(error, "auth session unavailable");
  }
}

export async function POST(request: Request) {
  try {
    assertSameOrigin(request);
    const body = (await request.json().catch(() => ({}))) as {
      challenge_id?: string;
      signature?: string;
    };
    if (!body.challenge_id?.trim() || !body.signature?.trim()) {
      return Response.json(
        { error: "challenge_id and signature are required" },
        { status: 400 }
      );
    }
    await enforceRateLimit({
      bucket: "auth_session",
      subject: `${body.challenge_id.trim()}:${clientFingerprint(request)}`,
      limit: AUTH_SESSION_LIMIT,
      windowMs: AUTH_SESSION_WINDOW_MS,
    });
    const session = await createSessionFromChallenge({
      challengeId: body.challenge_id.trim(),
      signature: body.signature.trim(),
    });
    await setAuthCookie(session.cookie);
    return Response.json({
      authenticated: true,
      user: session.user,
    });
  } catch (error) {
    return jsonError(error, "wallet sign-in failed");
  }
}
