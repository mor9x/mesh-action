import { query } from "@/lib/db";

export class RateLimitError extends Error {
  constructor(message = "Too many requests. Retry later.") {
    super(message);
    this.name = "RateLimitError";
  }
}

export function clientFingerprint(request: Request) {
  const forwardedFor = request.headers.get("x-forwarded-for");
  const firstForwarded = forwardedFor?.split(",")[0]?.trim();
  return (
    firstForwarded ||
    request.headers.get("cf-connecting-ip") ||
    request.headers.get("x-real-ip") ||
    request.headers.get("user-agent") ||
    "unknown"
  );
}

export async function enforceRateLimit(input: {
  bucket: string;
  subject: string;
  limit: number;
  windowMs: number;
}) {
  const windowStart = new Date(
    Math.floor(Date.now() / input.windowMs) * input.windowMs
  );
  const result = await query<{ count: number }>(
    `
      insert into suimesh_rate_limits (bucket, subject, window_start, count)
      values ($1, $2, $3, 1)
      on conflict (bucket, subject) do update
      set window_start = case
            when suimesh_rate_limits.window_start = excluded.window_start
              then suimesh_rate_limits.window_start
            else excluded.window_start
          end,
          count = case
            when suimesh_rate_limits.window_start = excluded.window_start
              then suimesh_rate_limits.count + 1
            else 1
          end,
          updated_at = now()
      returning count
    `,
    [input.bucket, input.subject, windowStart]
  );
  const count = result.rows[0]?.count ?? 0;
  if (count > input.limit) {
    throw new RateLimitError(`Rate limit exceeded for ${input.bucket}. Retry later.`);
  }
}
