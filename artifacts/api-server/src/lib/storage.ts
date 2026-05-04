import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import type { File as GcsFile } from "@google-cloud/storage";
import { objectStorageClient } from "./objectStorage";
import { logger } from "./logger";

const isProd = process.env["NODE_ENV"] === "production";

const localStorageDir = isProd
  ? path.resolve(process.cwd(), "artifacts/api-server/storage")
  : path.resolve(process.cwd(), "storage");

export const localSelfieDir = path.join(localStorageDir, "selfies");
export const localUserImageDir = path.join(localStorageDir, "user-images");

if (!fs.existsSync(localSelfieDir)) {
  fs.mkdirSync(localSelfieDir, { recursive: true });
}
if (!fs.existsSync(localUserImageDir)) {
  fs.mkdirSync(localUserImageDir, { recursive: true });
}

const USER_IMAGE_EXT_BY_MIME: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/jpg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/gif": "gif",
  "image/heic": "heic",
};

export function userImageExtForMime(mime: string): string {
  const lower = mime.toLowerCase();
  return USER_IMAGE_EXT_BY_MIME[lower] ?? "bin";
}

function parseObjectPath(fullPath: string): {
  bucketName: string;
  objectName: string;
} {
  const trimmed = fullPath.startsWith("/") ? fullPath : `/${fullPath}`;
  const parts = trimmed.split("/").filter((p) => p.length > 0);
  if (parts.length < 2) {
    throw new Error(
      `Invalid object path "${fullPath}": expected /<bucket>/<objectName>`,
    );
  }
  const [bucketName, ...rest] = parts;
  return { bucketName: bucketName!, objectName: rest.join("/") };
}

function getObjectStorageConfig(): { bucketName: string; prefix: string } | null {
  const dir = process.env["PRIVATE_OBJECT_DIR"];
  if (!dir) return null;
  try {
    const { bucketName, objectName } = parseObjectPath(dir);
    const prefix = objectName.endsWith("/") ? objectName : `${objectName}/`;
    return { bucketName, prefix };
  } catch (err) {
    logger.warn(
      { err, PRIVATE_OBJECT_DIR: dir },
      "PRIVATE_OBJECT_DIR is set but could not be parsed; falling back to local disk",
    );
    return null;
  }
}

function gcsSelfieFile(id: string): GcsFile | null {
  const cfg = getObjectStorageConfig();
  if (!cfg) return null;
  const objectName = `${cfg.prefix}selfies/${id}.png`;
  return objectStorageClient.bucket(cfg.bucketName).file(objectName);
}

function gcsUserImageFile(filename: string): GcsFile | null {
  const cfg = getObjectStorageConfig();
  if (!cfg) return null;
  const objectName = `${cfg.prefix}user-images/${filename}`;
  return objectStorageClient.bucket(cfg.bucketName).file(objectName);
}

export interface SelfieStorageMode {
  mode: "object-storage" | "local";
}

export function getSelfieStorageMode(): SelfieStorageMode {
  return { mode: getObjectStorageConfig() ? "object-storage" : "local" };
}

/**
 * Persist a generated selfie. Writes to Replit Object Storage when
 * PRIVATE_OBJECT_DIR is configured, otherwise to the local disk.
 *
 * Returns a stable URL suitable for the chat message's imageUrl field. The
 * URL points at this server's /api/selfies/<id>.png endpoint, which knows
 * how to read from either backend.
 */
export async function saveSelfie(id: string, data: Buffer): Promise<string> {
  const file = gcsSelfieFile(id);
  if (file) {
    await file.save(data, {
      contentType: "image/png",
      resumable: false,
      metadata: { cacheControl: "public, max-age=2592000" },
    });
  } else {
    const filePath = path.join(localSelfieDir, `${id}.png`);
    await fsp.writeFile(filePath, data);
  }
  return `/api/selfies/${id}.png`;
}

export interface SelfieReadResult {
  stream: Readable;
  contentType: string;
  contentLength?: number;
}

/**
 * Open a generated selfie for reading. Tries object storage first when
 * configured, then falls back to the local disk. This lets selfies that
 * were saved before object storage was provisioned still load.
 *
 * Returns null if the selfie is not found in either backend.
 */
export async function openSelfie(id: string): Promise<SelfieReadResult | null> {
  const file = gcsSelfieFile(id);
  if (file) {
    try {
      const [exists] = await file.exists();
      if (exists) {
        const [metadata] = await file.getMetadata();
        const contentLength =
          typeof metadata.size === "string"
            ? Number(metadata.size)
            : typeof metadata.size === "number"
              ? metadata.size
              : undefined;
        return {
          stream: file.createReadStream(),
          contentType:
            (metadata.contentType as string | undefined) ?? "image/png",
          contentLength,
        };
      }
    } catch (err) {
      logger.warn(
        { err, id },
        "Object storage read failed; falling back to local disk",
      );
    }
  }

  const filePath = path.join(localSelfieDir, `${id}.png`);
  try {
    const stat = await fsp.stat(filePath);
    return {
      stream: fs.createReadStream(filePath),
      contentType: "image/png",
      contentLength: stat.size,
    };
  } catch {
    return null;
  }
}

/**
 * Persist a photo uploaded by the user (paperclip flow). Stored under
 * user-images/<filename> in object storage when configured, otherwise
 * on local disk. The filename should already include a UUID and the
 * correct extension; pass it in via `${id}.${ext}`.
 *
 * Returns a stable URL (relative path) for the messages.imageUrl field.
 * The URL points at /api/user-images/<filename> on this server.
 */
export async function saveUserImage(
  filename: string,
  data: Buffer,
  contentType: string,
): Promise<string> {
  const file = gcsUserImageFile(filename);
  if (file) {
    await file.save(data, {
      contentType,
      resumable: false,
      metadata: { cacheControl: "public, max-age=2592000" },
    });
  } else {
    const filePath = path.join(localUserImageDir, filename);
    await fsp.writeFile(filePath, data);
  }
  return `/api/user-images/${filename}`;
}

export async function openUserImage(
  filename: string,
): Promise<SelfieReadResult | null> {
  const file = gcsUserImageFile(filename);
  if (file) {
    try {
      const [exists] = await file.exists();
      if (exists) {
        const [metadata] = await file.getMetadata();
        const contentLength =
          typeof metadata.size === "string"
            ? Number(metadata.size)
            : typeof metadata.size === "number"
              ? metadata.size
              : undefined;
        return {
          stream: file.createReadStream(),
          contentType:
            (metadata.contentType as string | undefined) ??
            "application/octet-stream",
          contentLength,
        };
      }
    } catch (err) {
      logger.warn(
        { err, filename },
        "User image object-storage read failed; falling back to local disk",
      );
    }
  }

  const filePath = path.join(localUserImageDir, filename);
  try {
    const stat = await fsp.stat(filePath);
    const ext = path.extname(filename).slice(1).toLowerCase();
    const ct =
      ext === "png"
        ? "image/png"
        : ext === "webp"
          ? "image/webp"
          : ext === "gif"
            ? "image/gif"
            : ext === "heic"
              ? "image/heic"
              : "image/jpeg";
    return {
      stream: fs.createReadStream(filePath),
      contentType: ct,
      contentLength: stat.size,
    };
  } catch {
    return null;
  }
}
