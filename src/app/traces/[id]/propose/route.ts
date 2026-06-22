import { proposeTrace } from "@/lib/suimesh-service";
import { jsonError } from "@/lib/api-errors";
import { assertSameOrigin, requireAuth } from "@/lib/auth";

export const runtime = "nodejs";
export const maxDuration = 120;

type Params = { params: Promise<{ id: string }> };

export async function POST(request: Request, { params }: Params) {
  try {
    assertSameOrigin(request);
  } catch (error) {
    return jsonError(error, "proposal failed");
  }
  const { id } = await params;
  const body = (await request.json().catch(() => ({}))) as {
    semantic_type?: unknown;
    session_id?: string;
    byo_agent_id?: string;
    force_reprepare?: boolean;
  };
  try {
    const user = await requireAuth();
    const result = await proposeTrace({
      traceId: id,
      ownerUserId: user.user_id,
      sessionId: body.session_id,
      semanticType: body.semantic_type,
      byoAgentId: body.byo_agent_id,
      forceReprepare: body.force_reprepare === true,
    });

    return Response.json(result, { status: 201 });
  } catch (error) {
    return jsonError(error, "proposal failed");
  }
}
