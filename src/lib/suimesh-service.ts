import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

import {
  Encodings,
  EventTypes,
  LocalActionRegistry,
  createDefaultPolicy,
  createSuiMeshClient,
  encodeEvent,
  hashJson,
  ptbBytesFromBase64Url,
  type ActionAnchor,
  type ActionClaim,
  type ActionManifest,
  type ActionRegistryEntry,
  type Actor,
  type EventEnvelope,
  type ExecutionReceipt,
  type JsonValue,
  type Policy,
  type PolicyDecision,
  type PolicyRule,
  type PtbInspectionResult,
  type SuiMeshClient,
  type SuiPtbAction,
} from "suimesh";

import { query } from "@/lib/db";
import {
  archiveRefs,
  createSuimeshStorageAdapter,
  encryptArchive,
  restoreArchiveRefs,
} from "@/lib/archive-storage";
import {
  byoAgentChallengeMessage,
  verifyAgentRegistration,
  verifyByoAgentResponse,
  type AgentRegistrationProof,
  type ByoAgentChallenge,
} from "@/lib/agent-identity";
import {
  assertProtocolReadyForAnchor,
  createProtocolEventTransport,
  createProtocolTraceGuard,
  ensureProtocolSessionGroup,
} from "@/lib/suimesh-canonical";
import {
  getHostedAgentRuntimeStatus,
  runHostedAuditAgent,
  runHostedProposalAgent,
  type HostedAuditAgentResult,
  type HostedProposalAgentResult,
} from "@/lib/llm-hosted-agents";
import {
  SUI_COPY_MAX_EXPOSURE_MIST,
  SUI_DEMO_PACKAGE_ID,
  SUI_TRANSFER_AMOUNT_MIST,
  SUI_TRANSFER_RECIPIENT,
  buildSuiCopyTradePtbBytes,
  buildSuiDemoMoveCallPtbBytes,
  buildSuiTransferPtbBytes,
  decodeSuiCopyTradePtbArgs,
  devInspectSuiPtb,
  executeSuiPtbBytes,
  getSuiRuntimeAddress,
} from "@/lib/sui-executor";
import {
  actionDefinitions,
  agentManifests,
  getWorkflowGraph as getWorkflowGraphTemplate,
  isActionType,
  type ActionType,
  type AgentManifest,
  type ChatMessage,
  type NodeStatus,
  type TraceEvent,
  type WorkflowGraph,
} from "@/lib/suimesh-data";

const TRANSFER_RECIPIENT = SUI_TRANSFER_RECIPIENT;
const DEMO_PACKAGE_ID = SUI_DEMO_PACKAGE_ID;
const COPY_PACKAGE_ID = SUI_DEMO_PACKAGE_ID;
const ACTION_TTL_MS = 10 * 60_000;
const CLAIM_LEASE_MS = 2 * 60_000;
const RESERVED_AGENT_IDS = new Set(
  agentManifests.map((manifest) => manifest.agent_id)
);
const LEGACY_BUILT_IN_AGENT_IDS = [
  "agent_openai_proposal",
  "agent_openai_auditor",
  "agent_llm_proposal",
  "agent_llm_auditor",
];

const actors = {
  user: { role: "user", id: "console-user", address: "0xuser" },
  agent: {
    role: "agent",
    id: "agent_hosted_orchestrator",
    address: "0xagent",
  },
  copyAgent: {
    role: "agent",
    id: "agent_hosted_copy_runner",
    address: "0xcopyagent",
  },
  meshactionProposalAgent: {
    role: "agent",
    id: "agent_meshaction_proposal",
    address: "meshaction://proposal",
  },
  meshactionAuditAgent: {
    role: "agent",
    id: "agent_meshaction_auditor",
    address: "meshaction://audit",
  },
  policy: { role: "policy", id: "agent_policy_sentinel" },
  executor: {
    role: "executor",
    id: "hosted-executor",
  },
  audit: { role: "system", id: "audit-writer" },
} satisfies Record<string, Actor>;

function executorAddress() {
  const signerAddress = getSuiRuntimeAddress();
  const configuredAddress = process.env.SUIMESH_SUI_EXECUTOR_ADDRESS?.trim();
  if (
    configuredAddress &&
    configuredAddress.toLowerCase() !== signerAddress.toLowerCase()
  ) {
    throw new Error(
      `SUIMESH_SUI_EXECUTOR_ADDRESS ${configuredAddress} does not match signer ${signerAddress}`
    );
  }
  return configuredAddress || signerAddress;
}

type TraceRunRow = {
  trace_id: string;
  session_id: string;
  owner_user_id: string | null;
  semantic_type: ActionType;
  action_hash: string | null;
  action: SuiPtbAction | null;
  inspection: PtbInspectionResult | null;
  decision: PolicyDecision | null;
  anchor: ActionAnchor | null;
  claim: ActionClaim | null;
  receipt: ExecutionReceipt | null;
  status: string;
};

type SessionIndexRow = {
  session_id: string;
  owner_user_id: string | null;
  semantic_type: ActionType;
  status: string;
  updated_at: Date;
  created_at: Date;
};

type SessionRow = {
  session_id: string;
  owner_user_id: string | null;
  semantic_type: ActionType;
  status: string;
  metadata: Record<string, JsonValue>;
};

type AgentRow = {
  agent_id: string;
  owner_user_id: string | null;
  manifest: AgentManifest;
};

type ActionPlan = {
  actionType: ActionType;
  sdkSemanticType: ActionManifest["semanticType"];
  ptbBytes: Uint8Array;
  manifest: Omit<ActionManifest, "actionType" | "ptbHash">;
  proposal: string;
  hostedProposal?: HostedProposalAgentResult;
};

type CopyTradeSource = {
  sourceTraceId: string;
  sourceActionHash: string;
  sourcePtbHash?: string;
  sourceProposalHash?: string;
  status?: string;
};

type VerifiedByoAgentInvocation = {
  agent: AgentManifest;
  challenge: ByoAgentChallenge;
  proposal?: string;
  signature: string;
  actionPtbBytes?: Uint8Array;
};

type TraceVerification = {
  ok: boolean;
  errors: string[];
  scope: "trace";
};

type ByoAgentResponse = {
  proposal?: unknown;
  signature?: unknown;
  signing_address?: unknown;
  action?: unknown;
};

let client: SuiMeshClient | undefined;

function actionRegistry() {
  const demoSelector = `${DEMO_PACKAGE_ID}::demo_action::mark_action`;
  const copySelector = `${COPY_PACKAGE_ID}::demo_action::mirror_leader_ptb`;
  const entries: ActionRegistryEntry[] = [
    {
      packageId: DEMO_PACKAGE_ID,
      module: "demo_action",
      function: "mark_action",
      selector: demoSelector,
      semanticType: "move_call",
      protocolName: "meshaction-demo",
      riskCategory: "low",
      requiredPolicyChecks: ["package_allowlist", "function_allowlist"],
    },
    {
      packageId: COPY_PACKAGE_ID,
      module: "demo_action",
      function: "mirror_leader_ptb",
      selector: copySelector,
      semanticType: "copy_trade",
      protocolName: "meshaction-copy-chain",
      riskCategory: "high",
      requiredPolicyChecks: [
        "package_allowlist",
        "function_allowlist",
        "max_value_at_risk",
        "risk_level_guard",
      ],
    },
  ];

  return new LocalActionRegistry(entries);
}

function suimeshClient() {
  client ??= createSuiMeshClient({
    transport: createProtocolEventTransport(),
    storage: createSuimeshStorageAdapter(),
    simulator: {
      simulate: ({ ptbBytes }) => devInspectSuiPtb({ ptbBytes }),
    },
    traceGuard: createProtocolTraceGuard(),
    actionRegistry: actionRegistry(),
    defaultActor: actors.audit,
  });
  return client;
}

function id(prefix: string) {
  return `${prefix}_${crypto.randomUUID().replaceAll("-", "").slice(0, 16)}`;
}

async function recordProtocolJsonEvent(input: {
  sessionId: string;
  traceId?: string;
  eventType: EventEnvelope["eventType"];
  actor: Actor;
  payload: Record<string, JsonValue | undefined>;
  previousEventHash?: string;
  idempotencyKey?: string;
}) {
  const envelope = encodeEvent({
    encoding: Encodings.JsonV1,
    header: {
      eventId: id("evt"),
      sessionId: input.sessionId,
      traceId: input.traceId,
      eventType: input.eventType,
      actor: input.actor,
      previousEventHash: input.previousEventHash,
      idempotencyKey: input.idempotencyKey,
      createdAtMs: Date.now(),
    },
    payload: input.payload as unknown as JsonValue,
  });
  await suimeshClient().transport.send(envelope);
  return envelope;
}

function resolveActionType(value: unknown, fallback: ActionType = "transfer"): ActionType {
  if (value === undefined || value === null || value === "") {
    return fallback;
  }
  if (isActionType(value)) {
    return value;
  }
  throw new Error(`Unsupported semantic_type: ${String(value)}`);
}

function traceIdFor(sessionId: string, actionType: ActionType) {
  const compact = sessionId.replace(/^session_/, "").replace(/[^a-zA-Z0-9]/g, "");
  return `trace_${compact.slice(0, 14)}_${actionType}`;
}

function leaderTraceIdFor(sessionId: string) {
  const compact = sessionId.replace(/^session_/, "").replace(/[^a-zA-Z0-9]/g, "");
  return `trace_${compact.slice(0, 14)}_copy_trade_leader`;
}

async function latestEventHash(sessionId: string) {
  const events = await suimeshClient().trace.restore(sessionId);
  return events.at(-1)?.eventHash;
}

async function latestUserContent(sessionId: string) {
  const events = await suimeshClient().trace.restore(sessionId);
  for (const event of events.toReversed()) {
    if (event.eventType === EventTypes.UserMessage) {
      const content = decodedPayloadContent(event);
      if (content) {
        return content;
      }
    }
  }
  return undefined;
}

async function latestTraceEventHash(traceId: string, eventType: EventEnvelope["eventType"]) {
  const run = await getRun(traceId);
  const sessionId =
    run?.session_id ??
    `session_${traceId.replace(/[^a-zA-Z0-9]/g, "").slice(0, 16)}`;
  const events = await suimeshClient().trace.restore(sessionId);
  return events
    .toReversed()
    .find(
      (event) =>
        event.traceId === traceId && event.eventType === eventType
    )?.eventHash;
}

async function seedAgentRegistry() {
  await query(
    `
      delete from suimesh_agents
      where agent_id = any($1::text[])
    `,
    [LEGACY_BUILT_IN_AGENT_IDS]
  );
  for (const manifest of agentManifests) {
    await query(
      `
        insert into suimesh_agents (agent_id, owner_user_id, manifest)
        values ($1, null, $2::jsonb)
        on conflict (agent_id) do update
        set manifest = excluded.manifest,
            owner_user_id = null,
            updated_at = now()
      `,
      [manifest.agent_id, JSON.stringify(manifest)]
    );
  }
}

async function assertSessionOwner(sessionId: string, ownerUserId: string) {
  const session = await getSession(sessionId);
  if (!session) {
    return undefined;
  }
  if (session.owner_user_id !== ownerUserId) {
    throw new Error("Session belongs to another user");
  }
  return session;
}

function assertRunOwner(run: TraceRunRow | undefined, ownerUserId: string) {
  if (run && run.owner_user_id !== ownerUserId) {
    throw new Error("Trace belongs to another user");
  }
}

async function ensureSession(
  sessionId: string,
  actionType: ActionType,
  ownerUserId: string
) {
  const existing = await assertSessionOwner(sessionId, ownerUserId);
  await query(
    `
      insert into suimesh_sessions (session_id, owner_user_id, semantic_type, status, metadata)
      values ($1, $2, $3, 'ready', $4::jsonb)
      on conflict (session_id) do update
      set semantic_type = excluded.semantic_type,
          metadata = suimesh_sessions.metadata || excluded.metadata,
          updated_at = now()
    `,
    [sessionId, ownerUserId, actionType, JSON.stringify(existing?.metadata ?? {})]
  );

  const current = await getSession(sessionId);
  const protocolMetadata = await ensureProtocolSessionGroup({
    sessionId,
    name: `MeshAction ${actionType} ${sessionId}`,
    existingMetadata: current?.metadata,
  });
  if (!protocolMetadata) {
    return;
  }
  await query(
    `
      update suimesh_sessions
      set metadata = metadata || $2::jsonb,
          updated_at = now()
      where session_id = $1
    `,
    [sessionId, JSON.stringify(protocolMetadata)]
  );
}

async function getSession(sessionId: string): Promise<SessionRow | undefined> {
  const result = await query<SessionRow>(
    `
      select session_id, owner_user_id, semantic_type, status, metadata
      from suimesh_sessions
      where session_id = $1
    `,
    [sessionId]
  );

  return result.rows[0];
}

async function latestRunForSession(sessionId: string, actionType: ActionType) {
  const result = await query<TraceRunRow>(
    `
      select trace_id, session_id, owner_user_id, semantic_type, action_hash, action, inspection,
             decision, anchor, claim, receipt, status
      from suimesh_trace_runs
      where session_id = $1
        and semantic_type = $2
      order by updated_at desc
      limit 1
    `,
    [sessionId, actionType]
  );

  return result.rows[0];
}

async function getRun(traceId: string): Promise<TraceRunRow | undefined> {
  const result = await query<TraceRunRow>(
    `
      select trace_id, session_id, owner_user_id, semantic_type, action_hash, action, inspection,
             decision, anchor, claim, receipt, status
      from suimesh_trace_runs
      where trace_id = $1
    `,
    [traceId]
  );

  return result.rows[0];
}

async function upsertRun(input: {
  traceId: string;
  sessionId: string;
  ownerUserId: string;
  actionType: ActionType;
  actionHash?: string;
  action?: SuiPtbAction;
  inspection?: PtbInspectionResult;
  decision?: PolicyDecision;
  anchor?: ActionAnchor;
  claim?: ActionClaim;
  receipt?: ExecutionReceipt;
  status: string;
}) {
  await query(
    `
      insert into suimesh_trace_runs (
        trace_id,
        session_id,
        owner_user_id,
        semantic_type,
        action_hash,
        action,
        inspection,
        decision,
        anchor,
        claim,
        receipt,
        status
      )
      values ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8::jsonb, $9::jsonb, $10::jsonb, $11::jsonb, $12)
      on conflict (trace_id) do update
      set session_id = excluded.session_id,
          owner_user_id = excluded.owner_user_id,
          semantic_type = excluded.semantic_type,
          action_hash = coalesce(excluded.action_hash, suimesh_trace_runs.action_hash),
          action = coalesce(excluded.action, suimesh_trace_runs.action),
          inspection = coalesce(excluded.inspection, suimesh_trace_runs.inspection),
          decision = coalesce(excluded.decision, suimesh_trace_runs.decision),
          anchor = coalesce(excluded.anchor, suimesh_trace_runs.anchor),
          claim = coalesce(excluded.claim, suimesh_trace_runs.claim),
          receipt = coalesce(excluded.receipt, suimesh_trace_runs.receipt),
          status = excluded.status,
          updated_at = now()
      where suimesh_trace_runs.owner_user_id = excluded.owner_user_id
    `,
    [
      input.traceId,
      input.sessionId,
      input.ownerUserId,
      input.actionType,
      input.actionHash ?? null,
      input.action ? JSON.stringify(input.action) : null,
      input.inspection ? JSON.stringify(input.inspection) : null,
      input.decision ? JSON.stringify(input.decision) : null,
      input.anchor ? JSON.stringify(input.anchor) : null,
      input.claim ? JSON.stringify(input.claim) : null,
      input.receipt ? JSON.stringify(input.receipt) : null,
      input.status,
    ]
  );
}

async function ensureCopyTradeLeaderSource(
  sessionId: string,
  ownerUserId: string
): Promise<CopyTradeSource> {
  const sourceTraceId = leaderTraceIdFor(sessionId);
  const existing = await getRun(sourceTraceId);
  assertRunOwner(existing, ownerUserId);
  if (existing?.action && existing.inspection) {
    return {
      sourceTraceId,
      sourceActionHash:
        existing.action_hash ?? existing.inspection.facts.actionHash,
      sourcePtbHash: existing.inspection.facts.ptbHash,
      status: existing.status,
    };
  }

  const nowMs = Date.now();
  const ptbBytes = await buildSuiDemoMoveCallPtbBytes({
    traceId: sourceTraceId,
    semanticType: "copy_trade_source",
    packageId: DEMO_PACKAGE_ID,
  });
  const proposed = await suimeshClient().actions.proposePtb({
    sessionId,
    traceId: sourceTraceId,
    actor: actors.copyAgent,
    ptbBytes,
    manifest: {
      actionId: id("act_copy_source"),
      traceId: sourceTraceId,
      semanticType: "move_call",
      template: "move_call",
      summary:
        "Leader source PTB for copy-trade follower trace; records a verifiable on-chain action marker.",
      riskLevel: "low",
      primaryTarget: {
        packageId: DEMO_PACKAGE_ID,
        module: "demo_action",
        function: "mark_action",
      },
      objectsTouched: [],
      policyRequirements: [
        "package_allowlist",
        "function_allowlist",
        "expiration_check",
      ],
      expiresAtMs: nowMs + ACTION_TTL_MS,
      idempotencyKey: `copy_trade_source:${sourceTraceId}`,
    },
    previousEventHash: await latestEventHash(sessionId),
  });
  const inspection = await suimeshClient().actions.simulate(proposed.action);

  await upsertRun({
    traceId: sourceTraceId,
    sessionId,
    ownerUserId,
    actionType: "contract_call",
    actionHash: inspection.facts.actionHash,
    action: proposed.action,
    inspection,
    status: "source_verified",
  });

  return {
    sourceTraceId,
    sourceActionHash: inspection.facts.actionHash,
    sourcePtbHash: inspection.facts.ptbHash,
    sourceProposalHash: proposed.envelope.eventHash,
    status: "source_verified",
  };
}

async function ensureCopyTradeLeaderSourceExecuted(
  sessionId: string,
  ownerUserId: string
) {
  const source = await ensureCopyTradeLeaderSource(sessionId, ownerUserId);
  const run = await getRun(source.sourceTraceId);
  assertRunOwner(run, ownerUserId);
  if (run?.status === "executed") {
    return {
      ...source,
      status: "executed",
    };
  }

  await evaluateTrace({
    traceId: source.sourceTraceId,
    sessionId,
    ownerUserId,
    semanticType: "contract_call",
    confirmed: true,
  });
  await executeTrace({
    traceId: source.sourceTraceId,
    ownerUserId,
    semanticType: "contract_call",
    policyApproved: true,
    confirmed: true,
  });
  const executed = await getRun(source.sourceTraceId);
  return {
    ...source,
    sourceActionHash:
      executed?.action_hash ?? executed?.inspection?.facts.actionHash ?? source.sourceActionHash,
    sourcePtbHash: executed?.inspection?.facts.ptbHash ?? source.sourcePtbHash,
    status: executed?.status ?? "executed",
  };
}

function isHttpEndpoint(endpoint: string) {
  try {
    const url = new URL(endpoint);
    return url.protocol === "https:" || url.protocol === "http:";
  } catch {
    return false;
  }
}

async function assertSafeByoEndpoint(endpoint: string) {
  const url = new URL(endpoint);
  const allowLoopbackEndpoint =
    process.env.SUIMESH_ALLOW_LOCAL_BYO_ENDPOINTS === "true";
  if (url.username || url.password) {
    throw new Error("BYO agent endpoint must not include credentials");
  }
  if (url.protocol === "http:") {
    if (process.env.SUIMESH_ALLOW_INSECURE_BYO_HTTP !== "true") {
      throw new Error("BYO agent endpoint must use HTTPS");
    }
  } else if (url.protocol !== "https:") {
    throw new Error("BYO agent endpoint must be an HTTP(S) URL");
  }

  const hostname = url.hostname.toLowerCase();
  if (
    !allowLoopbackEndpoint &&
    (hostname === "localhost" ||
      hostname.endsWith(".localhost") ||
      hostname === "0.0.0.0")
  ) {
    throw new Error("BYO agent endpoint resolves to a blocked host");
  }

  const literalIpVersion = isIP(hostname);
  const addresses =
    literalIpVersion === 0
      ? await lookup(hostname, { all: true, verbatim: true })
      : [{ address: hostname, family: literalIpVersion }];
  if (addresses.length === 0) {
    throw new Error("BYO agent endpoint did not resolve");
  }
  for (const address of addresses) {
    if (
      isBlockedNetworkAddress(address.address, address.family) &&
      !(allowLoopbackEndpoint && isLoopbackNetworkAddress(address.address, address.family))
    ) {
      throw new Error(
        `BYO agent endpoint resolves to blocked address ${address.address}`
      );
    }
  }
}

function isLoopbackNetworkAddress(address: string, family: number) {
  if (family === 4) {
    return address.startsWith("127.");
  }
  const normalized = address.toLowerCase();
  return normalized === "::1" || normalized.startsWith("::ffff:127.");
}

function isBlockedNetworkAddress(address: string, family: number) {
  if (family === 4) {
    const parts = address.split(".").map((part) => Number(part));
    if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part))) {
      return true;
    }
    const [a, b] = parts;
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 198 && (b === 18 || b === 19))
    );
  }

  const normalized = address.toLowerCase();
  return (
    normalized === "::" ||
    normalized === "::1" ||
    normalized.startsWith("fc") ||
    normalized.startsWith("fd") ||
    normalized.startsWith("fe8") ||
    normalized.startsWith("fe9") ||
    normalized.startsWith("fea") ||
    normalized.startsWith("feb") ||
    normalized.startsWith("::ffff:10.") ||
    normalized.startsWith("::ffff:127.") ||
    normalized.startsWith("::ffff:192.168.") ||
    normalized.startsWith("::ffff:169.254.")
  );
}

async function verifiedByoAgentById(input: {
  agentId: string;
  actionType: ActionType;
  ownerUserId: string;
}) {
  const agents = await listAgents(input.ownerUserId);
  const agent = agents.find((entry) => entry.agent_id === input.agentId);
  if (!agent) {
    throw new Error(`BYO agent ${input.agentId} not found`);
  }
  if (agent.kind !== "byo") {
    throw new Error(`agent_id ${input.agentId} is not a BYO agent`);
  }
  if (agent.enabled === false) {
    throw new Error(`BYO agent ${input.agentId} is disabled`);
  }
  if (agent.identity_verified !== true) {
    throw new Error(`BYO agent ${input.agentId} is not identity verified`);
  }
  if (!agent.supported_semantic_types.includes(input.actionType)) {
    throw new Error(
      `BYO agent ${input.agentId} does not support ${input.actionType}`
    );
  }
  if (!isHttpEndpoint(agent.endpoint)) {
    throw new Error(`BYO agent ${input.agentId} endpoint is not HTTP(S)`);
  }
  return agent;
}

async function invokeVerifiedByoAgent(input: {
  sessionId: string;
  traceId: string;
  actionType: ActionType;
  ownerUserId: string;
  source?: CopyTradeSource;
  agentId?: string;
}): Promise<VerifiedByoAgentInvocation | undefined> {
  if (!input.agentId) {
    return undefined;
  }
  const agent = await verifiedByoAgentById({
    agentId: input.agentId,
    actionType: input.actionType,
    ownerUserId: input.ownerUserId,
  });

  const challenge: ByoAgentChallenge = {
    agentId: agent.agent_id,
    sessionId: input.sessionId,
    traceId: input.traceId,
    semanticType: input.actionType,
    sourceTraceId: input.source?.sourceTraceId,
    nonce: crypto.randomUUID(),
    createdAtMs: Date.now(),
  };
  const challengeMessage = byoAgentChallengeMessage(challenge);
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    Number(process.env.SUIMESH_BYO_AGENT_TIMEOUT_MS ?? 10000)
  );

  try {
    await assertSafeByoEndpoint(agent.endpoint);
    const response = await fetch(agent.endpoint, {
      method: "POST",
      redirect: "error",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        protocol: "suimesh",
        version: "0.1",
        kind: "agent_request",
        challenge,
        challenge_message: challengeMessage,
        envelope: {
          session_id: input.sessionId,
          trace_id: input.traceId,
          semantic_type: input.actionType,
          source_trace_id: input.source?.sourceTraceId,
          source_action_hash: input.source?.sourceActionHash,
        },
        context_refs: input.source
          ? {
              source_trace_id: input.source.sourceTraceId,
              source_action_hash: input.source.sourceActionHash,
              source_ptb_hash: input.source.sourcePtbHash,
              source_status: input.source.status,
            }
          : undefined,
      }),
      signal: controller.signal,
      cache: "no-store",
    });
    if (!response.ok) {
      throw new Error(
        `BYO agent ${agent.agent_id} failed: ${response.status} ${await response.text()}`
      );
    }

    const body = (await response.json()) as ByoAgentResponse;
    if (
      typeof body.signing_address === "string" &&
      body.signing_address.toLowerCase() !== agent.signing_address.toLowerCase()
    ) {
      throw new Error(
        `BYO agent ${agent.agent_id} responded with unexpected signing_address`
      );
    }
    const signature =
      typeof body.signature === "string" ? body.signature : undefined;
    if (!signature) {
      throw new Error(`BYO agent ${agent.agent_id} response is missing signature`);
    }
    await verifyByoAgentResponse({
      challenge,
      signingAddress: agent.signing_address,
      signature,
    });
    const actionPtbBytes = await parseAndValidateByoAction({
      action: body.action,
      actionType: input.actionType,
      traceId: input.traceId,
      source: input.source,
    });

    return {
      agent,
      challenge,
      signature,
      proposal: typeof body.proposal === "string" ? body.proposal : undefined,
      actionPtbBytes,
    };
  } finally {
    clearTimeout(timeout);
  }
}

async function parseAndValidateByoAction(input: {
  action: unknown;
  actionType: ActionType;
  traceId: string;
  source?: CopyTradeSource;
}) {
  const ptbBytes = decodeByoActionPtbBytes(input.action);
  if (!ptbBytes) {
    return undefined;
  }

  if (input.actionType === "transfer") {
    const expected = await buildSuiTransferPtbBytes({
      recipient: TRANSFER_RECIPIENT,
      amountMist: SUI_TRANSFER_AMOUNT_MIST,
    });
    if (!bytesEqual(ptbBytes, expected)) {
      throw new Error(
        "BYO transfer action must match the configured recipient and amount"
      );
    }
    return ptbBytes;
  }

  if (input.actionType === "contract_call") {
    const expected = await buildSuiDemoMoveCallPtbBytes({
      traceId: input.traceId,
      semanticType: "move_call",
      packageId: DEMO_PACKAGE_ID,
    });
    if (!bytesEqual(ptbBytes, expected)) {
      throw new Error(
        "BYO contract_call action must match the allowlisted demo Move call"
      );
    }
    return ptbBytes;
  }

  if (!input.source) {
    throw new Error("copy_trade BYO action requires a verified source trace");
  }
  const decoded = decodeSuiCopyTradePtbArgs(ptbBytes);
  const expectedTarget = `${COPY_PACKAGE_ID}::demo_action::mirror_leader_ptb`;
  if (decoded.target !== expectedTarget) {
    throw new Error(`BYO action target ${decoded.target} is not allowlisted`);
  }
  if (decoded.sourceTraceId !== input.source.sourceTraceId) {
    throw new Error("BYO action source trace does not match verified source");
  }
  if (decoded.followerTraceId !== input.traceId) {
    throw new Error("BYO action follower trace does not match requested trace");
  }
  if (BigInt(decoded.maxExposureMist) > BigInt(SUI_COPY_MAX_EXPOSURE_MIST)) {
    throw new Error("BYO action max exposure exceeds platform limit");
  }
  return ptbBytes;
}

function bytesEqual(left: Uint8Array, right: Uint8Array) {
  if (left.byteLength !== right.byteLength) {
    return false;
  }
  return left.every((byte, index) => byte === right[index]);
}

function decodeByoActionPtbBytes(action: unknown) {
  if (!action || typeof action !== "object" || Array.isArray(action)) {
    return undefined;
  }
  const record = action as Record<string, unknown>;
  const value = record.ptbBytes ?? record.ptb_bytes;
  if (typeof value !== "string" || value.length === 0) {
    return undefined;
  }
  return new Uint8Array(Buffer.from(value, "base64url"));
}

function optionalAgentId(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function byoActor(agent: AgentManifest): Actor {
  return {
    role: "agent",
    id: agent.agent_id,
    address: agent.signing_address,
  };
}

async function buildActionPlan(
  actionType: ActionType,
  traceId: string,
  input: {
    copySource?: CopyTradeSource;
    byoInvocation?: VerifiedByoAgentInvocation;
    hostedProposal?: HostedProposalAgentResult;
  } = {}
): Promise<ActionPlan> {
  const nowMs = Date.now();
  const expiresAtMs = nowMs + ACTION_TTL_MS;

  if (actionType === "transfer") {
    const proposal =
      input.byoInvocation?.proposal ??
      input.hostedProposal?.proposal ??
      actionDefinitions.transfer.proposal;
    const ptbBytes =
      input.byoInvocation?.actionPtbBytes ??
      (await buildSuiTransferPtbBytes({
        recipient: TRANSFER_RECIPIENT,
        amountMist: SUI_TRANSFER_AMOUNT_MIST,
      }));

    return {
      actionType,
      sdkSemanticType: "transfer",
      ptbBytes,
      manifest: {
        actionId: id("act_transfer"),
        traceId,
        semanticType: "transfer",
        template: "transfer",
        summary: proposal.slice(0, 1200),
        riskLevel: "medium",
        valueAtRisk: {
          amount: SUI_TRANSFER_AMOUNT_MIST,
          coinType: "SUI",
          decimals: 9,
        },
        objectsTouched: ["gas"],
        policyRequirements: [
          "max_value_at_risk",
          "recipient_allowlist",
          "expiration_check",
        ],
        expiresAtMs,
        idempotencyKey: `transfer:${traceId}`,
      },
      proposal,
      hostedProposal: input.hostedProposal,
    };
  }

  if (actionType === "contract_call") {
    const proposal =
      input.byoInvocation?.proposal ??
      input.hostedProposal?.proposal ??
      actionDefinitions.contract_call.proposal;
    const ptbBytes =
      input.byoInvocation?.actionPtbBytes ??
      (await buildSuiDemoMoveCallPtbBytes({
        traceId,
        semanticType: "move_call",
        packageId: DEMO_PACKAGE_ID,
      }));

    return {
      actionType,
      sdkSemanticType: "move_call",
      ptbBytes,
      manifest: {
        actionId: id("act_move_call"),
        traceId,
        semanticType: "move_call",
        template: "move_call",
        summary: proposal.slice(0, 1200),
        riskLevel: "low",
        primaryTarget: {
          packageId: DEMO_PACKAGE_ID,
          module: "demo_action",
          function: "mark_action",
        },
        objectsTouched: [],
        policyRequirements: [
          "package_allowlist",
          "function_allowlist",
          "expiration_check",
        ],
        expiresAtMs,
        idempotencyKey: `move_call:${traceId}`,
      },
      proposal,
      hostedProposal: input.hostedProposal,
    };
  }

  if (!input.copySource) {
    throw new Error("copy_trade requires a verified leader source trace");
  }
  const ptbBytes =
    input.byoInvocation?.actionPtbBytes ??
    (await buildSuiCopyTradePtbBytes({
      sourceTraceId: input.copySource.sourceTraceId,
      followerTraceId: traceId,
      maxExposureMist: SUI_COPY_MAX_EXPOSURE_MIST,
      packageId: COPY_PACKAGE_ID,
    }));
  const byoSuffix = input.byoInvocation
    ? ` BYO agent ${input.byoInvocation.agent.agent_id} signed request nonce ${input.byoInvocation.challenge.nonce}.`
    : "";
  const copyProposal =
    input.byoInvocation?.proposal ??
    input.hostedProposal?.proposal ??
    `${actionDefinitions.copy_trade.proposal} Source trace ${input.copySource.sourceTraceId} has action hash ${input.copySource.sourceActionHash}.${byoSuffix}`;

  return {
    actionType,
    sdkSemanticType: "copy_trade",
    ptbBytes,
    manifest: {
      actionId: id("act_copy_trade"),
      traceId,
      semanticType: "copy_trade",
      template: "move_call",
      summary: copyProposal.slice(0, 1200),
      riskLevel: "high",
      valueAtRisk: {
        amount: SUI_COPY_MAX_EXPOSURE_MIST,
        coinType: "SUI",
        decimals: 9,
      },
      primaryTarget: {
        packageId: COPY_PACKAGE_ID,
        module: "demo_action",
        function: "mirror_leader_ptb",
      },
      objectsTouched: [],
      policyRequirements: [
        "package_allowlist",
        "function_allowlist",
        "max_value_at_risk",
        "risk_level_guard",
        "expiration_check",
      ],
      expiresAtMs,
      idempotencyKey: `copy_trade:${traceId}`,
    },
    proposal: copyProposal,
    hostedProposal: input.hostedProposal,
  };
}

function buildPolicy(actionType: ActionType, confirmed = false): Policy {
  const transferRules: PolicyRule[] = [
    {
      name: "max_value_at_risk",
      params: { maxAmount: "5000000000", coinType: "SUI" },
    },
    { name: "recipient_allowlist", params: { recipients: [TRANSFER_RECIPIENT] } },
  ];

  if (actionType === "transfer") {
    return createDefaultPolicy({
      id: "meshaction-transfer-policy",
      version: "0.1",
      rules: transferRules,
    });
  }

  if (actionType === "contract_call") {
    return createDefaultPolicy({
      id: "meshaction-move-call-policy",
      version: "0.1",
      rules: [
        { name: "package_allowlist", params: { packages: [DEMO_PACKAGE_ID] } },
        {
          name: "function_allowlist",
          params: {
            selectors: [`${DEMO_PACKAGE_ID}::demo_action::mark_action`],
          },
        },
      ],
    });
  }

  const baseRules: PolicyRule[] = [
    { name: "expiration_check", params: {} },
    {
      name: "package_allowlist",
      params: { packages: [COPY_PACKAGE_ID] },
    },
    {
      name: "function_allowlist",
      params: {
        selectors: [`${COPY_PACKAGE_ID}::demo_action::mirror_leader_ptb`],
      },
    },
    {
      name: "max_value_at_risk",
      params: { maxAmount: SUI_COPY_MAX_EXPOSURE_MIST, coinType: "SUI" },
    },
    {
      name: "risk_level_guard",
      params: {
        minRisk: confirmed ? "critical" : "high",
        mode: "requires_confirmation",
      },
    },
    { name: "unknown_contract_guard", params: { mode: "requires_confirmation" } },
  ];

  return createDefaultPolicy({
    id: "meshaction-copy-trade-policy",
    version: confirmed ? "0.1-confirmed" : "0.1",
    rules: baseRules,
    replaceRules: true,
  });
}

function statusFromDecision(decision: PolicyDecision): string {
  if (decision.decision === "approved") {
    return "policy_approved";
  }
  return decision.decision === "rejected" ? "policy_rejected" : "requires_confirmation";
}

function claimReusableByExecutor(
  claim: ActionClaim | null | undefined,
  executorAddress: string
) {
  if (
    !claim ||
    claim.claimed !== true ||
    claim.duplicate === true ||
    typeof claim.claimant !== "string" ||
    claim.claimant.toLowerCase() !== executorAddress.toLowerCase()
  ) {
    return false;
  }
  return (
    typeof claim.claimExpiresAtMs !== "number" || claim.claimExpiresAtMs > Date.now()
  );
}

function nodeStatusFor(nodeId: string, run?: TraceRunRow): NodeStatus | undefined {
  if (!run) {
    return undefined;
  }

  if (run.status === "executed") {
    if (nodeId === "node_user" || nodeId === "node_agent" || nodeId === "node_policy") {
      return "approved";
    }
    if (nodeId === "node_memory") {
      return "ready";
    }
    if (nodeId === "node_executor" || nodeId === "node_sui") {
      return "executed";
    }
    if (nodeId === "node_walrus" || nodeId === "node_audit") {
      const archiveStatus =
        run.receipt && typeof run.receipt === "object"
          ? (run.receipt as unknown as Record<string, unknown>).archive_status
          : undefined;
      if (archiveStatus === "failed") {
        return "blocked";
      }
      if (archiveStatus === "pending") {
        return "running";
      }
      return "archived";
    }
    if (nodeId === "node_policy") {
      return "approved";
    }
  }

  if (run.status === "claimed" && nodeId === "node_executor") {
    return "running";
  }

  if (run.status === "anchored" || run.status === "policy_approved") {
    if (nodeId === "node_policy") {
      return "approved";
    }
    if (nodeId === "node_executor") {
      return "ready";
    }
  }

  if (
    (run.status === "requires_confirmation" || run.status === "policy_rejected") &&
    nodeId === "node_policy"
  ) {
    return "blocked";
  }

  if ((run.status === "simulated" || run.status === "proposed") && nodeId === "node_agent") {
    return "approved";
  }

  return undefined;
}

function archiveRefLabel(receipt: Record<string, unknown>) {
  const ref = receipt.archive_ref;
  if (typeof ref === "string") {
    return ref;
  }
  if (!ref || typeof ref !== "object" || Array.isArray(ref)) {
    return undefined;
  }
  const record = ref as Record<string, unknown>;
  return typeof record.blobId === "string"
    ? record.blobId
    : typeof record.digest === "string"
      ? record.digest
      : undefined;
}

function archiveProvider(receipt: Record<string, unknown>) {
  if (typeof receipt.archive_provider === "string") {
    return receipt.archive_provider;
  }
  const ref = receipt.archive_ref;
  if (!ref || typeof ref !== "object" || Array.isArray(ref)) {
    return undefined;
  }
  const provider = (ref as Record<string, unknown>).provider;
  return typeof provider === "string" ? provider : undefined;
}

function actionLabelForEvent(eventType: EventEnvelope["eventType"]) {
  switch (eventType) {
    case "conversation.user_message.v1":
      return "Intent";
    case "conversation.agent_message.v1":
      return "AgentMessage";
    case "context.memory_receipt.v1":
      return "MemoryReceipt";
    case "decision.intent.v1":
      return "Intent";
    case "decision.proposal.v1":
      return "Proposal";
    case "decision.sui_ptb_action.v1":
      return "Action";
    case "decision.policy_decision.v1":
      return "PolicyDecision";
    case "trace.action_anchor.v1":
      return "ActionAnchor";
    case "trace.action_claim.v1":
      return "ActionClaim";
    case "outcome.execution_receipt.v1":
      return "Receipt";
    case "outcome.audit_event.v1":
      return "Audit";
    default:
      return eventType;
  }
}

function traceEventStatus(eventType: EventEnvelope["eventType"]): NodeStatus {
  if (eventType === "decision.policy_decision.v1") {
    return "approved";
  }
  if (eventType === "outcome.execution_receipt.v1") {
    return "executed";
  }
  if (eventType === "outcome.audit_event.v1") {
    return "archived";
  }
  return "approved";
}

function eventTimestamp(createdAtMs?: number) {
  return new Date(createdAtMs ?? Date.now()).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

function decodedPayloadContent(envelope: EventEnvelope) {
  try {
    const decoded = suimeshClient().codec.decodeEvent(envelope);
    const payload = decoded.payload;
    if (payload && typeof payload === "object" && !Array.isArray(payload)) {
      const content = payload.content;
      return typeof content === "string" ? content : undefined;
    }
  } catch {
    return undefined;
  }

  return undefined;
}

function actorName(actor: string) {
  const id = actor.split(":")[1]?.split("@")[0] ?? actor;
  if (id === "console-user") {
    return "User";
  }
  if (id === "agent_hosted_orchestrator") {
    return "Hosted Orchestrator";
  }
  if (id === "agent_hosted_copy_runner") {
    return "Hosted Copy Runner";
  }
  if (id === "agent_meshaction_proposal") {
    return "MeshAction Proposal Agent";
  }
  if (id === "agent_meshaction_auditor") {
    return "MeshAction Audit Agent";
  }
  if (id === "agent_policy_sentinel") {
    return "Policy Sentinel";
  }
  return id;
}

function eventSummary(envelope: EventEnvelope) {
  if (envelope.eventType.includes("conversation")) {
    return decodedPayloadContent(envelope) ?? "Conversation message recorded.";
  }
  try {
    const decoded = suimeshClient().codec.decodeEvent(envelope);
    const payload = decoded.payload;
    if (payload && typeof payload === "object" && !Array.isArray(payload)) {
      const record = payload as Record<string, JsonValue>;
      if (envelope.eventType === EventTypes.Intent) {
        const content = record.content;
        return typeof content === "string"
          ? `Intent recorded: ${content}`
          : "Intent recorded.";
      }
      if (envelope.eventType === EventTypes.Proposal) {
        const kind = typeof record.kind === "string" ? record.kind : "proposal";
        const decision =
          typeof record.decision === "string" ? `${record.decision}: ` : "";
        const summary =
          typeof record.summary === "string"
            ? record.summary
            : typeof record.rationale === "string"
              ? record.rationale
              : typeof record.proposal === "string"
                ? record.proposal
                : undefined;
        return summary ? `${kind} ${decision}${summary}` : `${kind} recorded.`;
      }
      if (envelope.eventType === EventTypes.MemoryReceipt) {
        const provider = typeof record.provider === "string" ? record.provider : "memory";
        const operation =
          typeof record.operation === "string" ? record.operation : "record";
        return `${provider} ${operation} receipt recorded.`;
      }
      if (envelope.eventType === EventTypes.AuditEvent) {
        const state = typeof record.state === "string" ? record.state : "audit";
        return `Audit event recorded for ${state}.`;
      }
    }
  } catch {
    // Fall through to generic event summary.
  }
  return `${envelope.eventType} recorded with hash ${envelope.eventHash?.slice(0, 18) ?? "unknown"}.`;
}

async function messagesForSession(sessionId: string): Promise<ChatMessage[]> {
  const events = await suimeshClient().trace.restore(sessionId);
  return events
    .filter((event) => event.eventType.includes("conversation"))
    .map((event) => {
      const isUser = event.eventType === "conversation.user_message.v1";
      return {
        id: event.eventId,
        role: isUser ? "user" : "agent",
        author: actorName(event.actor),
        body: decodedPayloadContent(event) ?? "",
        timestamp: eventTimestamp(event.createdAtMs),
        trace_id: event.traceId,
      };
    });
}

async function traceEventsForRun(run: TraceRunRow): Promise<TraceEvent[]> {
  const events = await suimeshClient().trace.restore(run.session_id);
  return events
    .filter((event) => !event.traceId || event.traceId === run.trace_id)
    .map((event) => ({
      id: event.eventId,
      label: actionLabelForEvent(event.eventType),
      actor: actorName(event.actor),
      status: traceEventStatus(event.eventType),
      timestamp: eventTimestamp(event.createdAtMs),
      summary: eventSummary(event),
    }));
}

async function sessionIdForTrace(
  traceId: string,
  fallbackAction: ActionType,
  ownerUserId: string
) {
  const run = await getRun(traceId);
  assertRunOwner(run, ownerUserId);
  if (run) {
    return run.session_id;
  }
  return `session_${traceId.replace(/[^a-zA-Z0-9]/g, "").slice(0, 16) || fallbackAction}`;
}

export async function listAgents(ownerUserId: string) {
  await seedAgentRegistry();
  const result = await query<AgentRow>(
    `
      select agent_id, owner_user_id, manifest
      from suimesh_agents
      where owner_user_id = $1
        or agent_id = any($2::text[])
      order by created_at asc, agent_id asc
    `,
    [ownerUserId, agentManifests.map((manifest) => manifest.agent_id)]
  );

  return result.rows.map((row) => row.manifest);
}

export async function registerAgent(
  manifest: AgentManifest,
  proof: AgentRegistrationProof = {},
  ownerUserId: string
) {
  if (
    manifest.kind !== "byo" &&
    process.env.SUIMESH_ALLOW_HOSTED_AGENT_REGISTRATION !== "true"
  ) {
    throw new Error("public agent registration only supports BYO agents");
  }
  if (
    RESERVED_AGENT_IDS.has(manifest.agent_id) &&
    process.env.SUIMESH_ALLOW_RESERVED_AGENT_UPDATE !== "true"
  ) {
    throw new Error(`agent_id ${manifest.agent_id} is reserved`);
  }
  const existing = await query<AgentRow>(
    `
      select agent_id, owner_user_id, manifest
      from suimesh_agents
      where agent_id = $1
    `,
    [manifest.agent_id]
  );
  const existingOwner = existing.rows[0]?.owner_user_id;
  if (existingOwner && existingOwner !== ownerUserId) {
    throw new Error(`agent_id ${manifest.agent_id} belongs to another user`);
  }
  const verifiedManifest = await verifyAgentRegistration(manifest, proof);
  await query(
    `
      insert into suimesh_agents (agent_id, owner_user_id, manifest)
      values ($1, $2, $3::jsonb)
      on conflict (agent_id) do update
      set manifest = excluded.manifest,
          owner_user_id = excluded.owner_user_id,
          updated_at = now()
    `,
    [verifiedManifest.agent_id, ownerUserId, JSON.stringify(verifiedManifest)]
  );

  const agents = await listAgents(ownerUserId);
  return { agent: verifiedManifest, registry_size: agents.length };
}

export async function disableAgent(agentId: string, ownerUserId: string) {
  const existing = await query<AgentRow>(
    `
      select agent_id, owner_user_id, manifest
      from suimesh_agents
      where agent_id = $1
        and owner_user_id = $2
    `,
    [agentId, ownerUserId]
  );
  const row = existing.rows[0];
  if (!row) {
    throw new Error(`BYO agent ${agentId} not found`);
  }
  if (row.manifest.kind !== "byo") {
    throw new Error(`agent_id ${agentId} is not a BYO agent`);
  }

  const disabledManifest: AgentManifest = {
    ...row.manifest,
    enabled: false,
  };
  await query(
    `
      update suimesh_agents
      set manifest = $3::jsonb,
          updated_at = now()
      where agent_id = $1
        and owner_user_id = $2
    `,
    [agentId, ownerUserId, JSON.stringify(disabledManifest)]
  );

  const agents = await listAgents(ownerUserId);
  return { agent: disabledManifest, registry_size: agents.length };
}

export async function createSession(input: {
  semanticType?: unknown;
  content?: string;
  sessionId?: string;
  ownerUserId: string;
}) {
  const actionType = resolveActionType(input.semanticType);
  const sessionId = input.sessionId ?? id("session");
  const traceId = traceIdFor(sessionId, actionType);
  const content = input.content ?? actionDefinitions[actionType].objective;

  await ensureSession(sessionId, actionType, input.ownerUserId);
  const previousEventHash = await latestEventHash(sessionId);
  await suimeshClient().light.sendMessage({
    sessionId,
    traceId,
    actor: actors.user,
    content,
    previousEventHash,
  });

  return {
    session: {
      session_id: sessionId,
      trace_id: traceId,
      semantic_type: actionType,
      status: "ready",
      messages: await messagesForSession(sessionId),
    },
    graph: await getSessionGraph(sessionId, actionType, input.ownerUserId),
  };
}

export async function listSessions(ownerUserId: string, limit = 20) {
  const result = await query<SessionIndexRow>(
    `
      select
        sessions.session_id,
        sessions.owner_user_id,
        sessions.semantic_type,
        coalesce(latest_run.status, sessions.status) as status,
        greatest(
          sessions.updated_at,
          coalesce(latest_run.updated_at, sessions.updated_at)
        ) as updated_at,
        sessions.created_at
      from suimesh_sessions as sessions
      left join lateral (
        select status, updated_at
        from suimesh_trace_runs
        where session_id = sessions.session_id
          and semantic_type = sessions.semantic_type
        order by updated_at desc
        limit 1
      ) as latest_run on true
      where sessions.owner_user_id = $2
      order by updated_at desc
      limit $1
    `,
    [Math.max(1, Math.min(limit, 100)), ownerUserId]
  );

  return result.rows.map((row) => ({
    session_id: row.session_id,
    semantic_type: row.semantic_type,
    status: row.status,
    updated_at: row.updated_at.toISOString(),
    created_at: row.created_at.toISOString(),
  }));
}

export async function getSessionMessages(input: {
  sessionId: string;
  ownerUserId: string;
  semanticType?: unknown;
}) {
  const session = await getSession(input.sessionId);
  if (!session || session.owner_user_id !== input.ownerUserId) {
    throw new Error("Session not found");
  }
  const actionType = resolveActionType(
    input.semanticType,
    resolveActionType(session?.semantic_type)
  );
  const run = await latestRunForSession(input.sessionId, actionType);
  return {
    session_id: input.sessionId,
    trace_id: traceIdFor(input.sessionId, actionType),
    semantic_type: actionType,
    status: run?.status ?? session?.status ?? "unknown",
    trace_exists: Boolean(run),
    messages: await messagesForSession(input.sessionId),
  };
}

export async function postSessionMessage(input: {
  sessionId: string;
  ownerUserId: string;
  semanticType?: unknown;
  content: string;
  byoAgentId?: unknown;
}) {
  const session = await getSession(input.sessionId);
  if (session && session.owner_user_id !== input.ownerUserId) {
    throw new Error("Session belongs to another user");
  }
  const actionType = resolveActionType(
    input.semanticType,
    resolveActionType(session?.semantic_type)
  );
  const traceId = traceIdFor(input.sessionId, actionType);
  await ensureSession(input.sessionId, actionType, input.ownerUserId);

  const previousEventHash = await latestEventHash(input.sessionId);
  const userEvent = await suimeshClient().light.sendMessage({
    sessionId: input.sessionId,
    traceId,
    actor: actors.user,
    content: input.content,
    previousEventHash,
  });

  const agentActor = actionType === "copy_trade" ? actors.copyAgent : actors.agent;
  let prepared = false;
  let workflowError: string | undefined;
  let proposalResult: Awaited<ReturnType<typeof proposeTrace>> | undefined;
  let evaluationResult: Awaited<ReturnType<typeof evaluateTrace>> | undefined;

  try {
    proposalResult = await proposeTrace({
      traceId,
      sessionId: input.sessionId,
      ownerUserId: input.ownerUserId,
      semanticType: actionType,
      byoAgentId: input.byoAgentId,
    });
    evaluationResult = await evaluateTrace({
      traceId,
      sessionId: input.sessionId,
      ownerUserId: input.ownerUserId,
      semanticType: actionType,
      confirmed: false,
    });
    prepared = true;
  } catch (error) {
    workflowError =
      error instanceof Error ? error.message : "workflow preparation failed";
  }

  const policyStatus = evaluationResult?.policy_decision.status;
  const actionHash = proposalResult?.proposal.action_hash;
  const agentReply = prepared
    ? [
        `Prepared and inspected ${actionDefinitions[actionType].label.toLowerCase()} proposal.`,
        actionHash ? `Action hash ${actionHash}.` : undefined,
        policyStatus
          ? `Policy status ${policyStatus}: ${evaluationResult?.policy_decision.reason}`
          : undefined,
      ]
        .filter(Boolean)
        .join(" ")
    : `Unable to prepare ${actionDefinitions[actionType].label.toLowerCase()} proposal: ${workflowError}`;
  const agentEvent = await suimeshClient().light.sendMessage({
    sessionId: input.sessionId,
    traceId,
    actor: agentActor,
    content: agentReply,
    previousEventHash: (await latestEventHash(input.sessionId)) ?? userEvent.eventHash,
  });
  const trace = prepared ? (await getTrace(traceId, input.ownerUserId))?.trace : undefined;

  return {
    session_id: input.sessionId,
    trace_id: traceId,
    accepted: true,
    prepared,
    workflow_error: workflowError,
    proposal: proposalResult?.proposal,
    policy_decision: evaluationResult?.policy_decision,
    trace,
    message: {
      id: userEvent.eventId,
      role: "user",
      author: "User",
      content: input.content,
    },
    agent_reply: {
      id: agentEvent.eventId,
      role: "agent",
      author: actorName(agentEvent.actor),
      content: agentReply,
    },
    messages: await messagesForSession(input.sessionId),
  };
}

async function runAndRecordHostedAuditAgent(input: {
  sessionId: string;
  traceId: string;
  actionType: ActionType;
  proposal: string;
  action: SuiPtbAction;
  inspection: PtbInspectionResult;
  previousEventHash?: string;
}): Promise<HostedAuditAgentResult | undefined> {
  const hostedAudit = await runHostedAuditAgent({
    sessionId: input.sessionId,
    traceId: input.traceId,
    actionType: input.actionType,
    proposal: input.proposal,
    action: input.action,
    inspection: input.inspection,
  });
  if (!hostedAudit) {
    return undefined;
  }

  const requestEvent = await suimeshClient().light.sendMessage({
    sessionId: input.sessionId,
    traceId: input.traceId,
    actor: actors.meshactionProposalAgent,
    content: `Audit request for ${input.actionType} action ${input.inspection.facts.actionHash}.`,
    previousEventHash: input.previousEventHash,
  });
  const responseEvent = await suimeshClient().light.sendMessage({
    sessionId: input.sessionId,
    traceId: input.traceId,
    actor: actors.meshactionAuditAgent,
    content: `Audit ${hostedAudit.decision}: ${hostedAudit.rationale}`,
    previousEventHash: requestEvent.eventHash,
  });
  await recordProtocolJsonEvent({
    sessionId: input.sessionId,
    traceId: input.traceId,
    eventType: EventTypes.Proposal,
    actor: actors.meshactionAuditAgent,
    previousEventHash: responseEvent.eventHash,
    idempotencyKey: `meshaction-audit:${input.traceId}:${input.inspection.facts.actionHash}`,
    payload: {
      kind: "hosted_agent_audit_approval",
      trace_id: input.traceId,
      semantic_type: input.actionType,
      model: hostedAudit.model,
      decision: hostedAudit.decision,
      approved: hostedAudit.decision !== "rejected",
      rationale: hostedAudit.rationale,
      action_hash: input.inspection.facts.actionHash,
      evaluated_facts_hash: hashJson(input.inspection.facts as never),
      required_policy_checks: hostedAudit.requiredPolicyChecks,
      warnings: hostedAudit.warnings,
      from_agent: actors.meshactionProposalAgent.id,
    },
  });

  return hostedAudit;
}

export async function proposeTrace(input: {
  traceId: string;
  ownerUserId: string;
  sessionId?: string;
  semanticType?: unknown;
  byoAgentId?: unknown;
}) {
  const actionType = resolveActionType(input.semanticType);
  const sessionId =
    input.sessionId ??
    (await sessionIdForTrace(input.traceId, actionType, input.ownerUserId));
  const existing = await getRun(input.traceId);
  assertRunOwner(existing, input.ownerUserId);
  if (existing?.action && existing.inspection) {
    return {
      trace_id: input.traceId,
      session_id: existing.session_id,
      proposal: {
        semantic_type: existing.semantic_type,
        sdk_semantic_type: existing.action.manifest.semanticType,
        proposal: existing.action.manifest.summary,
        action: existing.action,
        inspection: existing.inspection,
        action_hash: existing.action_hash,
      },
    };
  }

  await ensureSession(sessionId, actionType, input.ownerUserId);
  const copySource =
    actionType === "copy_trade"
      ? await ensureCopyTradeLeaderSource(sessionId, input.ownerUserId)
      : undefined;
  let previousEventHash = await latestEventHash(sessionId);
  const userIntent =
    (await latestUserContent(sessionId)) ?? actionDefinitions[actionType].objective;
  const intentEvent = await recordProtocolJsonEvent({
    sessionId,
    traceId: input.traceId,
    eventType: EventTypes.Intent,
    actor: actors.user,
    previousEventHash,
    idempotencyKey: `intent:${input.traceId}`,
    payload: {
      trace_id: input.traceId,
      semantic_type: actionType,
      content: userIntent,
      source_trace_id: copySource?.sourceTraceId,
    },
  });
  previousEventHash = intentEvent.eventHash;

  const hostedProposal = await runHostedProposalAgent({
    sessionId,
    traceId: input.traceId,
    actionType,
    userIntent,
    copySource,
  });
  if (hostedProposal) {
    const proposalMessage = await suimeshClient().light.sendMessage({
      sessionId,
      traceId: input.traceId,
      actor: actors.meshactionProposalAgent,
      content: hostedProposal.proposal,
      previousEventHash,
    });
    previousEventHash = proposalMessage.eventHash;
    const proposalEvent = await recordProtocolJsonEvent({
      sessionId,
      traceId: input.traceId,
      eventType: EventTypes.Proposal,
      actor: actors.meshactionProposalAgent,
      previousEventHash,
      idempotencyKey: `meshaction-proposal:${input.traceId}`,
      payload: {
        kind: "hosted_agent_proposal",
        trace_id: input.traceId,
        semantic_type: actionType,
        model: hostedProposal.model,
        proposal: hostedProposal.proposal,
        summary: hostedProposal.summary,
        rationale: hostedProposal.rationale,
        risk_notes: hostedProposal.riskNotes,
        to_agent: actors.meshactionAuditAgent.id,
      },
    });
    previousEventHash = proposalEvent.eventHash;
  }

  const byoInvocation = await invokeVerifiedByoAgent({
    sessionId,
    traceId: input.traceId,
    actionType,
    ownerUserId: input.ownerUserId,
    source: copySource,
    agentId: optionalAgentId(input.byoAgentId),
  });
  const plan = await buildActionPlan(actionType, input.traceId, {
    copySource,
    byoInvocation,
    hostedProposal,
  });
  if (byoInvocation) {
    const byoEvent = await suimeshClient().light.sendMessage({
      sessionId,
      traceId: input.traceId,
      actor: {
        role: "agent",
        id: byoInvocation.agent.agent_id,
        address: byoInvocation.agent.signing_address,
      },
      content:
        byoInvocation.proposal ??
        `BYO agent ${byoInvocation.agent.agent_id} returned a signed proposal for ${actionType}.`,
      previousEventHash,
    });
    previousEventHash = byoEvent.eventHash;
  }
  const proposed = await suimeshClient().actions.proposePtb({
    sessionId,
    traceId: input.traceId,
    actor: byoInvocation
      ? byoActor(byoInvocation.agent)
      : actionType === "copy_trade"
        ? actors.copyAgent
        : actors.agent,
    ptbBytes: plan.ptbBytes,
    manifest: plan.manifest,
    previousEventHash,
  });
  const inspection = await suimeshClient().actions.simulate(proposed.action);
  const hostedAudit = await runAndRecordHostedAuditAgent({
    sessionId,
    traceId: input.traceId,
    actionType,
    proposal: plan.proposal,
    action: proposed.action,
    inspection,
    previousEventHash: proposed.envelope.eventHash,
  });
  if (hostedAudit?.decision === "rejected") {
    throw new Error(`MeshAction audit agent rejected proposal: ${hostedAudit.rationale}`);
  }
  const hostedRuntime = getHostedAgentRuntimeStatus();

  await upsertRun({
    traceId: input.traceId,
    sessionId,
    ownerUserId: input.ownerUserId,
    actionType,
    actionHash: inspection.facts.actionHash,
    action: proposed.action,
    inspection,
    status: "simulated",
  });

  return {
    trace_id: input.traceId,
    session_id: sessionId,
    proposal: {
      semantic_type: actionType,
      sdk_semantic_type: plan.sdkSemanticType,
      proposal: plan.proposal,
      source: copySource,
      hosted_agents: {
        mode: hostedRuntime.mode,
        reason: hostedRuntime.reason,
        proposal_agent: hostedProposal
          ? {
              agent_id: actors.meshactionProposalAgent.id,
              model: hostedProposal.model,
              summary: hostedProposal.summary,
            }
          : undefined,
        audit_agent: hostedAudit
          ? {
              agent_id: actors.meshactionAuditAgent.id,
              model: hostedAudit.model,
              decision: hostedAudit.decision,
              rationale: hostedAudit.rationale,
            }
          : undefined,
      },
      byo_agent: byoInvocation
        ? {
            agent_id: byoInvocation.agent.agent_id,
            signing_address: byoInvocation.agent.signing_address,
            challenge: byoInvocation.challenge,
            action_override_accepted:
              byoInvocation.actionPtbBytes !== undefined,
          }
        : undefined,
      action: proposed.action,
      inspection,
      action_hash: inspection.facts.actionHash,
      event_hash: proposed.envelope.eventHash,
    },
  };
}

export async function evaluateTrace(input: {
  traceId: string;
  ownerUserId: string;
  sessionId?: string;
  semanticType?: unknown;
  confirmed?: boolean;
}) {
  let run = await getRun(input.traceId);
  assertRunOwner(run, input.ownerUserId);
  if (!run?.action || !run.inspection) {
    const proposed = await proposeTrace(input);
    run = await getRun(proposed.trace_id);
    assertRunOwner(run, input.ownerUserId);
  }
  if (!run?.action || !run.inspection) {
    throw new Error("Trace proposal is required before policy evaluation");
  }

  await assertProtocolReadyForAnchor();
  const policy = buildPolicy(run.semantic_type, input.confirmed === true);
  const previousEventHash = await latestEventHash(run.session_id);
  const { decision, envelope } = await suimeshClient().policy.evaluateAndRecord({
    sessionId: run.session_id,
    traceId: input.traceId,
    policy,
    facts: run.inspection.facts,
    decider: actors.policy,
    previousEventHash,
  });

  let anchor: ActionAnchor | undefined;
  let status = statusFromDecision(decision);
  if (decision.decision === "approved") {
    const proposalHash = await latestTraceEventHash(
      input.traceId,
      "decision.sui_ptb_action.v1"
    );
    const anchored = await suimeshClient().trace.anchorAndRecord({
      sessionId: run.session_id,
      traceId: input.traceId,
      actor: actors.policy,
      actionHash: run.inspection.facts.actionHash,
      proposalHash,
      decisionHash: hashJson(decision as never),
      authorizedExecutor: executorAddress(),
      expiresAtMs: run.action.manifest.expiresAtMs,
      previousEventHash: envelope.eventHash,
    });
    anchor = anchored.anchor;
    status = "anchored";
  }

  await upsertRun({
    traceId: input.traceId,
    sessionId: run.session_id,
    ownerUserId: input.ownerUserId,
    actionType: run.semantic_type,
    actionHash: run.inspection.facts.actionHash,
    action: run.action,
    inspection: run.inspection,
    decision,
    anchor,
    status,
  });

  return {
    trace_id: input.traceId,
    session_id: run.session_id,
    policy_decision: {
      semantic_type: run.semantic_type,
      status: decision.decision,
      reason: decision.reason,
      decision,
      anchor,
      event_hash: envelope.eventHash,
    },
  };
}

export async function executeTrace(input: {
  traceId: string;
  ownerUserId: string;
  semanticType?: unknown;
  policyApproved?: boolean;
  confirmed?: boolean;
}) {
  let run = await getRun(input.traceId);
  assertRunOwner(run, input.ownerUserId);
  if (run?.status === "executed" && run.receipt) {
    throw new Error("Trace already executed");
  }

  if (!run?.decision || run.decision.decision !== "approved") {
    if (input.policyApproved || input.confirmed) {
      await evaluateTrace({
        traceId: input.traceId,
        ownerUserId: input.ownerUserId,
        semanticType: input.semanticType,
        confirmed: true,
      });
      run = await getRun(input.traceId);
      assertRunOwner(run, input.ownerUserId);
    } else {
      throw new Error("approved policy decision is required before execution");
    }
  }

  if (!run?.action || !run.inspection || !run.decision) {
    throw new Error("Trace must have action, inspection, and approved decision");
  }
  if (run.decision.decision !== "approved") {
    throw new Error("approved policy decision is required before execution");
  }

  const approvedAction = run.action;
  if (run.semantic_type === "copy_trade") {
    await ensureCopyTradeLeaderSourceExecuted(run.session_id, input.ownerUserId);
  }
  const currentExecutorAddress = executorAddress();
  const executor: Actor = {
    ...actors.executor,
    address: currentExecutorAddress,
  };
  let claim = run.claim;
  let previousEventHash = await latestEventHash(run.session_id);
  if (!claimReusableByExecutor(claim, currentExecutorAddress)) {
    const claimRecorded = await suimeshClient().trace.claimAndRecord({
      sessionId: run.session_id,
      traceId: input.traceId,
      actor: executor,
      actionHash: run.inspection.facts.actionHash,
      decision: run.decision,
      claimant: currentExecutorAddress,
      claimLeaseMs: CLAIM_LEASE_MS,
      previousEventHash,
    });
    if (!claimRecorded.claim.claimed || claimRecorded.claim.duplicate) {
      throw new Error("successful non-duplicate ActionClaim is required before execution");
    }
    claim = claimRecorded.claim;
    previousEventHash = claimRecorded.envelope.eventHash;
  }
  if (!claim) {
    throw new Error("successful non-duplicate ActionClaim is required before execution");
  }

  await upsertRun({
    traceId: input.traceId,
    sessionId: run.session_id,
    ownerUserId: input.ownerUserId,
    actionType: run.semantic_type,
    actionHash: run.inspection.facts.actionHash,
    action: run.action,
    inspection: run.inspection,
    decision: run.decision,
    anchor: run.anchor ?? undefined,
    claim,
    status: "claimed",
  });

  const executed = await suimeshClient().trace.executeApprovedAndRecord({
    sessionId: run.session_id,
    traceId: input.traceId,
    actionHash: run.inspection.facts.actionHash,
    claim,
    decision: run.decision,
    executor,
    previousEventHash,
    execute: async () =>
      executeSuiPtbBytes(ptbBytesFromBase64Url(approvedAction.ptbBytes)),
  });

  let receipt = {
    ...executed.receipt,
    archive_status: "pending",
  } as ExecutionReceipt;
  const completedAnchor = await suimeshClient().traceGuard.getAnchor(
    run.inspection.facts.actionHash
  );
  await upsertRun({
    traceId: input.traceId,
    sessionId: run.session_id,
    ownerUserId: input.ownerUserId,
    actionType: run.semantic_type,
    actionHash: run.inspection.facts.actionHash,
    action: run.action,
    inspection: run.inspection,
    decision: run.decision,
    anchor: completedAnchor,
    claim,
    receipt,
    status: "executed",
  });

  try {
    const archive = await encryptArchive({
      traceId: input.traceId,
      plaintext: new TextEncoder().encode(
        JSON.stringify({
          traceId: input.traceId,
          action: run.action,
          inspection: run.inspection,
          decision: run.decision,
          anchor: completedAnchor,
          claim,
          receipt: executed.receipt,
        })
      ),
    });
    const archiveRef = await suimeshClient().storage.put({
      bytes: archive.bytes,
      contentType: archive.contentType,
      encrypted: true,
    });
    const refs = archiveRefs(archiveRef, archive);

    const auditEnvelope = encodeEvent({
      encoding: "json-v1",
      header: {
        eventId: id("evt_audit"),
        sessionId: run.session_id,
        traceId: input.traceId,
        eventType: "outcome.audit_event.v1",
        actor: actors.audit,
        previousEventHash: executed.envelope.eventHash,
        createdAtMs: Date.now(),
      },
      payload: {
        traceId: input.traceId,
        state: "executed",
        eventHash: executed.envelope.eventHash ?? "",
        archiveRef: refs.archive_ref,
        archiveDigest: refs.archive_digest,
        archiveProvider: refs.archive_provider,
        sealAccessRef: refs.seal_access_ref,
        sealMetadata: refs.seal_metadata,
      },
    });
    await suimeshClient().transport.send(auditEnvelope);
    receipt = {
      ...executed.receipt,
      ...refs,
      archive_status: "archived",
      audit_event_hash: auditEnvelope.eventHash,
    } as ExecutionReceipt;
    await upsertRun({
      traceId: input.traceId,
      sessionId: run.session_id,
      ownerUserId: input.ownerUserId,
      actionType: run.semantic_type,
      actionHash: run.inspection.facts.actionHash,
      action: run.action,
      inspection: run.inspection,
      decision: run.decision,
      anchor: completedAnchor,
      claim,
      receipt,
      status: "executed",
    });
  } catch (error) {
    const archiveError =
      error instanceof Error ? error.message : "archive failed";
    const auditEnvelope = encodeEvent({
      encoding: "json-v1",
      header: {
        eventId: id("evt_audit"),
        sessionId: run.session_id,
        traceId: input.traceId,
        eventType: "outcome.audit_event.v1",
        actor: actors.audit,
        previousEventHash: executed.envelope.eventHash,
        createdAtMs: Date.now(),
      },
      payload: {
        traceId: input.traceId,
        state: "executed_archive_failed",
        eventHash: executed.envelope.eventHash ?? "",
        archiveError,
      },
    });
    await suimeshClient().transport.send(auditEnvelope);
    receipt = {
      ...executed.receipt,
      archive_status: "failed",
      archive_error: archiveError,
      audit_event_hash: auditEnvelope.eventHash,
    } as ExecutionReceipt;
    await upsertRun({
      traceId: input.traceId,
      sessionId: run.session_id,
      ownerUserId: input.ownerUserId,
      actionType: run.semantic_type,
      actionHash: run.inspection.facts.actionHash,
      action: run.action,
      inspection: run.inspection,
      decision: run.decision,
      anchor: completedAnchor,
      claim,
      receipt,
      status: "executed",
    });
  }

  return {
    trace_id: input.traceId,
    session_id: run.session_id,
    claim,
    receipt,
  };
}

async function verifyTraceScope(run: TraceRunRow): Promise<TraceVerification> {
  const events = (await suimeshClient().trace.restore(run.session_id)).filter(
    (event) => event.traceId === run.trace_id
  );
  const errors: string[] = [];
  const state = {
    actionSeen: false,
    approvedActions: new Set<string>(),
    anchoredActions: new Set<string>(),
    claimedActions: new Set<string>(),
    executedActions: new Set<string>(),
  };

  for (const event of events) {
    let payload: Record<string, JsonValue> | undefined;
    try {
      const actualHash = suimeshClient().codec.hashEvent(event);
      if (actualHash !== event.eventHash) {
        errors.push(
          `trace ${run.trace_id} event ${event.eventId} hash mismatch: expected ${event.eventHash}, got ${actualHash}`
        );
      }
      const decoded = suimeshClient().codec.decodeEvent(event);
      payload =
        decoded.payload &&
        typeof decoded.payload === "object" &&
        !Array.isArray(decoded.payload)
          ? (decoded.payload as Record<string, JsonValue>)
          : undefined;
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
      continue;
    }

    if (event.eventType === EventTypes.SuiPtbAction) {
      state.actionSeen = true;
      continue;
    }

    if (event.eventType === EventTypes.PolicyDecision) {
      const actionHash = payloadString(payload, "actionHash", "action_hash");
      const decision = payloadString(payload, "decision");
      if (!state.actionSeen) {
        errors.push(`trace ${run.trace_id} policy decision appears before action proposal`);
      }
      if (actionHash && decision === "approved") {
        state.approvedActions.add(actionHash);
      }
      continue;
    }

    if (event.eventType === EventTypes.ActionAnchor) {
      const actionHash = payloadString(payload, "actionHash", "action_hash");
      if (!actionHash) {
        errors.push(`trace ${run.trace_id} action anchor is missing actionHash`);
      } else {
        if (!state.approvedActions.has(actionHash)) {
          errors.push(
            `trace ${run.trace_id} action ${actionHash} anchored without approved PolicyDecision`
          );
        }
        state.anchoredActions.add(actionHash);
      }
      continue;
    }

    if (event.eventType === EventTypes.ActionClaim) {
      const actionHash = payloadString(payload, "actionHash", "action_hash");
      const claimed = payloadBoolean(payload, "claimed");
      const duplicate = payloadBoolean(payload, "duplicate");
      if (!actionHash) {
        errors.push(`trace ${run.trace_id} action claim is missing actionHash`);
      } else {
        if (!state.anchoredActions.has(actionHash)) {
          errors.push(
            `trace ${run.trace_id} action ${actionHash} claimed without ActionAnchor`
          );
        }
        if (claimed === true && duplicate !== true) {
          state.claimedActions.add(actionHash);
        }
      }
      continue;
    }

    if (event.eventType === EventTypes.ExecutionReceipt) {
      const actionHash = payloadString(payload, "actionHash", "action_hash");
      if (!actionHash) {
        errors.push(`trace ${run.trace_id} execution receipt is missing actionHash`);
      } else {
        if (!state.claimedActions.has(actionHash)) {
          errors.push(
            `trace ${run.trace_id} action ${actionHash} executed without successful ActionClaim`
          );
        }
        state.executedActions.add(actionHash);
      }
      continue;
    }

    if (event.eventType === EventTypes.AuditEvent && state.executedActions.size === 0) {
      errors.push(`trace ${run.trace_id} audit event appears before execution evidence`);
    }
  }

  if (run.action && !state.actionSeen) {
    errors.push(`trace ${run.trace_id} has cached action but no SuiPtbAction event`);
  }

  return {
    ok: errors.length === 0,
    errors,
    scope: "trace",
  };
}

function payloadString(
  payload: Record<string, JsonValue> | undefined,
  ...keys: string[]
) {
  for (const key of keys) {
    const value = payload?.[key];
    if (typeof value === "string") {
      return value;
    }
  }
  return undefined;
}

function payloadBoolean(payload: Record<string, JsonValue> | undefined, key: string) {
  const value = payload?.[key];
  return typeof value === "boolean" ? value : undefined;
}

export async function getTrace(traceId: string, ownerUserId: string) {
  const run = await getRun(traceId);
  assertRunOwner(run, ownerUserId);
  if (!run) {
    return undefined;
  }

  const verification = await verifyTraceScope(run);
  return {
    trace: {
      trace_id: run.trace_id,
      session_id: run.session_id,
      semantic_type: run.semantic_type,
      status: run.status,
      action_hash: run.action_hash,
      action: run.action,
      inspection: run.inspection,
      policy_decision: run.decision,
      anchor: run.anchor,
      claim: run.claim,
      receipt: run.receipt,
      events: await traceEventsForRun(run),
      verification,
    },
  };
}

export async function getTraceArchive(traceId: string, ownerUserId: string) {
  const run = await getRun(traceId);
  assertRunOwner(run, ownerUserId);
  if (!run) {
    return undefined;
  }

  return {
    archive: {
      trace_id: run.trace_id,
      session_id: run.session_id,
      semantic_type: run.semantic_type,
      receipt: run.receipt,
      restored: await restoreArchiveRefs(run.receipt as never),
    },
  };
}

export async function getSessionGraph(
  sessionId: string,
  semanticType: unknown,
  ownerUserId: string
): Promise<WorkflowGraph> {
  const session = await getSession(sessionId);
  if (!session || session.owner_user_id !== ownerUserId) {
    throw new Error("Session not found");
  }
  const actionType = resolveActionType(
    semanticType,
    resolveActionType(session?.semantic_type)
  );
  const run =
    (await latestRunForSession(sessionId, actionType)) ??
    (await getRun(traceIdFor(sessionId, actionType)));
  assertRunOwner(run, ownerUserId);
  const graph = getWorkflowGraphTemplate(actionType);
  const traceId = run?.trace_id ?? traceIdFor(sessionId, actionType);
  const userContent = await latestUserContent(sessionId);

  return {
    edges: graph.edges,
    nodes: graph.nodes.map((node) => {
      const status = nodeStatusFor(node.node_id, run);
      const metadata = { ...node.metadata };
      if (node.node_id === "node_user") {
        metadata.details = userContent ?? metadata.details;
        metadata.refs = [`session://${sessionId}`, `trace://${traceId}`];
      }
      if (node.node_id === "node_memory") {
        metadata.refs = [
          "seal://session-memory/default",
          `cache://session/${sessionId}`,
        ];
      }
      if (!run) {
        if (node.node_id === "node_agent") {
          metadata.headline = "Ready to propose";
          metadata.details =
            "Runtime session is connected. Generate a proposal before policy evaluation.";
        }
        if (node.node_id === "node_policy") {
          metadata.headline = "Awaiting policy evaluation";
          metadata.details = "No inspected PTB facts have been evaluated yet.";
        }
        if (node.node_id === "node_executor") {
          metadata.headline = "Awaiting approved decision";
          metadata.details =
            "Execution is blocked until proposal, inspection, policy, and claim complete.";
        }
        if (node.node_id === "node_sui") {
          metadata.headline = "Awaiting execution";
          metadata.details = "No Sui transaction has been submitted for this trace.";
          metadata.refs = ["effects://pending", "network://sui-testnet"];
        }
        if (node.node_id === "node_walrus") {
          metadata.headline = "Awaiting receipt";
          metadata.details = "Archive refs are created only after execution receipt.";
          metadata.refs = ["walrus://pending", "seal://pending"];
        }
        if (node.node_id === "node_audit") {
          metadata.headline = "Awaiting audit";
          metadata.details = "Audit chain is pending until trace events exist.";
          metadata.audit = ["trace://pending", "archive_status:pending"];
        }
      }
      if (node.node_id === "node_agent" && run?.action) {
        metadata.details = run.action.manifest.summary;
        metadata.refs = [
          run.action.manifest.actionId,
          run.action.manifest.idempotencyKey,
        ];
      }
      if (node.node_id === "node_policy" && run?.decision) {
        metadata.headline = run.decision.decision;
        metadata.details = run.decision.reason;
      }
      if (node.node_id === "node_sui" && run?.receipt) {
        metadata.details = `receipt ${run.receipt.txDigest ?? "no tx digest"}`;
        metadata.refs = [
          `effects://${run.receipt.effectsHash ?? "unknown"}`,
          "network://sui-testnet",
        ];
      }
      if (node.node_id === "node_walrus" && run?.receipt) {
        const receipt = run.receipt as unknown as Record<string, unknown>;
        const archiveStatus = receipt.archive_status;
        const archiveRef = archiveRefLabel(receipt);
        const provider = archiveProvider(receipt);
        metadata.headline =
          archiveStatus === "failed"
            ? "Archive failed"
            : archiveStatus === "archived"
              ? "Archive verified"
              : "Archive pending";
        metadata.details =
          typeof receipt.archive_error === "string"
            ? receipt.archive_error
            : archiveRef
              ? `archive ${archiveRef}`
              : "archive pending";
        metadata.refs = [
          provider ? `provider://${provider}` : "provider://unknown",
          typeof receipt.archive_digest === "string"
            ? `digest://${receipt.archive_digest}`
            : "digest://pending",
        ];
      }
      if (node.node_id === "node_audit" && run?.receipt) {
        const receipt = run.receipt as unknown as Record<string, unknown>;
        const archiveStatus = receipt.archive_status;
        metadata.headline =
          typeof receipt.audit_event_hash === "string"
            ? "Audit linked"
            : archiveStatus === "failed"
              ? "Archive failure recorded"
              : "Audit pending";
        metadata.details =
          typeof receipt.audit_event_hash === "string"
            ? `audit ${receipt.audit_event_hash}`
            : "audit pending";
        metadata.audit = [
          typeof receipt.seal_access_ref === "string"
            ? receipt.seal_access_ref
            : "seal://pending",
          typeof receipt.archive_status === "string"
            ? `archive_status:${receipt.archive_status}`
            : "archive_status:pending",
        ];
      }

      return {
        ...node,
        session_id: sessionId,
        trace_id: traceId,
        status: status ?? pendingNodeStatus(node.node_id, Boolean(run), node.status),
        metadata,
      };
    }),
  };
}

function pendingNodeStatus(
  nodeId: string,
  hasRun: boolean,
  fallback: NodeStatus
): NodeStatus {
  if (hasRun) {
    return fallback;
  }
  if (nodeId === "node_user" || nodeId === "node_agent" || nodeId === "node_memory") {
    return "ready";
  }
  return "idle";
}
