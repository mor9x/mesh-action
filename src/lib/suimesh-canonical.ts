import { createSuiStackMessagingClient } from "@mysten/sui-stack-messaging";
import {
  SuiMoveTraceGuardDriver,
  SuiOnchainTraceGuard,
  SuiStackEventTransport,
  type EventEnvelope,
  type EventTransport,
  type SuiMoveTraceGuardClient,
  type SuiMoveTraceGuardEventPage,
  type SuiMoveTraceGuardEventQueryInput,
  type SuiMoveTraceGuardTransactionResult,
  type TraceGuard,
} from "suimesh";

import {
  PgEventTransport,
  PgTraceGuard,
} from "@/lib/pg-suimesh-adapters";
import {
  getSuiRuntimeClient,
  getSuiRuntimeSigner,
} from "@/lib/sui-executor";

const DEFAULT_RELAYER_URL = "https://relay.suimesh.link";
const DEFAULT_TRACE_PACKAGE_ID =
  "0x038caadb65def30619e6ec762715ea6ca232ac1195bc077086bc9a6b7e11bb80";
const TESTNET_OPEN_SEAL_SERVER_CONFIGS = [
  {
    objectId:
      "0x73d05d62c18d9374e3ea529e8e0ed6161da1a141a94d3f76ae3fe4e99356db75",
    weight: 1,
  },
  {
    objectId:
      "0xf5d14a81a982144ae441cd7d64b09027f116a468bd36e7eca494f750591623c8",
    weight: 1,
  },
];

type ProtocolMode = "canonical" | "pg";
type CanonicalConfig = {
  relayerUrl: string;
  tracePackageId?: string;
  traceRegistryId?: string;
};
type SessionProtocolMetadata = {
  protocol_transport: "sui-stack";
  trace_guard: "sui-onchain";
  relayer_url: string;
  trace_package_id: string;
  trace_registry_id: string;
  sui_stack_group_uuid: string;
  sui_stack_group_create_digest?: string;
};
type TraceRegistryInspection = {
  objectId: string;
  expectedType: string;
  actualType?: string;
  ownerAddress?: string;
  ownerMatchesSigner: boolean;
  writable: boolean;
  errors: string[];
};

let stackClient:
  | ReturnType<typeof createSuiStackMessagingClient<void>>
  | undefined;
let protocolTransport: EventTransport | undefined;
let protocolTraceGuard: TraceGuard | undefined;

function positiveNumberEnv(name: string, fallback: number) {
  const raw = process.env[name]?.trim();
  if (!raw) {
    return fallback;
  }
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function protocolMode(): ProtocolMode {
  const raw = process.env.SUIMESH_PROTOCOL_MODE?.trim().toLowerCase();
  if (raw === "canonical" || raw === "production" || raw === "sui") {
    return "canonical";
  }
  if (raw === "pg" || raw === "postgres" || raw === "local") {
    return "pg";
  }
  if (
    process.env.SUIMESH_RELAYER_URL ||
    process.env.SUIMESH_TRACE_PACKAGE_ID ||
    process.env.SUIMESH_TRACE_REGISTRY_ID
  ) {
    return "canonical";
  }
  return "pg";
}

function canonicalConfig(): CanonicalConfig {
  return {
    relayerUrl: process.env.SUIMESH_RELAYER_URL ?? DEFAULT_RELAYER_URL,
    tracePackageId:
      process.env.SUIMESH_TRACE_PACKAGE_ID ?? DEFAULT_TRACE_PACKAGE_ID,
    traceRegistryId: process.env.SUIMESH_TRACE_REGISTRY_ID?.trim() || undefined,
  };
}

function requiredCanonicalConfig() {
  const config = canonicalConfig();
  if (!config.tracePackageId) {
    throw new Error("Missing SUIMESH_TRACE_PACKAGE_ID for canonical protocol mode");
  }
  if (!config.traceRegistryId) {
    throw new Error(
      "Missing SUIMESH_TRACE_REGISTRY_ID for canonical protocol mode. Create a MeshAction-owned trace registry and set this env var."
    );
  }
  return {
    relayerUrl: config.relayerUrl,
    tracePackageId: config.tracePackageId,
    traceRegistryId: config.traceRegistryId,
  };
}

function sealServerConfigs() {
  const raw = process.env.SUIMESH_SEAL_SERVER_CONFIGS?.trim();
  if (!raw) {
    return TESTNET_OPEN_SEAL_SERVER_CONFIGS;
  }
  const parsed = JSON.parse(raw) as unknown;
  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new Error("SUIMESH_SEAL_SERVER_CONFIGS must be a non-empty JSON array");
  }
  return parsed.map((entry, index) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new Error(`SUIMESH_SEAL_SERVER_CONFIGS[${index}] must be an object`);
    }
    const record = entry as Record<string, unknown>;
    if (typeof record.objectId !== "string" || !record.objectId) {
      throw new Error(
        `SUIMESH_SEAL_SERVER_CONFIGS[${index}].objectId must be a non-empty string`
      );
    }
    if (
      typeof record.weight !== "number" ||
      !Number.isInteger(record.weight) ||
      record.weight <= 0
    ) {
      throw new Error(
        `SUIMESH_SEAL_SERVER_CONFIGS[${index}].weight must be a positive integer`
      );
    }
    return {
      objectId: record.objectId,
      weight: record.weight,
    };
  });
}

function sealThreshold(configs: { weight: number }[]) {
  const fallback = Math.min(2, configs.length);
  const threshold = Number(process.env.SUIMESH_SEAL_THRESHOLD ?? fallback);
  if (!Number.isInteger(threshold) || threshold <= 0) {
    throw new Error(`Invalid SUIMESH_SEAL_THRESHOLD ${threshold}`);
  }
  const totalWeight = configs.reduce((sum, config) => sum + config.weight, 0);
  if (threshold > totalWeight) {
    throw new Error(
      `SUIMESH_SEAL_THRESHOLD ${threshold} exceeds total Seal server weight ${totalWeight}`
    );
  }
  return threshold;
}

class WaitingTraceGuardClient implements SuiMoveTraceGuardClient {
  async signAndExecuteTransaction(
    input: Parameters<SuiMoveTraceGuardClient["signAndExecuteTransaction"]>[0]
  ): Promise<SuiMoveTraceGuardTransactionResult> {
    const client = getSuiRuntimeClient();
    const result = await client.signAndExecuteTransaction(input as never);
    if (result.digest) {
      await client.waitForTransaction({
        digest: result.digest,
        timeout: positiveNumberEnv("SUIMESH_SUI_WAIT_TIMEOUT_MS", 60_000),
        pollInterval: positiveNumberEnv(
          "SUIMESH_SUI_WAIT_POLL_INTERVAL_MS",
          1_000
        ),
        options: {
          showEffects: true,
          showEvents: true,
          showObjectChanges: true,
        },
      });
    }
    return result as SuiMoveTraceGuardTransactionResult;
  }

  async queryEvents(
    input: SuiMoveTraceGuardEventQueryInput
  ): Promise<SuiMoveTraceGuardEventPage> {
    return (await getSuiRuntimeClient().queryEvents(input as never)) as never;
  }
}

class MirroredEventTransport implements EventTransport {
  constructor(
    private readonly canonical: EventTransport,
    private readonly cache: EventTransport
  ) {}

  async send(envelope: EventEnvelope): Promise<void> {
    await this.canonical.send(envelope);
    await this.cache.send(envelope);
  }

  async list(sessionId: string): Promise<EventEnvelope[]> {
    const [canonicalEvents, cachedEvents] = await Promise.all([
      this.canonical.list(sessionId),
      this.cache.list(sessionId).catch(() => []),
    ]);
    await Promise.allSettled(
      canonicalEvents.map((event) => this.cache.send(event))
    );
    return mergeEvents(canonicalEvents, cachedEvents);
  }

  subscribe(
    sessionId: string,
    handler: (envelope: EventEnvelope) => void | Promise<void>
  ): Promise<() => void> {
    return this.canonical.subscribe(sessionId, handler);
  }
}

function mergeEvents(
  primary: EventEnvelope[],
  cached: EventEnvelope[]
): EventEnvelope[] {
  const byHash = new Map<string, EventEnvelope>();
  for (const event of [...cached, ...primary]) {
    byHash.set(event.eventHash ?? event.eventId, event);
  }
  return Array.from(byHash.values()).sort((left, right) => {
    const byTime = (left.createdAtMs ?? 0) - (right.createdAtMs ?? 0);
    if (byTime !== 0) {
      return byTime;
    }
    return left.eventId.localeCompare(right.eventId);
  });
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  return value as Record<string, unknown>;
}

function parsedMoveFields(content: unknown) {
  const record = asRecord(content);
  if (record?.dataType !== "moveObject") {
    return undefined;
  }
  return asRecord(record.fields);
}

async function inspectTraceRegistry(): Promise<TraceRegistryInspection> {
  const { tracePackageId, traceRegistryId } = requiredCanonicalConfig();
  const expectedType = `${tracePackageId}::trace::Registry`;
  const errors: string[] = [];
  let actualType: string | undefined;
  let ownerAddress: string | undefined;

  try {
    const response = await getSuiRuntimeClient().getObject({
      id: traceRegistryId,
      options: {
        showContent: true,
        showOwner: true,
        showType: true,
      },
    });
    if (response.error) {
      errors.push(`Trace registry read failed: ${response.error.code}`);
    }
    actualType = response.data?.type ?? undefined;
    if (actualType !== expectedType) {
      errors.push(
        `Trace registry type mismatch: expected ${expectedType}, got ${
          actualType ?? "unknown"
        }`
      );
    }
    const fields = parsedMoveFields(response.data?.content);
    if (typeof fields?.owner === "string") {
      ownerAddress = fields.owner;
    } else {
      errors.push("Trace registry owner field is missing");
    }
  } catch (error) {
    errors.push(
      error instanceof Error
        ? `Trace registry read failed: ${error.message}`
        : "Trace registry read failed"
    );
  }

  let runtimeSignerAddress: string | undefined;
  try {
    runtimeSignerAddress = getSuiRuntimeSigner().address;
  } catch (error) {
    errors.push(
      error instanceof Error
        ? `Runtime signer unavailable: ${error.message}`
        : "Runtime signer unavailable"
    );
  }

  const ownerMatchesSigner =
    Boolean(ownerAddress && runtimeSignerAddress) &&
    ownerAddress?.toLowerCase() === runtimeSignerAddress?.toLowerCase();
  if (ownerAddress && runtimeSignerAddress && !ownerMatchesSigner) {
    errors.push(
      `Trace registry owner ${ownerAddress} does not match runtime signer ${runtimeSignerAddress}`
    );
  }

  return {
    objectId: traceRegistryId,
    expectedType,
    actualType,
    ownerAddress,
    ownerMatchesSigner,
    writable: errors.length === 0,
    errors,
  };
}

function suiStackClient() {
  if (stackClient) {
    return stackClient;
  }
  const runtime = getSuiRuntimeSigner();
  const configs = sealServerConfigs();
  stackClient = createSuiStackMessagingClient<void>(
    getSuiRuntimeClient() as never,
    {
      seal: {
        serverConfigs: configs,
        timeout: positiveNumberEnv("SUIMESH_SEAL_TIMEOUT_MS", 30_000),
        verifyKeyServers:
          process.env.SUIMESH_SEAL_VERIFY_KEY_SERVERS !== "false",
      },
      encryption: {
        sessionKey: {
          ttlMin: positiveNumberEnv("SUIMESH_SESSION_KEY_TTL_MIN", 10),
          signer: runtime.keypair as never,
        },
        sealThreshold: sealThreshold(configs),
      },
      relayer: { relayerUrl: canonicalConfig().relayerUrl },
    },
  );
  return stackClient;
}

export function createProtocolEventTransport(): EventTransport {
  if (protocolTransport) {
    return protocolTransport;
  }
  if (protocolMode() !== "canonical") {
    protocolTransport = new PgEventTransport();
    return protocolTransport;
  }

  const canonical = new SuiStackEventTransport({
    client: suiStackClient().messaging as never,
    signer: getSuiRuntimeSigner().keypair as never,
    groupRefForSession: (sessionId) => ({ uuid: sessionId }),
  });
  protocolTransport = new MirroredEventTransport(canonical, new PgEventTransport());
  return protocolTransport;
}

export function createProtocolTraceGuard(): TraceGuard {
  if (protocolTraceGuard) {
    return protocolTraceGuard;
  }
  if (protocolMode() !== "canonical") {
    protocolTraceGuard = new PgTraceGuard();
    return protocolTraceGuard;
  }

  const { tracePackageId, traceRegistryId } = requiredCanonicalConfig();
  protocolTraceGuard = new SuiOnchainTraceGuard(
    new SuiMoveTraceGuardDriver({
      client: new WaitingTraceGuardClient(),
      signer: getSuiRuntimeSigner().keypair as never,
      packageId: tracePackageId,
      registryId: traceRegistryId,
      defaultAuthorizedExecutor: getSuiRuntimeSigner().address,
      defaultClaimLeaseMs: positiveNumberEnv(
        "SUIMESH_TRACE_CLAIM_LEASE_MS",
        2 * 60_000
      ),
      defaultActionTtlMs: positiveNumberEnv(
        "SUIMESH_TRACE_ACTION_TTL_MS",
        10 * 60_000
      ),
    })
  );
  return protocolTraceGuard;
}

export async function ensureProtocolSessionGroup(input: {
  sessionId: string;
  name?: string;
  existingMetadata?: Record<string, unknown>;
}): Promise<SessionProtocolMetadata | undefined> {
  if (protocolMode() !== "canonical") {
    return undefined;
  }
  const config = requiredCanonicalConfig();
  if (typeof input.existingMetadata?.sui_stack_group_uuid === "string") {
    return input.existingMetadata as SessionProtocolMetadata;
  }

  const result = await suiStackClient().messaging.createAndShareGroup({
    signer: getSuiRuntimeSigner().keypair as never,
    uuid: input.sessionId,
    name: input.name ?? `MeshAction ${input.sessionId}`,
  });
  if (result.digest) {
    await getSuiRuntimeClient().waitForTransaction({
      digest: result.digest,
      timeout: positiveNumberEnv("SUIMESH_SUI_WAIT_TIMEOUT_MS", 60_000),
      pollInterval: positiveNumberEnv(
        "SUIMESH_SUI_WAIT_POLL_INTERVAL_MS",
        1_000
      ),
    });
  }

  return {
    protocol_transport: "sui-stack",
    trace_guard: "sui-onchain",
    relayer_url: config.relayerUrl,
    trace_package_id: config.tracePackageId,
    trace_registry_id: config.traceRegistryId,
    sui_stack_group_uuid: input.sessionId,
    sui_stack_group_create_digest: result.digest,
  };
}

export async function assertProtocolReadyForAnchor() {
  if (protocolMode() !== "canonical") {
    return;
  }
  const registry = await inspectTraceRegistry();
  if (!registry.writable) {
    throw new Error(registry.errors.join("; "));
  }
}

export async function getSuiMeshProtocolStatus() {
  const mode = protocolMode();
  const config = canonicalConfig();
  const errors: string[] = [];
  let registry: TraceRegistryInspection | undefined;

  if (mode === "canonical") {
    if (!config.tracePackageId) {
      errors.push("Missing SUIMESH_TRACE_PACKAGE_ID");
    }
    if (!config.traceRegistryId) {
      errors.push("Missing SUIMESH_TRACE_REGISTRY_ID");
    }
    if (config.tracePackageId && config.traceRegistryId) {
      try {
        registry = await inspectTraceRegistry();
        errors.push(...registry.errors);
      } catch (error) {
        errors.push(error instanceof Error ? error.message : "Protocol check failed");
      }
    }
  }

  const canonicalReady = mode !== "canonical" || errors.length === 0;
  return {
    mode,
    canonical: mode === "canonical",
    ok: canonicalReady,
    transport: mode === "canonical" ? "sui-stack-relayer" : "postgres",
    traceGuard: mode === "canonical" ? "sui-onchain" : "postgres",
    relayerUrl: mode === "canonical" ? config.relayerUrl : undefined,
    tracePackageId: mode === "canonical" ? config.tracePackageId : undefined,
    traceRegistryId: mode === "canonical" ? config.traceRegistryId : undefined,
    registry,
    errors,
  };
}
