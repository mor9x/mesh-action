import { createHash } from "node:crypto";

import { SealClient } from "@mysten/seal";
import {
  hashBytes,
  WalrusHttpClient,
  WalrusStorageAdapter,
  type ContextRef,
  type StorageAdapter,
} from "suimesh";

import { PgStorageAdapter } from "@/lib/pg-suimesh-adapters";
import {
  SUI_DEMO_PACKAGE_ID,
  getSuiRuntimeClient,
} from "@/lib/sui-executor";

const DEFAULT_WALRUS_PUBLISHER_URL =
  "https://publisher.walrus-testnet.walrus.space";
const DEFAULT_WALRUS_AGGREGATOR_URL =
  "https://aggregator.walrus-testnet.walrus.space";
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

type SealServerConfig = {
  objectId: string;
  weight: number;
  aggregatorUrl?: string;
  apiKeyName?: string;
  apiKey?: string;
};

export type EncryptedArchive = {
  bytes: Uint8Array;
  contentType: string;
  sealAccessRef: string;
  sealMetadata: Record<string, string | number | boolean | string[]>;
};

export type ArchiveReceiptRefs = {
  archive_ref?: unknown;
  archive_digest?: unknown;
  archive_provider?: unknown;
  seal_access_ref?: unknown;
  seal_metadata?: unknown;
};

export type RestoredArchive = {
  provider?: string;
  blobId?: string;
  digest?: string;
  sealAccessRef?: string;
  sealMetadata?: unknown;
  available: boolean;
  digestVerified: boolean;
  encrypted: boolean;
  byteLength?: number;
  plaintextAvailable: false;
  status: "missing_ref" | "not_found" | "verified" | "digest_mismatch" | "read_failed";
  error?: string;
};

let storageAdapter: StorageAdapter | undefined;

export function createSuimeshStorageAdapter(): StorageAdapter {
  if (storageAdapter) {
    return storageAdapter;
  }

  if (process.env.SUIMESH_WALRUS_DISABLED === "true") {
    storageAdapter = new PgStorageAdapter();
    return storageAdapter;
  }

  storageAdapter = new WalrusStorageAdapter(
    new WalrusHttpClient({
      publisherUrl:
        process.env.SUIMESH_WALRUS_PUBLISHER_URL ??
        DEFAULT_WALRUS_PUBLISHER_URL,
      aggregatorUrl:
        process.env.SUIMESH_WALRUS_AGGREGATOR_URL ??
        DEFAULT_WALRUS_AGGREGATOR_URL,
      epochs: Number(process.env.SUIMESH_WALRUS_EPOCHS ?? 5),
      readRetry: {
        attempts: Number(process.env.SUIMESH_WALRUS_READ_ATTEMPTS ?? 8),
        delayMs: Number(process.env.SUIMESH_WALRUS_READ_DELAY_MS ?? 2500),
      },
    })
  );
  return storageAdapter;
}

export async function encryptArchive(input: {
  traceId: string;
  plaintext: Uint8Array;
}): Promise<EncryptedArchive> {
  if (process.env.SUIMESH_SEAL_MODE === "local") {
    return encryptArchiveLocal(input);
  }

  const packageId = process.env.SUIMESH_SEAL_PACKAGE_ID ?? SUI_DEMO_PACKAGE_ID;
  const serverConfigs = sealServerConfigs();
  const threshold = sealThreshold(serverConfigs);
  const sealClient = new SealClient({
    suiClient: getSuiRuntimeClient() as never,
    serverConfigs,
    verifyKeyServers: process.env.SUIMESH_SEAL_VERIFY_KEY_SERVERS !== "false",
    timeout: Number(process.env.SUIMESH_SEAL_TIMEOUT_MS ?? 30000),
  });
  const id = sealIdForTrace(input.traceId);
  const { encryptedObject } = await sealClient.encrypt({
    threshold,
    packageId,
    id,
    data: input.plaintext,
    aad: new TextEncoder().encode(input.traceId),
  });

  return {
    bytes: encryptedObject,
    contentType: "application/octet-stream",
    sealAccessRef: `seal://package/${packageId}/id/${id}/threshold/${threshold}`,
    sealMetadata: {
      provider: "seal",
      packageId,
      id,
      threshold,
      keyServers: serverConfigs.map((config) => config.objectId),
      verifyKeyServers: process.env.SUIMESH_SEAL_VERIFY_KEY_SERVERS !== "false",
    },
  };
}

export function archiveRefs(ref: ContextRef, archive: EncryptedArchive) {
  return {
    archive_ref: ref.blobId,
    archive_digest: ref.digest,
    archive_provider: ref.provider,
    seal_access_ref: archive.sealAccessRef,
    seal_metadata: archive.sealMetadata,
  };
}

export async function restoreArchiveRefs(
  refs: ArchiveReceiptRefs | null | undefined
): Promise<RestoredArchive> {
  if (
    !refs ||
    typeof refs.archive_ref !== "string" ||
    typeof refs.archive_digest !== "string" ||
    typeof refs.archive_provider !== "string"
  ) {
    return {
      available: false,
      digestVerified: false,
      encrypted: true,
      plaintextAvailable: false,
      status: "missing_ref",
    };
  }

  const contextRef: ContextRef = {
    provider: refs.archive_provider === "walrus" ? "walrus" : "local",
    blobId: refs.archive_ref,
    digest: refs.archive_digest,
    encrypted: true,
  };

  try {
    const bytes = await storageAdapterForProvider(contextRef.provider).get(
      contextRef
    );
    if (!bytes) {
      return {
        provider: contextRef.provider,
        blobId: contextRef.blobId,
        digest: contextRef.digest,
        sealAccessRef:
          typeof refs.seal_access_ref === "string"
            ? refs.seal_access_ref
            : undefined,
        sealMetadata: refs.seal_metadata,
        available: false,
        digestVerified: false,
        encrypted: true,
        plaintextAvailable: false,
        status: "not_found",
      };
    }

    const actualDigest = hashBytes(bytes);
    const digestVerified = actualDigest === contextRef.digest;
    return {
      provider: contextRef.provider,
      blobId: contextRef.blobId,
      digest: contextRef.digest,
      sealAccessRef:
        typeof refs.seal_access_ref === "string"
          ? refs.seal_access_ref
          : undefined,
      sealMetadata: refs.seal_metadata,
      available: true,
      digestVerified,
      encrypted: true,
      byteLength: bytes.byteLength,
      plaintextAvailable: false,
      status: digestVerified ? "verified" : "digest_mismatch",
      error: digestVerified
        ? undefined
        : `archive digest mismatch: expected ${contextRef.digest}, got ${actualDigest}`,
    };
  } catch (error) {
    return {
      provider: contextRef.provider,
      blobId: contextRef.blobId,
      digest: contextRef.digest,
      sealAccessRef:
        typeof refs.seal_access_ref === "string"
          ? refs.seal_access_ref
          : undefined,
      sealMetadata: refs.seal_metadata,
      available: false,
      digestVerified: false,
      encrypted: true,
      plaintextAvailable: false,
      status: "read_failed",
      error: error instanceof Error ? error.message : "archive read failed",
    };
  }
}

function storageAdapterForProvider(provider: ContextRef["provider"]) {
  return provider === "local" ? new PgStorageAdapter() : createSuimeshStorageAdapter();
}

function sealServerConfigs(): SealServerConfig[] {
  const raw = process.env.SUIMESH_SEAL_SERVER_CONFIGS;
  if (!raw) {
    return TESTNET_OPEN_SEAL_SERVER_CONFIGS;
  }

  const parsed = JSON.parse(raw) as SealServerConfig[];
  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new Error("SUIMESH_SEAL_SERVER_CONFIGS must be a non-empty JSON array");
  }
  return parsed.map((config) => ({
    ...config,
    weight: Number(config.weight),
  }));
}

function sealThreshold(configs: SealServerConfig[]) {
  const totalWeight = configs.reduce((sum, config) => sum + config.weight, 0);
  const threshold = Number(
    process.env.SUIMESH_SEAL_THRESHOLD ?? Math.min(2, totalWeight)
  );
  if (!Number.isInteger(threshold) || threshold <= 0 || threshold > totalWeight) {
    throw new Error(
      `Invalid SUIMESH_SEAL_THRESHOLD ${threshold}; total key-server weight is ${totalWeight}`
    );
  }
  return threshold;
}

function sealIdForTrace(traceId: string) {
  return `0x${createHash("sha256")
    .update(`suimesh-archive:${traceId}`)
    .digest("hex")}`;
}

async function encryptArchiveLocal(input: {
  traceId: string;
  plaintext: Uint8Array;
}): Promise<EncryptedArchive> {
  const localArchiveKey = process.env.SUIMESH_LOCAL_ARCHIVE_KEY?.trim();
  if (!localArchiveKey) {
    throw new Error("SUIMESH_LOCAL_ARCHIVE_KEY is required when SUIMESH_SEAL_MODE=local");
  }
  const keyBytes = createHash("sha256")
    .update(localArchiveKey)
    .digest();
  const key = await crypto.subtle.importKey(
    "raw",
    keyBytes,
    "AES-GCM",
    false,
    ["encrypt"]
  );
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: "AES-GCM", iv },
      key,
      bytesToArrayBuffer(input.plaintext)
    )
  );
  const bytes = new TextEncoder().encode(
    JSON.stringify({
      protocol: "suimesh",
      kind: "local-encrypted-archive",
      traceId: input.traceId,
      algorithm: "AES-GCM-256",
      iv: Buffer.from(iv).toString("base64url"),
      ciphertext: Buffer.from(ciphertext).toString("base64url"),
    })
  );

  return {
    bytes,
    contentType: "application/json",
    sealAccessRef: `seal://local/${input.traceId}`,
    sealMetadata: {
      provider: "local-aes-gcm",
      warning: "local mode is for development only",
    },
  };
}

function bytesToArrayBuffer(bytes: Uint8Array) {
  return bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength
  ) as ArrayBuffer;
}
