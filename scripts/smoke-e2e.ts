import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import type { Socket } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";

import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import pg from "pg";

import { agentRegistrationMessage } from "@/lib/agent-identity";
import type { ActionType, AgentManifest } from "@/lib/suimesh-data";
import {
  buildSuiCopyTradePtbBytes,
  buildSuiDemoMoveCallPtbBytes,
  buildSuiTransferPtbBytes,
} from "@/lib/sui-executor";
import { loadLocalEnv } from "./load-env";

const { Pool } = pg;

loadLocalEnv();

const BASE_URL = process.env.MESHACTION_SMOKE_BASE_URL ?? "http://localhost:3000";
const DATABASE_URL = process.env.DATABASE_URL?.trim();
const EXPECT_LLM = process.env.MESHACTION_SMOKE_EXPECT_LLM === "true";
const LLM_MODEL = process.env.MESHACTION_LLM_MODEL ?? "gpt-4.1-mini";
const SMOKE_PORT = Number(process.env.MESHACTION_SMOKE_BYO_PORT ?? 4020);
const REMOTE_BYO_ENDPOINT = process.env.MESHACTION_SMOKE_BYO_ENDPOINT?.trim();
const TRANSFER_EXPECTED_POLICY = "approved";
const CONTRACT_EXPECTED_POLICY = "approved";
const COPY_EXPECTED_POLICY = "requires_confirmation";

type RequestOptions = {
  method?: string;
  body?: Record<string, unknown>;
  cookie?: string;
  expect?: number;
};

const encoder = new TextEncoder();
const pool = DATABASE_URL ? new Pool({ connectionString: DATABASE_URL }) : undefined;

function assert(condition: unknown, message: string, details?: unknown): asserts condition {
  if (!condition) {
    throw new Error(
      `${message}${details === undefined ? "" : `\n${JSON.stringify(details, null, 2)}`}`
    );
  }
}

function runtimeKeypair() {
  const expectedAddress =
    process.env.MESHACTION_SMOKE_WALLET_ADDRESS ??
    process.env.SUIMESH_SUI_ADDRESS;
  const envEntry =
    process.env.MESHACTION_SMOKE_KEYSTORE_ENTRY ??
    process.env.SUIMESH_SUI_KEYSTORE_ENTRY;
  const entry = envEntry ?? cliKeystoreEntry(expectedAddress);
  const bytes = Buffer.from(entry, "base64");
  if (bytes[0] !== 0) {
    throw new Error(`unsupported Sui CLI key scheme ${bytes[0]}`);
  }
  return Ed25519Keypair.fromSecretKey(bytes.slice(1));
}

function cliKeystoreEntry(expectedAddress?: string) {
  const candidates = [
    join(process.cwd(), ".sui/sui.keystore"),
    join(homedir(), ".sui/sui_config/sui.keystore"),
  ];

  for (const file of candidates) {
    try {
      const entries = JSON.parse(readFileSync(file, "utf8")) as string[];
      if (expectedAddress) {
        const normalized = expectedAddress.toLowerCase();
        for (const entry of entries) {
          const bytes = Buffer.from(entry, "base64");
          if (bytes[0] !== 0) {
            continue;
          }
          const keypair = Ed25519Keypair.fromSecretKey(bytes.slice(1));
          if (keypair.getPublicKey().toSuiAddress().toLowerCase() === normalized) {
            return entry;
          }
        }
        continue;
      }
      const entry = entries[0];
      if (entry) {
        return entry;
      }
    } catch {
      continue;
    }
  }

  throw new Error("No Sui CLI keystore entry found");
}

async function request<T>(path: string, options: RequestOptions = {}) {
  const response = await fetch(`${BASE_URL}${path}`, {
    method: options.method ?? "GET",
    headers: {
      ...(options.body ? { "content-type": "application/json" } : {}),
      ...(options.cookie ? { cookie: options.cookie } : {}),
    },
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  const text = await response.text();
  let data: unknown;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  if (options.expect !== undefined && response.status !== options.expect) {
    throw new Error(
      `${options.method ?? "GET"} ${path} expected ${options.expect}, got ${response.status}: ${text}`
    );
  }
  return { response, data: data as T, text };
}

async function login() {
  const keypair = runtimeKeypair();
  const walletAddress =
    process.env.MESHACTION_SMOKE_WALLET_ADDRESS ??
    process.env.SUIMESH_SUI_ADDRESS ??
    keypair.getPublicKey().toSuiAddress();
  assert(
    keypair.getPublicKey().toSuiAddress().toLowerCase() === walletAddress.toLowerCase(),
    "Smoke signer does not match wallet address",
    { walletAddress }
  );

  const unauth = await request<{ error?: string }>("/sessions", {
    method: "POST",
    body: { semantic_type: "transfer" },
    expect: 401,
  });
  assert(
    unauth.data.error?.toLowerCase().includes("wallet sign-in"),
    "Unauthenticated /sessions did not require wallet",
    unauth.data
  );

  const challenge = await request<{
    challenge_id: string;
    message: string;
  }>("/auth/challenge", {
    method: "POST",
    body: { wallet_address: walletAddress },
    expect: 201,
  });
  const signed = await keypair.signPersonalMessage(
    encoder.encode(challenge.data.message)
  );
  const session = await request<{ authenticated: boolean }>("/auth/session", {
    method: "POST",
    body: {
      challenge_id: challenge.data.challenge_id,
      signature: signed.signature,
    },
    expect: 200,
  });
  const setCookie = session.response.headers.get("set-cookie");
  assert(setCookie, "Auth session did not set a cookie", session.data);
  assert(session.data.authenticated === true, "Wallet session was not authenticated");
  return { cookie: setCookie.split(";")[0], walletAddress };
}

async function registerByoAgent(cookie: string, endpoint: string, keypair: Ed25519Keypair) {
  const supportedSemanticTypes: ActionType[] = [
    "transfer",
    "contract_call",
    "copy_trade",
  ];
  const manifest: AgentManifest = {
    agent_id: `agent_byo_full_smoke_${Date.now()}`,
    display_name: "Full BYO Smoke Agent",
    kind: "byo",
    capabilities: [
      "event_envelope",
      "proposal",
      "ptb_action",
      "follower_ptb",
      "receipt_sign",
    ],
    supported_semantic_types: supportedSemanticTypes,
    endpoint,
    signing_address: keypair.getPublicKey().toSuiAddress(),
    memory_provider: "external://smoke/full-byo",
    required_policy_checks: ["registered_identity", "signature_valid"],
  };
  const signedAtMs = Date.now();
  const signature = (
    await keypair.signPersonalMessage(
      encoder.encode(agentRegistrationMessage(manifest, signedAtMs))
    )
  ).signature;
  const registered = await request<{ agent: AgentManifest }>("/agents/register", {
    method: "POST",
    cookie,
    body: {
      ...manifest,
      signed_at_ms: signedAtMs,
      registration_signature: signature,
    },
    expect: 201,
  });
  assert(
    registered.data.agent.identity_verified === true,
    "BYO registration was not identity verified",
    registered.data
  );
  return manifest.agent_id;
}

async function relayEvidence(sessionId: string, traceId: string) {
  if (!pool) {
    return undefined;
  }
  const result = await pool.query<{
    event_type: string;
    actor: string;
    previous_event_hash: string | null;
    envelope: {
      traceId?: string;
      payload?: Record<string, unknown>;
    };
  }>(
    `
      select event_type, actor, previous_event_hash, envelope
      from suimesh_events
      where session_id = $1
      order by id asc
    `,
    [sessionId]
  );
  const rows = result.rows.filter(
    (row) => !row.envelope.traceId || row.envelope.traceId === traceId
  );
  const eventTypes = new Set(rows.map((row) => row.event_type));
  const hostedProposalEvents = rows.filter(
    (row) =>
      row.event_type === "decision.proposal.v1" &&
      row.envelope.payload?.kind === "hosted_agent_proposal"
  );
  const hostedAuditEvents = rows.filter(
    (row) =>
      row.event_type === "decision.proposal.v1" &&
      row.envelope.payload?.kind === "hosted_agent_audit_approval"
  );

  return {
    eventCount: rows.length,
    linkedEvents: rows.filter((row) => row.previous_event_hash).length,
    hostedProposalEvents: hostedProposalEvents.length,
    hostedAuditEvents: hostedAuditEvents.length,
    proposalModels: hostedProposalEvents.map((row) => row.envelope.payload?.model),
    auditModels: hostedAuditEvents.map((row) => row.envelope.payload?.model),
    auditDecisions: hostedAuditEvents.map(
      (row) => row.envelope.payload?.decision
    ),
    hasPolicyDecision: eventTypes.has("decision.policy_decision.v1"),
    hasActionAnchor: eventTypes.has("trace.action_anchor.v1"),
    hasActionClaim: eventTypes.has("trace.action_claim.v1"),
    hasExecutionReceipt: eventTypes.has("outcome.execution_receipt.v1"),
    hasAuditEvent: eventTypes.has("outcome.audit_event.v1"),
  };
}

async function runAction(input: {
  cookie: string;
  byoAgentId: string;
  semanticType: ActionType;
  expectedFirstDecision: "approved" | "requires_confirmation";
}) {
  const created = await request<{
    session: { session_id: string; trace_id: string };
  }>("/sessions", {
    method: "POST",
    cookie: input.cookie,
    body: {
      semantic_type: input.semanticType,
      content: `Full BYO smoke ${input.semanticType} ${Date.now()}`,
    },
    expect: 201,
  });
  const sessionId = created.data.session.session_id;
  const traceId = created.data.session.trace_id;
  const proposed = await request<{
    proposal: {
      hosted_agents?: {
        proposal_agent?: { model?: string };
        audit_agent?: { model?: string; decision?: string };
      };
      byo_agent?: { agent_id?: string; action_override_accepted?: boolean };
    };
  }>(`/traces/${traceId}/propose`, {
    method: "POST",
    cookie: input.cookie,
    body: {
      session_id: sessionId,
      semantic_type: input.semanticType,
      byo_agent_id: input.byoAgentId,
    },
    expect: 201,
  });
  assert(
    proposed.data.proposal.byo_agent?.agent_id === input.byoAgentId,
    `${input.semanticType} did not use the selected BYO agent`,
    proposed.data.proposal.byo_agent
  );
  assert(
    proposed.data.proposal.byo_agent?.action_override_accepted === true,
    `${input.semanticType} did not accept BYO action override`,
    proposed.data.proposal.byo_agent
  );
  if (EXPECT_LLM) {
    assert(
      proposed.data.proposal.hosted_agents?.proposal_agent?.model === LLM_MODEL,
      `${input.semanticType} hosted proposal agent did not use ${LLM_MODEL}`,
      proposed.data.proposal.hosted_agents
    );
    assert(
      proposed.data.proposal.hosted_agents?.audit_agent?.model === LLM_MODEL,
      `${input.semanticType} hosted audit agent did not use ${LLM_MODEL}`,
      proposed.data.proposal.hosted_agents
    );
  }

  const evaluated = await request<{
    policy_decision: { status: "approved" | "requires_confirmation" | "rejected" };
  }>(`/traces/${traceId}/evaluate`, {
    method: "POST",
    cookie: input.cookie,
    body: {
      session_id: sessionId,
      semantic_type: input.semanticType,
      confirmed: false,
    },
    expect: 200,
  });
  assert(
    evaluated.data.policy_decision.status === input.expectedFirstDecision,
    `${input.semanticType} first policy decision mismatch`,
    evaluated.data
  );

  const executed = await request<{
    claim?: { claimed?: boolean; duplicate?: boolean };
    receipt?: {
      txDigest?: string;
      archive_status?: string;
      archive_provider?: string;
    };
  }>(`/traces/${traceId}/execute`, {
    method: "POST",
    cookie: input.cookie,
    body: {
      semantic_type: input.semanticType,
      policy_approved: true,
      confirmed: true,
    },
    expect: 200,
  });
  assert(
    executed.data.claim?.claimed === true && executed.data.claim.duplicate === false,
    `${input.semanticType} claim was not unique`,
    executed.data.claim
  );
  assert(executed.data.receipt?.txDigest, `${input.semanticType} missing tx digest`);
  assert(
    executed.data.receipt.archive_status === "archived",
    `${input.semanticType} archive did not complete`,
    executed.data.receipt
  );

  const duplicate = await request<{ error?: string }>(`/traces/${traceId}/execute`, {
    method: "POST",
    cookie: input.cookie,
    body: {
      semantic_type: input.semanticType,
      policy_approved: true,
      confirmed: true,
    },
  });
  assert(
    duplicate.response.status === 409,
    `${input.semanticType} duplicate execute should be blocked`,
    duplicate.data
  );

  const archive = await request<{
    archive?: { restored?: { status?: string; digestVerified?: boolean } };
  }>(`/traces/${traceId}/archive`, {
    cookie: input.cookie,
    expect: 200,
  });
  assert(
    archive.data.archive?.restored?.status === "verified" &&
      archive.data.archive.restored.digestVerified === true,
    `${input.semanticType} archive restore failed`,
    archive.data.archive?.restored
  );

  const trace = await request<{
    trace?: { verification?: { ok?: boolean } };
  }>(`/traces/${traceId}`, {
    cookie: input.cookie,
    expect: 200,
  });
  assert(
    trace.data.trace?.verification?.ok === true,
    `${input.semanticType} trace verification failed`,
    trace.data.trace?.verification
  );

  const relay = await relayEvidence(sessionId, traceId);
  if (relay) {
    assert(
      relay.hasPolicyDecision &&
        relay.hasActionAnchor &&
        relay.hasActionClaim &&
        relay.hasExecutionReceipt &&
        relay.hasAuditEvent,
      `${input.semanticType} protocol relay incomplete`,
      relay
    );
    if (EXPECT_LLM) {
      assert(
        relay.hostedProposalEvents >= 1 && relay.hostedAuditEvents >= 1,
        `${input.semanticType} hosted agent relay incomplete`,
        relay
      );
    }
  }

  return {
    semanticType: input.semanticType,
    sessionId,
    traceId,
    txDigest: executed.data.receipt.txDigest,
    firstPolicyDecision: evaluated.data.policy_decision.status,
    archiveProvider: executed.data.receipt.archive_provider,
    archiveStatus: archive.data.archive.restored.status,
    verification: trace.data.trace.verification.ok,
    relay,
  };
}

async function actionPtbBytes(input: {
  semanticType: ActionType;
  traceId: string;
  sourceTraceId?: string;
}) {
  if (input.semanticType === "transfer") {
    return buildSuiTransferPtbBytes();
  }
  if (input.semanticType === "contract_call") {
    return buildSuiDemoMoveCallPtbBytes({
      traceId: input.traceId,
      semanticType: "move_call",
    });
  }
  assert(input.sourceTraceId, "copy_trade BYO request did not include source_trace_id");
  return buildSuiCopyTradePtbBytes({
    sourceTraceId: input.sourceTraceId,
    followerTraceId: input.traceId,
    maxExposureMist: "1200000000",
  });
}

async function main() {
  const byoKeypair = REMOTE_BYO_ENDPOINT
    ? runtimeKeypair()
    : new Ed25519Keypair();
  let byoInvocations = 0;
  const sockets = new Set<Socket>();
  const server = REMOTE_BYO_ENDPOINT
    ? undefined
    : createServer(async (request, response) => {
    try {
      if (request.method !== "POST" || request.url !== "/suimesh") {
        response.writeHead(404, { connection: "close" }).end("not found");
        return;
      }
      const chunks: Buffer[] = [];
      for await (const chunk of request) {
        chunks.push(Buffer.from(chunk));
      }
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
        challenge_message: string;
        challenge?: { traceId?: string; semanticType?: ActionType; sourceTraceId?: string };
        context_refs?: { source_trace_id?: string };
      };
      const semanticType = body.challenge?.semanticType;
      assert(semanticType, "BYO request missing semantic type");
      const traceId = body.challenge?.traceId;
      assert(traceId, "BYO request missing trace id");

      byoInvocations += 1;
      const signature = (
        await byoKeypair.signPersonalMessage(encoder.encode(body.challenge_message))
      ).signature;
      const ptbBytes = await actionPtbBytes({
        semanticType,
        traceId,
        sourceTraceId:
          body.context_refs?.source_trace_id ?? body.challenge?.sourceTraceId,
      });
      response.writeHead(200, {
        "content-type": "application/json",
        connection: "close",
      });
      response.end(
        JSON.stringify({
          proposal: `Signed ${semanticType} PTB from Full BYO Smoke Agent.`,
          signing_address: byoKeypair.getPublicKey().toSuiAddress(),
          signature,
          action: { ptbBytes: Buffer.from(ptbBytes).toString("base64url") },
        })
      );
    } catch (error) {
      response.writeHead(500, {
        "content-type": "text/plain",
        connection: "close",
      });
      response.end(error instanceof Error ? error.stack ?? error.message : String(error));
    }
  });
  server?.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => {
      sockets.delete(socket);
    });
  });

  if (server) {
    await new Promise<void>((resolve) => server.listen(SMOKE_PORT, "127.0.0.1", resolve));
  }
  try {
    const { cookie, walletAddress } = await login();
    const runtimeStatus = await request<{ runtime?: { ok?: boolean } }>(
      "/runtime/status",
      { expect: 200 }
    );
    assert(runtimeStatus.data.runtime?.ok === true, "Runtime status is not OK");
    const byoAgentId = await registerByoAgent(
      cookie,
      REMOTE_BYO_ENDPOINT ?? `http://127.0.0.1:${SMOKE_PORT}/suimesh`,
      byoKeypair
    );
    const transfer = await runAction({
      cookie,
      byoAgentId,
      semanticType: "transfer",
      expectedFirstDecision: TRANSFER_EXPECTED_POLICY,
    });
    const contractCall = await runAction({
      cookie,
      byoAgentId,
      semanticType: "contract_call",
      expectedFirstDecision: CONTRACT_EXPECTED_POLICY,
    });
    const copyTrade = await runAction({
      cookie,
      byoAgentId,
      semanticType: "copy_trade",
      expectedFirstDecision: COPY_EXPECTED_POLICY,
    });
    if (!REMOTE_BYO_ENDPOINT) {
      assert(byoInvocations >= 3, "BYO agent was not invoked for all action types", {
        byoInvocations,
      });
    }

    const disabled = await request<{ agent?: AgentManifest }>(
      `/agents/${encodeURIComponent(byoAgentId)}/disable`,
      { method: "POST", cookie, body: {}, expect: 200 }
    );
    assert(disabled.data.agent?.enabled === false, "BYO agent was not disabled");

    console.log(
      JSON.stringify(
        {
          ok: true,
          walletAddress,
          byoAgentId,
          byoInvocations,
          results: [transfer, contractCall, copyTrade],
        },
        null,
        2
      )
    );
  } finally {
    for (const socket of sockets) {
      socket.destroy();
    }
    if (server) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    await pool?.end();
  }
}

await main();
