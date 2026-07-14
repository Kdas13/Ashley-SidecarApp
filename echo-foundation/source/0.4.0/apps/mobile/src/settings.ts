import * as SecureStore from 'expo-secure-store';

const API_URL_KEY = 'echo_api_url';
const defaultUrl = process.env.EXPO_PUBLIC_API_URL ?? 'http://10.0.2.2:8080';

export async function getApiUrl(): Promise<string> {
  return (await SecureStore.getItemAsync(API_URL_KEY)) ?? defaultUrl;
}

export async function setApiUrl(value: string): Promise<string> {
  const normalized = value.trim().replace(/\/+$/, '');
  if (!/^https?:\/\//i.test(normalized)) throw new Error('Enter a full http:// or https:// API address.');
  await SecureStore.setItemAsync(API_URL_KEY, normalized);
  return normalized;
}
