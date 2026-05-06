import { Platform } from "react-native";

import {
  DEFAULT_PROFILE,
  loadMemories,
  loadMessages,
  loadProfile,
  loadSummaries,
  saveMemories,
  saveMessages,
  saveProfile,
  saveSummaries,
  type AshleyProfile,
  type ConversationSummary,
  type Memory,
  type Message,
} from "./storage";
import { importBackupToServer } from "./aiClient";

export const EXPORT_SCHEMA = "ashley-sidecar-export";
export const EXPORT_VERSION = 1;

export type ExportPayload = {
  schema: typeof EXPORT_SCHEMA;
  version: number;
  exportedAt: string;
  exportedFrom: "web" | "native";
  data: {
    profile: AshleyProfile;
    memories: Memory[];
    messages: Message[];
    summaries: ConversationSummary[];
  };
};

export type ImportSummary = {
  profile: boolean;
  memories: number;
  messages: number;
  summaries: number;
  /** True if the imported payload was also pushed to the server. False
   * means we only updated AsyncStorage — the next /state hydration will
   * overwrite this device's local copy with whatever the server has. */
  serverPushed: boolean;
  /** Reason the server push didn't happen, if applicable. */
  serverPushError?: string;
};

export type ExportResult =
  | { ok: true; filename: string; bytes: number }
  | { ok: false; reason: string };

export type PickImportResult =
  | { ok: true; payload: ExportPayload; rawBytes: number }
  | { ok: false; reason: string; cancelled?: boolean };

async function gatherExportPayload(): Promise<ExportPayload> {
  const [profile, memories, messages, summaries] = await Promise.all([
    loadProfile(),
    loadMemories(),
    loadMessages(),
    loadSummaries(),
  ]);
  return {
    schema: EXPORT_SCHEMA,
    version: EXPORT_VERSION,
    exportedAt: new Date().toISOString(),
    exportedFrom: Platform.OS === "web" ? "web" : "native",
    data: { profile, memories, messages, summaries },
  };
}

function defaultFilename(): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  return `ashley-backup-${stamp}.json`;
}

/**
 * Trigger an export. On web, this downloads a JSON file via the browser.
 * On native, this writes a JSON file to the app's document directory and
 * opens the OS share sheet so the user can save it to Files / Drive / etc.
 */
export async function triggerExport(): Promise<ExportResult> {
  try {
    const payload = await gatherExportPayload();
    const json = JSON.stringify(payload, null, 2);
    const filename = defaultFilename();

    if (Platform.OS === "web") {
      const blob = new Blob([json], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(() => URL.revokeObjectURL(url), 0);
      return { ok: true, filename, bytes: json.length };
    }

    const FileSystem = await import("expo-file-system/legacy");
    const Sharing = await import("expo-sharing");
    const dir = FileSystem.documentDirectory ?? FileSystem.cacheDirectory;
    if (!dir) return { ok: false, reason: "No writable directory available" };
    const path = `${dir}${filename}`;
    await FileSystem.writeAsStringAsync(path, json, {
      encoding: FileSystem.EncodingType.UTF8,
    });
    const canShare = await Sharing.isAvailableAsync();
    if (!canShare) {
      return {
        ok: false,
        reason: `Sharing not available. File saved at ${path}`,
      };
    }
    await Sharing.shareAsync(path, {
      mimeType: "application/json",
      dialogTitle: "Export Ashley backup",
      UTI: "public.json",
    });
    return { ok: true, filename, bytes: json.length };
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : String(err) };
  }
}

function validatePayload(parsed: unknown): ExportPayload {
  if (!parsed || typeof parsed !== "object") {
    throw new Error("File is not a JSON object");
  }
  const obj = parsed as Record<string, unknown>;
  if (obj.schema !== EXPORT_SCHEMA) {
    throw new Error("Not an Ashley export file (missing or wrong schema marker)");
  }
  if (typeof obj.version !== "number" || obj.version > EXPORT_VERSION) {
    throw new Error(
      `Unsupported export version ${String(obj.version)}. This app understands up to v${EXPORT_VERSION}.`,
    );
  }
  const data = obj.data as Record<string, unknown> | undefined;
  if (!data || typeof data !== "object") {
    throw new Error("Export file is missing the .data section");
  }
  if (!data.profile || typeof data.profile !== "object") {
    throw new Error("Export file has no profile");
  }
  if (!Array.isArray(data.memories)) {
    throw new Error("Export file has no memories array");
  }
  if (!Array.isArray(data.messages)) {
    throw new Error("Export file has no messages array");
  }
  if (!Array.isArray(data.summaries)) {
    throw new Error("Export file has no summaries array");
  }
  return obj as unknown as ExportPayload;
}

async function readPickedFileWeb(): Promise<string> {
  return new Promise((resolve, reject) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = "application/json,.json";
    input.onchange = () => {
      const file = input.files?.[0];
      if (!file) {
        reject(new Error("No file picked"));
        return;
      }
      const reader = new FileReader();
      reader.onload = () => {
        const text = reader.result;
        if (typeof text !== "string") {
          reject(new Error("Could not read file as text"));
          return;
        }
        resolve(text);
      };
      reader.onerror = () => reject(reader.error ?? new Error("Read failed"));
      reader.readAsText(file);
    };
    input.click();
  });
}

/**
 * Validate a JSON string pasted by the user. Same validation as the file
 * picker path, but with zero native-module dependencies — works on any
 * APK regardless of when it was built.
 */
export function parseAndValidateImportText(text: string): PickImportResult {
  try {
    const trimmed = text.trim();
    if (!trimmed) return { ok: false, reason: "Nothing pasted" };
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      return { ok: false, reason: "Pasted text is not valid JSON" };
    }
    const payload = validatePayload(parsed);
    return { ok: true, payload, rawBytes: trimmed.length };
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Phase 1 of import: pick + read + validate. Does NOT write to storage.
 * Caller should show a confirmation dialog using the returned payload's
 * counts before calling applyImportedPayload.
 */
export async function pickAndValidateImport(): Promise<PickImportResult> {
  try {
    let json: string;

    if (Platform.OS === "web") {
      json = await readPickedFileWeb();
    } else {
      const DocumentPicker = await import("expo-document-picker");
      const FileSystem = await import("expo-file-system/legacy");
      const result = await DocumentPicker.getDocumentAsync({
        type: ["application/json", "*/*"],
        copyToCacheDirectory: true,
        multiple: false,
      });
      if (result.canceled) {
        return { ok: false, reason: "Import cancelled", cancelled: true };
      }
      const asset = result.assets?.[0];
      if (!asset) return { ok: false, reason: "No file picked" };
      json = await FileSystem.readAsStringAsync(asset.uri, {
        encoding: FileSystem.EncodingType.UTF8,
      });
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(json);
    } catch {
      return { ok: false, reason: "File is not valid JSON" };
    }
    const payload = validatePayload(parsed);
    return { ok: true, payload, rawBytes: json.length };
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Phase 2 of import: write the validated payload to storage, REPLACING all
 * current local data. Caller is responsible for invalidating react-query
 * caches and (optionally) navigating away to force a fresh hydrate.
 */
export async function applyImportedPayload(
  payload: ExportPayload,
): Promise<ImportSummary> {
  const profile: AshleyProfile = {
    ...DEFAULT_PROFILE,
    ...payload.data.profile,
    updatedAt: new Date().toISOString(),
  };
  // Push to the server FIRST so the source-of-truth /state endpoint will
  // return the imported data on the next hydration. If this fails we
  // still write to AsyncStorage so the user has *something*, but we
  // surface the error so they know server-side data wasn't replaced.
  let serverPushed = false;
  let serverPushError: string | undefined;
  try {
    await importBackupToServer({
      schema: payload.schema,
      version: payload.version,
      data: {
        profile,
        messages: payload.data.messages,
        memories: payload.data.memories,
        summaries: payload.data.summaries,
      },
    });
    serverPushed = true;
  } catch (err) {
    serverPushError = err instanceof Error ? err.message : String(err);
  }
  await saveProfile(profile);
  await saveMemories(payload.data.memories);
  await saveMessages(payload.data.messages);
  await saveSummaries(payload.data.summaries);
  return {
    profile: true,
    memories: payload.data.memories.length,
    messages: payload.data.messages.length,
    summaries: payload.data.summaries.length,
    serverPushed,
    serverPushError,
  };
}

export function describeImportPlan(payload: ExportPayload): string {
  const d = payload.data;
  const exported = new Date(payload.exportedAt);
  const when = isNaN(exported.getTime())
    ? payload.exportedAt
    : exported.toLocaleString();
  return [
    `From: ${payload.exportedFrom} app, exported ${when}`,
    `Profile: ${d.profile.name || "Ashley"} (relationship: ${d.profile.relationshipMode || "—"})`,
    `Memories: ${d.memories.length}`,
    `Messages: ${d.messages.length}`,
    `Summaries: ${d.summaries.length}`,
  ].join("\n");
}

export function formatImportSummary(s: ImportSummary): string {
  const parts: string[] = [];
  if (s.profile) parts.push("profile");
  parts.push(`${s.memories} memor${s.memories === 1 ? "y" : "ies"}`);
  parts.push(`${s.messages} message${s.messages === 1 ? "" : "s"}`);
  parts.push(`${s.summaries} summar${s.summaries === 1 ? "y" : "ies"}`);
  const base = parts.join(", ");
  if (s.serverPushed) return `${base} (synced to server)`;
  return `${base} — WARNING server push failed${s.serverPushError ? `: ${s.serverPushError}` : ""}. Will be overwritten on next hydration.`;
}
