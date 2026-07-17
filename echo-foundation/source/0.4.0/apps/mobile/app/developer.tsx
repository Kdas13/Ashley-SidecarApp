import { Stack } from 'expo-router';
import { useEffect, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { checkHealth } from '../src/api';
import { ECHO_MODEL } from '../src/openai';
import { clearOpenAiKey, getOpenAiKey } from '../src/settings';

export default function Developer() {
  const [modelKey, setModelKey] = useState<boolean | null>(null);
  const [api, setApi] = useState('Checking…');
  const [error, setError] = useState('None');

  async function refresh() {
    setError('None');
    try {
      const [key, health] = await Promise.all([getOpenAiKey(), checkHealth()]);
      setModelKey(Boolean(key));
      setApi(health.ok ? `Connected · Foundation ${health.version}` : 'Unhealthy response');
    } catch (err) {
      setModelKey(Boolean(await getOpenAiKey()));
      setApi('Unavailable');
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  useEffect(() => { void refresh(); }, []);

  async function removeKey() {
    await clearOpenAiKey();
    setModelKey(false);
  }

  return <ScrollView contentInsetAdjustmentBehavior="automatic" contentContainerStyle={styles.page}>
    <Stack.Screen options={{ title: 'Developer Mode' }} />
    <Text style={styles.eyebrow}>ECHO FOUNDATION 0.5</Text>
    <Text style={styles.title}>System diagnostics</Text>
    <Status label="Echo API" value={api} good={api.startsWith('Connected')} />
    <Status label="OpenAI key" value={modelKey === null ? 'Checking…' : modelKey ? 'Stored securely on this device' : 'Not configured'} good={modelKey === true} />
    <Status label="Model" value={ECHO_MODEL} good />
    <Status label="Paid calls" value="Manual Send only · no automatic retry" good />
    <Status label="Background jobs" value="Disabled" good />
    <Status label="Human approval gates" value="Financial, destructive, external, production, identity and memory-sensitive actions" good />
    <Status label="Latest error" value={error} good={error === 'None'} />
    <Pressable style={styles.button} onPress={() => void refresh()}><Text style={styles.buttonText}>Refresh checks</Text></Pressable>
    {modelKey ? <Pressable style={styles.danger} onPress={() => void removeKey()}><Text style={styles.dangerText}>Remove OpenAI key from this phone</Text></Pressable> : null}
  </ScrollView>;
}

function Status({ label, value, good }: { label: string; value: string; good: boolean }) {
  return <View style={styles.card}>
    <Text style={styles.label}>{label}</Text>
    <Text selectable style={good ? styles.good : styles.bad}>● {value}</Text>
  </View>;
}

const styles = StyleSheet.create({
  page: { padding: 20, gap: 12, backgroundColor: '#09090c' },
  eyebrow: { color: '#9999a8', letterSpacing: 2 },
  title: { color: '#fff', fontSize: 34, fontWeight: '800', paddingBottom: 8 },
  card: { backgroundColor: '#17171f', borderColor: '#33333e', borderWidth: 1, borderRadius: 16, padding: 16, gap: 7 },
  label: { color: '#9999a8', fontSize: 13, letterSpacing: 1, textTransform: 'uppercase' },
  good: { color: '#a7e6be', fontSize: 16, lineHeight: 23 },
  bad: { color: '#ff9b8f', fontSize: 16, lineHeight: 23 },
  button: { backgroundColor: '#f4f4f6', padding: 16, borderRadius: 14, alignItems: 'center', marginTop: 8 },
  buttonText: { color: '#09090c', fontWeight: '800' },
  danger: { borderColor: '#8d4b48', borderWidth: 1, padding: 16, borderRadius: 14, alignItems: 'center' },
  dangerText: { color: '#ffaaa2', fontWeight: '700' }
});
