import { getSessionGraph } from "@/lib/suimesh-service";
import { jsonError } from "@/lib/api-errors";
import { requireAuth } from "@/lib/auth";

export const runtime = "nodejs";
export const maxDuration = 120;

type Params = { params: Promise<{ id: string }> };

export async function GET(request: Request, { params }: Params) {
  const { id } = await params;
  try {
    const user = await requireAuth();
    const url = new URL(request.url);
    const semanticType = url.searchParams.get("semantic_type");

    return Response.json({
      session_id: id,
      graph: await getSessionGraph(id, semanticType, user.user_id),
    });
  } catch (error) {
    return jsonError(error, "session graph unavailable");
  }
}
