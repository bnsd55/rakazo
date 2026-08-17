import { createHash } from "node:crypto";
import path from "node:path";
import type { ArtifactStore } from "@rakazo/adapter-kit";
import type { MessageBlock } from "@rakazo/contracts";
import { ATTACHMENT_MAX_BYTES } from "@rakazo/contracts";
import {
  inferAttachmentMimeType,
  messageBlockForArtifact,
  validateAttachmentMimeType,
} from "@rakazo/core";
import type { PrismaClient } from "@rakazo/db";

export async function attachWorkspaceFileToThread(
  deps: {
    prisma: PrismaClient;
    artifacts: ArtifactStore;
  },
  input: {
    workspaceId: string;
    userId: string;
    botId: string;
    runId: string;
    filePath: string;
    bytes: Uint8Array;
    operationId: string;
  },
): Promise<{ artifactId: string; block: Extract<MessageBlock, { kind: "image" | "file" }> }> {
  const name = path.basename(input.filePath) || input.filePath;
  const mimeType = inferAttachmentMimeType(name);
  if (!mimeType) {
    throw new Error(`Unsupported attachment type for ${name}`);
  }
  validateAttachmentMimeType(mimeType);
  if (input.bytes.byteLength > ATTACHMENT_MAX_BYTES) {
    throw new Error("file exceeds the 10 MiB attachment limit");
  }

  const context = {
    operationId: input.operationId,
    traceId: input.operationId,
    workspaceId: input.workspaceId,
    userId: input.userId,
    botId: input.botId,
    signal: new AbortController().signal,
  };
  const stored = await deps.artifacts.put(
    { name, mimeType, bytes: input.bytes },
    context,
  );
  const hash = createHash("sha256").update(input.bytes).digest("hex");
  const row = await deps.prisma.artifact.create({
    data: {
      workspaceId: input.workspaceId,
      userId: input.userId,
      botId: input.botId,
      runId: input.runId,
      name,
      mimeType,
      size: input.bytes.byteLength,
      hash,
      storageKey: stored.id,
    },
  });
  return {
    artifactId: row.id,
    block: messageBlockForArtifact({
      id: row.id,
      name: row.name,
      mimeType: row.mimeType,
      size: row.size,
    }),
  };
}
