import { getTrace } from "@/lib/suimesh-service";
import { jsonError } from "@/lib/api-errors";
import { requireAuth } from "@/lib/auth";

export const runtime = "nodejs";
export const maxDuration = 120;

type Params = { params: Promise<{ id: string }> };

export async function GET(request: Request, { params }: Params) {
  const { id } = await params;
  try {
    const user = await requireAuth();
    const trace = await getTrace(id, user.user_id);
    if (!trace) {
      return Response.json({ error: "trace not found", trace_id: id }, { status: 404 });
    }

    return Response.json(trace);
  } catch (error) {
    return jsonError(error, "trace restore failed");
  }
}
