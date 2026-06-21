import { createSession, listSessions } from "@/lib/suimesh-service";
import { jsonError } from "@/lib/api-errors";
import { assertSameOrigin, requireAuth } from "@/lib/auth";

export const runtime = "nodejs";
export const maxDuration = 120;

export async function GET(request: Request) {
  try {
    const user = await requireAuth();
    const url = new URL(request.url);
    const limit = Number(url.searchParams.get("limit") ?? 20);

    return Response.json({
      sessions: await listSessions(user.user_id, Number.isFinite(limit) ? limit : 20),
    });
  } catch (error) {
    return jsonError(error, "session index unavailable");
  }
}

export async function POST(request: Request) {
  try {
    assertSameOrigin(request);
  } catch (error) {
    return jsonError(error, "session creation failed");
  }
  const body = (await request.json().catch(() => ({}))) as {
    semantic_type?: unknown;
    content?: string;
    session_id?: string;
  };

  try {
    const user = await requireAuth();
    const created = await createSession({
      semanticType: body.semantic_type,
      content: body.content,
      sessionId: body.session_id,
      ownerUserId: user.user_id,
    });
    return Response.json(created, { status: 201 });
  } catch (error) {
    return jsonError(error, "session creation failed");
  }
}
