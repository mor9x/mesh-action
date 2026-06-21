import { evaluateTrace } from "@/lib/suimesh-service";
import { jsonError } from "@/lib/api-errors";
import { assertSameOrigin, requireAuth } from "@/lib/auth";

export const runtime = "nodejs";
export const maxDuration = 120;

type Params = { params: Promise<{ id: string }> };

export async function POST(request: Request, { params }: Params) {
  try {
    assertSameOrigin(request);
  } catch (error) {
    return jsonError(error, "evaluation failed");
  }
  const { id } = await params;
  const body = (await request.json().catch(() => ({}))) as {
    semantic_type?: unknown;
    confirmed?: boolean;
    session_id?: string;
  };
  try {
    const user = await requireAuth();
    const result = await evaluateTrace({
      traceId: id,
      ownerUserId: user.user_id,
      sessionId: body.session_id,
      semanticType: body.semantic_type,
      confirmed: body.confirmed,
    });

    return Response.json(result);
  } catch (error) {
    return jsonError(error, "evaluation failed");
  }
}
