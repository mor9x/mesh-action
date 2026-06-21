import type {
  ActionAnchor,
  ActionClaim,
  ContextRef,
  EventEnvelope,
  EventTransport,
  ExecutionReceipt,
  StorageAdapter,
  TraceGuard,
  PolicyDecision,
} from "suimesh";
import { hashBytes, hashJson } from "suimesh";
import { query, withTransaction } from "@/lib/db";

const DEFAULT_ACTION_TTL_MS = 10 * 60_000;
const DEFAULT_CLAIM_LEASE_MS = 2 * 60_000;
const LOCAL_ANONYMOUS_CLAIMANT = "local:anonymous";

type AnchorRow = {
  anchor: ActionAnchor;
};

function envelopeHash(envelope: EventEnvelope) {
  return envelope.eventHash ?? hashJson(envelope as never);
}

function isZeroAddress(address: string) {
  return /^0x0+$/.test(address);
}

export class PgEventTransport implements EventTransport {
  async send(envelope: EventEnvelope): Promise<void> {
    await query(
      `
        insert into suimesh_events (
          event_hash,
          event_id,
          session_id,
          trace_id,
          event_type,
          actor,
          previous_event_hash,
          created_at_ms,
          envelope
        )
        values ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb)
        on conflict (event_hash) do nothing
      `,
      [
        envelopeHash(envelope),
        envelope.eventId,
        envelope.sessionId,
        envelope.traceId ?? null,
        envelope.eventType,
        envelope.actor,
        envelope.previousEventHash ?? null,
        envelope.createdAtMs ?? null,
        JSON.stringify(envelope),
      ]
    );
  }

  async list(sessionId: string): Promise<EventEnvelope[]> {
    const result = await query<{ envelope: EventEnvelope }>(
      `
        select envelope
        from suimesh_events
        where session_id = $1
        order by id asc
      `,
      [sessionId]
    );
    return result.rows.map((row) => row.envelope);
  }

  async subscribe(
    sessionId: string,
    handler: (envelope: EventEnvelope) => void | Promise<void>
  ): Promise<() => void> {
    const seen = new Set<string>();
    const timer = setInterval(async () => {
      const events = await this.list(sessionId);
      for (const envelope of events) {
        const hash = envelopeHash(envelope);
        if (!seen.has(hash)) {
          seen.add(hash);
          await handler(envelope);
        }
      }
    }, 1_000);
    return () => clearInterval(timer);
  }
}

export class PgTraceGuard implements TraceGuard {
  async anchor(input: {
    traceId: string;
    actionHash: string;
    proposalHash?: string;
    decisionHash?: string;
    owner?: string;
    authorizedExecutor?: string;
    expiresAtMs?: number;
    nowMs?: number;
  }): Promise<ActionAnchor> {
    const nowMs = input.nowMs ?? Date.now();
    const existing = await this.getAnchor(input.actionHash);
    if (isTerminalAnchor(existing)) {
      return existing!;
    }
    const expiresAtMs =
      input.expiresAtMs ?? existing?.expiresAtMs ?? nowMs + DEFAULT_ACTION_TTL_MS;
    if (expiresAtMs <= nowMs) {
      throw new Error("Cannot anchor an already expired action");
    }
    if (input.authorizedExecutor && isZeroAddress(input.authorizedExecutor)) {
      throw new Error("Cannot anchor action with zero authorized executor");
    }

    const anchor: ActionAnchor = {
      anchorId:
        existing?.anchorId ??
        hashJson({ traceId: input.traceId, actionHash: input.actionHash } as never),
      traceId: input.traceId,
      actionHash: input.actionHash,
      proposalHash: input.proposalHash ?? existing?.proposalHash,
      decisionHash: input.decisionHash ?? existing?.decisionHash,
      receiptHash: existing?.receiptHash,
      owner: input.owner ?? existing?.owner,
      authorizedExecutor: input.authorizedExecutor ?? existing?.authorizedExecutor,
      claimant: existing?.claimant,
      status: "anchored",
      expiresAtMs,
      claimExpiresAtMs: existing?.claimExpiresAtMs,
      createdAtMs: existing?.createdAtMs ?? nowMs,
      updatedAtMs: nowMs,
    };

    await query(
      `
        insert into suimesh_trace_anchors (action_hash, anchor)
        values ($1, $2::jsonb)
        on conflict (action_hash) do update
        set anchor = excluded.anchor,
            updated_at = now()
      `,
      [input.actionHash, JSON.stringify(anchor)]
    );

    return anchor;
  }

  async claim(input: {
    actionHash: string;
    decision: PolicyDecision;
    claimant?: string;
    claimLeaseMs?: number;
    nowMs?: number;
  }): Promise<ActionClaim> {
    if (input.decision.decision !== "approved") {
      throw new Error("Cannot claim an action without approved PolicyDecision");
    }

    return withTransaction(async (client) => {
      const nowMs = input.nowMs ?? Date.now();
      const result = await client.query<AnchorRow>(
        `
          select anchor
          from suimesh_trace_anchors
          where action_hash = $1
          for update
        `,
        [input.actionHash]
      );
      const anchor = result.rows[0]?.anchor;
      if (!anchor) {
        throw new Error("Cannot claim unanchored action");
      }
      if (isTerminalAnchor(anchor)) {
        return {
          claimId: hashJson({
            actionHash: input.actionHash,
            decisionHash: input.decision.evaluatedFactsHash,
          } as never),
          actionHash: input.actionHash,
          claimant:
            input.claimant ??
            anchor.claimant ??
            anchor.authorizedExecutor ??
            LOCAL_ANONYMOUS_CLAIMANT,
          claimed: false,
          duplicate: true,
          claimExpiresAtMs: anchor.claimExpiresAtMs,
          createdAtMs: nowMs,
        };
      }
      if (anchor.expiresAtMs !== undefined && anchor.expiresAtMs <= nowMs) {
        throw new Error("Cannot claim expired action");
      }
      if (
        anchor.authorizedExecutor &&
        input.claimant &&
        input.claimant !== anchor.authorizedExecutor
      ) {
        throw new Error("Cannot claim action with unauthorized executor");
      }

      const duplicate =
        anchor.status === "claimed" &&
        (anchor.claimExpiresAtMs ?? Number.POSITIVE_INFINITY) > nowMs;
      const claimant =
        input.claimant ?? anchor.authorizedExecutor ?? LOCAL_ANONYMOUS_CLAIMANT;
      const claimLeaseMs = input.claimLeaseMs ?? DEFAULT_CLAIM_LEASE_MS;
      if (claimLeaseMs <= 0) {
        throw new Error("Cannot claim action with non-positive claim lease");
      }
      const claimExpiresAtMs = nowMs + claimLeaseMs;

      if (!duplicate) {
        const next: ActionAnchor = {
          ...anchor,
          claimant,
          status: "claimed",
          claimExpiresAtMs,
          updatedAtMs: nowMs,
        };
        await client.query(
          `
            update suimesh_trace_anchors
            set anchor = $2::jsonb,
                updated_at = now()
            where action_hash = $1
          `,
          [input.actionHash, JSON.stringify(next)]
        );
      }

      return {
        claimId: hashJson({
          actionHash: input.actionHash,
          decisionHash: input.decision.evaluatedFactsHash,
        } as never),
        actionHash: input.actionHash,
        claimant,
        claimed: !duplicate,
        duplicate,
        claimExpiresAtMs: duplicate ? anchor.claimExpiresAtMs : claimExpiresAtMs,
        createdAtMs: nowMs,
      };
    });
  }

  async complete(input: {
    actionHash: string;
    receipt: ExecutionReceipt;
    nowMs?: number;
  }): Promise<ActionAnchor> {
    return withTransaction(async (client) => {
      const nowMs = input.nowMs ?? Date.now();
      const result = await client.query<AnchorRow>(
        `
          select anchor
          from suimesh_trace_anchors
          where action_hash = $1
          for update
        `,
        [input.actionHash]
      );
      const anchor = result.rows[0]?.anchor;
      if (!anchor) {
        throw new Error("Cannot complete unanchored action");
      }
      if (anchor.status !== "claimed") {
        throw new Error("Cannot complete unclaimed action");
      }
      const executorAddress = input.receipt.executor.address;
      if (anchor.claimant && executorAddress && executorAddress !== anchor.claimant) {
        throw new Error("Cannot complete action with unauthorized claimant");
      }
      if (anchor.expiresAtMs !== undefined && anchor.expiresAtMs <= nowMs) {
        throw new Error("Cannot complete expired action");
      }
      if (
        anchor.claimExpiresAtMs !== undefined &&
        anchor.claimExpiresAtMs <= nowMs
      ) {
        throw new Error("Cannot complete action after claim lease expired");
      }

      const next: ActionAnchor = {
        ...anchor,
        receiptHash: hashJson(input.receipt as never),
        status: input.receipt.status === "success" ? "executed" : "failed",
        updatedAtMs: nowMs,
      };
      await client.query(
        `
          update suimesh_trace_anchors
          set anchor = $2::jsonb,
              updated_at = now()
          where action_hash = $1
        `,
        [input.actionHash, JSON.stringify(next)]
      );
      return next;
    });
  }

  async fail(input: {
    actionHash: string;
    reason: string;
    claimant?: string;
    nowMs?: number;
  }): Promise<ActionAnchor> {
    return withTransaction(async (client) => {
      const nowMs = input.nowMs ?? Date.now();
      const result = await client.query<AnchorRow>(
        `
          select anchor
          from suimesh_trace_anchors
          where action_hash = $1
          for update
        `,
        [input.actionHash]
      );
      const anchor = result.rows[0]?.anchor;
      if (!anchor) {
        throw new Error("Cannot fail unanchored action");
      }
      if (anchor.status !== "claimed") {
        throw new Error("Cannot fail unclaimed action");
      }
      if (anchor.claimant && input.claimant && input.claimant !== anchor.claimant) {
        throw new Error("Cannot fail action with unauthorized claimant");
      }
      const next: ActionAnchor = {
        ...anchor,
        status: "failed",
        updatedAtMs: nowMs,
      };
      await client.query(
        `
          update suimesh_trace_anchors
          set anchor = $2::jsonb,
              updated_at = now()
          where action_hash = $1
        `,
        [input.actionHash, JSON.stringify(next)]
      );
      return next;
    });
  }

  async getAnchor(actionHash: string): Promise<ActionAnchor | undefined> {
    const result = await query<AnchorRow>(
      `
        select anchor
        from suimesh_trace_anchors
        where action_hash = $1
      `,
      [actionHash]
    );
    return result.rows[0]?.anchor;
  }
}

function isTerminalAnchor(anchor: ActionAnchor | undefined) {
  return (
    anchor !== undefined &&
    (anchor.status === "executed" ||
      anchor.status === "failed" ||
      anchor.receiptHash !== undefined)
  );
}

export class PgStorageAdapter implements StorageAdapter {
  provider = "local" as const;

  async put(input: {
    bytes: Uint8Array;
    contentType?: string;
    encrypted?: boolean;
  }): Promise<ContextRef> {
    const digest = hashBytes(input.bytes);
    const blobId = `pg:${digest}`;
    await query(
      `
        insert into suimesh_blobs (
          blob_id,
          digest,
          content_type,
          encrypted,
          bytes
        )
        values ($1, $2, $3, $4, $5)
        on conflict (blob_id) do nothing
      `,
      [
        blobId,
        digest,
        input.contentType ?? null,
        input.encrypted ?? true,
        Buffer.from(input.bytes),
      ]
    );
    return {
      provider: "local",
      blobId,
      digest,
      contentType: input.contentType,
      encrypted: input.encrypted ?? true,
    };
  }

  async get(ref: ContextRef): Promise<Uint8Array | undefined> {
    const result = await query<{ bytes: Buffer }>(
      `
        select bytes
        from suimesh_blobs
        where blob_id = $1
          and digest = $2
      `,
      [ref.blobId, ref.digest]
    );
    const bytes = result.rows[0]?.bytes;
    return bytes ? new Uint8Array(bytes) : undefined;
  }
}
