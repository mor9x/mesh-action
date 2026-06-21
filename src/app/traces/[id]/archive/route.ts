import { getTraceArchive } from "@/lib/suimesh-service";
import { requireAuth } from "@/lib/auth";
import { jsonError } from "@/lib/api-errors";

export const runtime = "nodejs";
export const maxDuration = 120;

type Params = { params: Promise<{ id: string }> };

export async function GET(_request: Request, { params }: Params) {
  const { id } = await params;
  try {
    const user = await requireAuth();
    const archive = await getTraceArchive(id, user.user_id);
    if (!archive) {
      return Response.json(
        { error: "trace not found", trace_id: id },
        { status: 404 }
      );
    }
    return Response.json(archive);
  } catch (error) {
    return jsonError(error, "archive restore failed");
  }
}
