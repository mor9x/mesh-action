export function errorMessage(error: unknown, fallback: string) {
  return error instanceof Error ? error.message : fallback;
}

export function jsonError(error: unknown, fallback: string, status = 500) {
  return Response.json(
    { error: errorMessage(error, fallback) },
    { status: status === 500 ? statusForError(error) : status }
  );
}

export function statusForError(error: unknown) {
  const message = errorMessage(error, "").toLowerCase();
  if (
    message.includes("unsupported semantic_type") ||
    message.includes("content is required") ||
    message.includes("requires signed_at_ms") ||
    message.includes("invalid sui address") ||
    message.includes("unsupported action type") ||
    message.includes("does not support") ||
    message.includes("not identity verified") ||
    message.includes("endpoint is not http") ||
    message.includes("endpoint must use https") ||
    message.includes("endpoint must be an http") ||
    message.includes("endpoint must not include credentials") ||
    message.includes("endpoint resolves to") ||
    message.includes("endpoint did not resolve") ||
    message.includes("registration")
  ) {
    return 400;
  }
  if (message.includes("not found")) {
    return 404;
  }
  if (message.includes("wallet sign-in required")) {
    return 401;
  }
  if (
    message.includes("not authorized") ||
    message.includes("belongs to another user") ||
    message.includes("cross-origin")
  ) {
    return 403;
  }
  if (
    message.includes("already executed") ||
    message.includes("duplicate") ||
    message.includes("approved policy decision is required") ||
    message.includes("policy did not approve") ||
    message.includes("requires_confirmation") ||
    message.includes("is disabled") ||
    message.includes("rejected")
  ) {
    return 409;
  }
  if (
    message.includes("rate limit") ||
    message.includes("too many requests") ||
    message.includes("retry later")
  ) {
    return 429;
  }
  if (
    message.includes("econnrefused") ||
    message.includes("database") ||
    message.includes("missing sui signer") ||
    message.includes("sui signer is not configured") ||
    message.includes("runtime signer unavailable") ||
    message.includes("suimesh_sui_private_key") ||
    message.includes("suimesh_sui_keystore_entry") ||
    message.includes("suimesh_trace_registry_id") ||
    message.includes("trace registry") ||
    message.includes("fetch failed")
  ) {
    return 503;
  }
  return 500;
}
