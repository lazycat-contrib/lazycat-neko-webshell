import type { Client } from "@connectrpc/connect";

import type { InvokePluginResponse } from "../../gen/lazycat/webshell/v1/capability_pb";
import { FILE_TRANSFER_PLUGIN_ID } from "../../plugin-utils";

type CapabilityClient = Client<typeof import("../../gen/lazycat/webshell/v1/capability_pb").CapabilityService>;

export type TransferProgressMeta = Record<string, unknown>;

export type ConnectUploadDone = {
  meta: TransferProgressMeta;
};

export type FileTransferConnectResponse = {
  payload: Uint8Array;
  meta: TransferProgressMeta;
  contentType: string;
  status: string;
};

export type ConnectUploadCallbacks = {
  onProgress?: (meta: TransferProgressMeta) => void;
};

const CONNECT_UPLOAD_CHUNK_BYTES = 256 * 1024;
const CONNECT_UPLOAD_TIMEOUT_MS = 120_000;

export async function uploadFileWithConnect(
  capabilityClient: CapabilityClient,
  file: File,
  sessionId: string,
  remotePath: string,
  callbacks: ConnectUploadCallbacks = {},
): Promise<ConnectUploadDone> {
  let uploadId = "";
  try {
    const begin = await invokeFileTransferWithConnect(capabilityClient, sessionId, "upload_begin", {
      path: remotePath,
      name: file.name,
      size: String(file.size),
    });
    const beginMeta = begin.meta;
    uploadId = stringMeta(beginMeta, "uploadId");
    if (!uploadId) throw new Error("file upload did not return an upload id");
    callbacks.onProgress?.(beginMeta);

    let offset = 0;
    while (offset < file.size) {
      const nextOffset = Math.min(offset + CONNECT_UPLOAD_CHUNK_BYTES, file.size);
      const chunk = new Uint8Array(await file.slice(offset, nextOffset).arrayBuffer());
      const progress = await invokeFileTransferWithConnect(capabilityClient, sessionId, "upload_chunk", {
        uploadId,
        offset: String(offset),
      }, chunk, "application/octet-stream");
      callbacks.onProgress?.(progress.meta);
      offset = nextOffset;
    }

    const finished = await invokeFileTransferWithConnect(capabilityClient, sessionId, "upload_finish", {
      uploadId,
    });
    const doneMeta = {
      ...finished.meta,
      name: file.name,
      path: remotePath,
      percent: 100,
      done: true,
    };
    callbacks.onProgress?.(doneMeta);
    return { meta: doneMeta };
  } catch (error) {
    if (uploadId) {
      await invokeFileTransferWithConnect(capabilityClient, sessionId, "upload_cancel", {
        uploadId,
      }).catch(() => undefined);
    }
    throw error;
  }
}

export async function invokeFileTransferWithConnect(
  capabilityClient: CapabilityClient,
  sessionId: string,
  operation: string,
  metadata: Record<string, string>,
  payload = new Uint8Array(),
  contentType = "text/plain",
): Promise<FileTransferConnectResponse> {
  const response = await capabilityClient.invokePlugin({
    pluginId: FILE_TRANSFER_PLUGIN_ID,
    sessionId,
    operation,
    contentType,
    payload,
    metadata,
  }, { timeoutMs: CONNECT_UPLOAD_TIMEOUT_MS });
  return {
    payload: response.payload,
    meta: responseMeta(response),
    contentType: response.contentType || contentType,
    status: response.status,
  };
}

export function responsePayloadText(response: FileTransferConnectResponse): string {
  return new TextDecoder().decode(response.payload);
}

function responseMeta(response: InvokePluginResponse): TransferProgressMeta {
  return {
    ...response.metadata,
    ...jsonPayload(response.payload, response.contentType),
  };
}

function jsonPayload(payload: Uint8Array, contentType: string): TransferProgressMeta {
  if (!contentType.includes("application/json")) return {};
  const text = new TextDecoder().decode(payload);
  if (!text.trim()) return {};
  const parsed = JSON.parse(text) as unknown;
  return parsed && typeof parsed === "object" && !Array.isArray(parsed)
    ? parsed as TransferProgressMeta
    : {};
}

function stringMeta(meta: TransferProgressMeta, key: string): string {
  const value = meta[key];
  return typeof value === "string" ? value : "";
}
