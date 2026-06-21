import { getSessionMessages, postSessionMessage } from "@/lib/suimesh-service";
import { jsonError } from "@/lib/api-errors";
import { assertSameOrigin, requireAuth } from "@/lib/auth";

export const runtime = "nodejs";
export const maxDuration = 120;

type Params = { params: Promise<{ id: string }> };

export async function GET(request: Request, { params }: Params) {
  const { id } = await params;
  try {
    const user = await requireAuth();
    const url = new URL(request.url);

    return Response.json(
      await getSessionMessages({
        sessionId: id,
        ownerUserId: user.user_id,
        semanticType: url.searchParams.get("semantic_type"),
      })
    );
  } catch (error) {
    return jsonError(error, "session messages unavailable");
  }
}

export async function POST(request: Request, { params }: Params) {
  try {
    assertSameOrigin(request);
  } catch (error) {
    return jsonError(error, "session message failed");
  }
  const { id } = await params;
  const body = (await request.json().catch(() => ({}))) as {
    content?: string;
    semantic_type?: unknown;
    byo_agent_id?: string;
  };
  if (!body.content?.trim()) {
    return Response.json({ error: "content is required" }, { status: 400 });
  }

  try {
    const user = await requireAuth();
    const result = await postSessionMessage({
      sessionId: id,
      ownerUserId: user.user_id,
      content: body.content.trim(),
      semanticType: body.semantic_type,
      byoAgentId: body.byo_agent_id,
    });
    return Response.json(result, { status: 201 });
  } catch (error) {
    return jsonError(error, "session message failed");
  }
}
