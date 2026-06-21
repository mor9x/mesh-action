import { disableAgent } from "@/lib/suimesh-service";
import { jsonError } from "@/lib/api-errors";
import { assertSameOrigin, requireAuth } from "@/lib/auth";

export const runtime = "nodejs";
export const maxDuration = 120;

type Params = { params: Promise<{ id: string }> };

export async function POST(request: Request, { params }: Params) {
  try {
    assertSameOrigin(request);
  } catch (error) {
    return jsonError(error, "agent disable failed");
  }

  const { id } = await params;
  try {
    const user = await requireAuth();
    const result = await disableAgent(decodeURIComponent(id), user.user_id);
    return Response.json(result);
  } catch (error) {
    return jsonError(error, "agent disable failed");
  }
}
