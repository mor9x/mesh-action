import { executeTrace } from "@/lib/suimesh-service";
import { jsonError } from "@/lib/api-errors";
import { assertSameOrigin, requireAuth } from "@/lib/auth";

export const runtime = "nodejs";
export const maxDuration = 120;

type Params = { params: Promise<{ id: string }> };

export async function POST(request: Request, { params }: Params) {
  try {
    assertSameOrigin(request);
  } catch (error) {
    return jsonError(error, "execution failed");
  }
  const { id } = await params;
  const body = (await request.json().catch(() => ({}))) as {
    semantic_type?: unknown;
    policy_approved?: boolean;
    confirmed?: boolean;
  };

  try {
    const user = await requireAuth();
    const result = await executeTrace({
      traceId: id,
      ownerUserId: user.user_id,
      semanticType: body.semantic_type,
      policyApproved: body.policy_approved,
      confirmed: body.confirmed,
    });
    return Response.json(result);
  } catch (error) {
    return jsonError(error, "execution failed");
  }
}
