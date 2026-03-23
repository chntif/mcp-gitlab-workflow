import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { DeliveryMethod } from "./delivery-mode.js";

export const DELIVERY_PREPARATION_TTL_MS = 30 * 60 * 1000;
const DELIVERY_PREPARATION_STATE_DIR = ".mcp-state";
const DELIVERY_PREPARATION_STATE_FILE = "delivery-preparations.json";

export type DeliveryPreparationRecord = {
  preparationKey: string;
  repoPath: string;
  remoteName: string;
  baseBranch: string;
  baseHeadSha: string;
  deliveryMethod: DeliveryMethod;
  workingBranch?: string;
  preparedAt: string;
  expiresAt: string;
};

type DeliveryPreparationStore = {
  preparations: Record<string, DeliveryPreparationRecord>;
};

function createEmptyStore(): DeliveryPreparationStore {
  return { preparations: {} };
}

function getModuleDir(): string {
  return dirname(fileURLToPath(import.meta.url));
}

function isValidRecord(value: unknown): value is DeliveryPreparationRecord {
  if (!value || typeof value !== "object") {
    return false;
  }

  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.preparationKey === "string" &&
    candidate.preparationKey.trim().length > 0 &&
    typeof candidate.repoPath === "string" &&
    candidate.repoPath.trim().length > 0 &&
    typeof candidate.remoteName === "string" &&
    candidate.remoteName.trim().length > 0 &&
    typeof candidate.baseBranch === "string" &&
    candidate.baseBranch.trim().length > 0 &&
    typeof candidate.baseHeadSha === "string" &&
    candidate.baseHeadSha.trim().length > 0 &&
    (candidate.deliveryMethod === "local_git" || candidate.deliveryMethod === "remote_api") &&
    (candidate.workingBranch === undefined ||
      (typeof candidate.workingBranch === "string" && candidate.workingBranch.trim().length > 0)) &&
    typeof candidate.preparedAt === "string" &&
    !Number.isNaN(Date.parse(candidate.preparedAt)) &&
    typeof candidate.expiresAt === "string" &&
    !Number.isNaN(Date.parse(candidate.expiresAt))
  );
}

function normalizeStore(raw: unknown, nowMs: number): DeliveryPreparationStore {
  if (!raw || typeof raw !== "object") {
    return createEmptyStore();
  }

  const rawPreparations = (raw as { preparations?: unknown }).preparations;
  if (!rawPreparations || typeof rawPreparations !== "object") {
    return createEmptyStore();
  }

  const preparations: Record<string, DeliveryPreparationRecord> = {};
  for (const [key, value] of Object.entries(rawPreparations as Record<string, unknown>)) {
    if (!isValidRecord(value)) {
      continue;
    }
    if (Date.parse(value.expiresAt) <= nowMs) {
      continue;
    }
    preparations[key] = value;
  }

  return { preparations };
}

async function readStore(statePath: string, nowMs: number): Promise<DeliveryPreparationStore> {
  try {
    const raw = await readFile(statePath, "utf8");
    return normalizeStore(JSON.parse(raw), nowMs);
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") {
      return createEmptyStore();
    }
    throw error;
  }
}

async function writeStore(statePath: string, store: DeliveryPreparationStore): Promise<void> {
  await mkdir(dirname(statePath), { recursive: true });
  await writeFile(statePath, JSON.stringify(store, null, 2), "utf8");
}

export function getDeliveryPreparationStatePath(rootDir = getModuleDir()): string {
  return resolve(rootDir, DELIVERY_PREPARATION_STATE_DIR, DELIVERY_PREPARATION_STATE_FILE);
}

export async function saveDeliveryPreparationRecord(
  statePath: string,
  params: {
    repoPath: string;
    remoteName: string;
    baseBranch: string;
    baseHeadSha: string;
    deliveryMethod: DeliveryMethod;
    workingBranch?: string;
    nowMs?: number;
  },
): Promise<DeliveryPreparationRecord> {
  const nowMs = params.nowMs ?? Date.now();
  const store = await readStore(statePath, nowMs);
  const record: DeliveryPreparationRecord = {
    preparationKey: randomUUID(),
    repoPath: params.repoPath,
    remoteName: params.remoteName,
    baseBranch: params.baseBranch,
    baseHeadSha: params.baseHeadSha,
    deliveryMethod: params.deliveryMethod,
    workingBranch: params.workingBranch,
    preparedAt: new Date(nowMs).toISOString(),
    expiresAt: new Date(nowMs + DELIVERY_PREPARATION_TTL_MS).toISOString(),
  };
  store.preparations[record.preparationKey] = record;
  await writeStore(statePath, store);
  return record;
}

export async function getDeliveryPreparationRecord(
  statePath: string,
  preparationKey: string,
  nowMs = Date.now(),
): Promise<DeliveryPreparationRecord | undefined> {
  const store = await readStore(statePath, nowMs);
  const record = store.preparations[preparationKey];
  if (!record) {
    await writeStore(statePath, store);
    return undefined;
  }
  await writeStore(statePath, store);
  return record;
}

export async function deleteDeliveryPreparationRecord(
  statePath: string,
  preparationKey: string,
  nowMs = Date.now(),
): Promise<void> {
  const store = await readStore(statePath, nowMs);
  delete store.preparations[preparationKey];
  await writeStore(statePath, store);
}
