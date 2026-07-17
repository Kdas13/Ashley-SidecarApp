import * as SecureStore from 'expo-secure-store';

const API_URL_KEY = 'echo_api_url';
const ACCESS_KEY_KEY = 'echo_api_access_key';
const OPENAI_KEY_KEY = 'echo_openai_api_key';
const defaultUrl = process.env.EXPO_PUBLIC_API_URL ?? 'https://qplsjpnccbjrxcmnxjon.supabase.co/functions/v1/echo-api';

export async function getApiUrl(): Promise<string> {
  return (await SecureStore.getItemAsync(API_URL_KEY)) ?? defaultUrl;
}

export async function setApiUrl(value: string): Promise<string> {
  const normalized = value.trim().replace(/\/+$/, '');
  if (!/^https:\/\//i.test(normalized)) throw new Error('Enter the full secure https:// Echo API address.');
  await SecureStore.setItemAsync(API_URL_KEY, normalized);
  return normalized;
}

export async function getAccessKey(): Promise<string> {
  return (await SecureStore.getItemAsync(ACCESS_KEY_KEY)) ?? '';
}

export async function setAccessKey(value: string): Promise<string> {
  const normalized = value.trim();
  if (normalized.length < 24) throw new Error('Enter the Echo access key supplied by Atlas.');
  await SecureStore.setItemAsync(ACCESS_KEY_KEY, normalized);
  return normalized;
}

export async function getOpenAiKey(): Promise<string> {
  return (await SecureStore.getItemAsync(OPENAI_KEY_KEY)) ?? '';
}

export async function setOpenAiKey(value: string): Promise<void> {
  const normalized = value.trim();
  if (!normalized.startsWith('sk-') || normalized.length < 30) throw new Error('Enter a valid OpenAI project API key.');
  await SecureStore.setItemAsync(OPENAI_KEY_KEY, normalized, {
    keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY
  });
}

export async function clearOpenAiKey(): Promise<void> {
  await SecureStore.deleteItemAsync(OPENAI_KEY_KEY);
}
