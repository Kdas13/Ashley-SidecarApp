import Constants from "expo-constants";

/**
 * Returns the absolute base URL (host only) of the API server.
 * In dev, EXPO_PUBLIC_DOMAIN is the Replit dev domain (no scheme).
 * Falls back to the manifest's host.
 */
export function getApiBaseUrl(): string | null {
  const domain = process.env["EXPO_PUBLIC_DOMAIN"];
  if (domain) return `https://${domain}`;

  const hostUri =
    (Constants.expoConfig as { hostUri?: string } | null | undefined)?.hostUri;
  if (hostUri) {
    const host = hostUri.split(":")[0];
    return host ? `http://${host}:18115` : null;
  }
  return null;
}

/**
 * Resolves a server-relative URL (e.g. "/api/selfies/x.png") to an absolute URL.
 */
export function resolveImageUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  if (url.startsWith("http://") || url.startsWith("https://")) return url;
  const base = getApiBaseUrl();
  if (!base) return url;
  return `${base}${url.startsWith("/") ? url : `/${url}`}`;
}
