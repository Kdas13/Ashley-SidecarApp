import { useEffect, useState } from 'react';
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { checkHealth } from '../src/api';
import { getAccessKey, getApiUrl, setAccessKey, setApiUrl } from '../src/settings';

export default function Setup() {
  const [url, setUrl] = useState('');
  const [accessKey, setAccessKeyValue] = useState('');
  const [status, setStatus] = useState('Enter the Echo API address and access key.');

  useEffect(() => {
    void Promise.all([getApiUrl(), getAccessKey()]).then(([storedUrl, storedKey]) => {
      setUrl(storedUrl);
      setAccessKeyValue(storedKey);
    });
  }, []);

  async function save() {
    try {
      const [storedUrl] = await Promise.all([setApiUrl(url), setAccessKey(accessKey)]);
      setStatus(`Saved ${storedUrl}. Checking Echo…`);
      const health = await checkHealth();
      setStatus(health.ok ? `Connected to Echo Foundation ${health.version}.` : 'Echo did not report healthy.');
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
    }
  }

  return <View style={styles.page}>
    <Text style={styles.eyebrow}>CONNECTION</Text>
    <Text style={styles.title}>Echo API</Text>
    <TextInput
      value={url}
      onChangeText={setUrl}
      autoCapitalize="none"
      autoCorrect={false}
      keyboardType="url"
      style={styles.input}
      placeholder="https://…/functions/v1/echo-api"
      placeholderTextColor="#6f6f7c"
    />
    <TextInput
      value={accessKey}
      onChangeText={setAccessKeyValue}
      autoCapitalize="none"
      autoCorrect={false}
      secureTextEntry
      style={styles.input}
      placeholder="Echo access key"
      placeholderTextColor="#6f6f7c"
    />
    <Pressable style={styles.button} onPress={() => void save()}>
      <Text style={styles.buttonText}>Save and test</Text>
    </Pressable>
    <Text style={styles.status}>{status}</Text>
  </View>;
}

const styles = StyleSheet.create({
  page: { flex: 1, padding: 24, justifyContent: 'center', gap: 18 },
  eyebrow: { color: '#9999a8', letterSpacing: 2 },
  title: { color: '#fff', fontSize: 38, fontWeight: '800' },
  input: { backgroundColor: '#17171f', borderColor: '#444450', borderWidth: 1, color: '#fff', padding: 16, borderRadius: 14 },
  button: { backgroundColor: '#f4f4f6', padding: 17, borderRadius: 14, alignItems: 'center' },
  buttonText: { color: '#09090c', fontWeight: '800' },
  status: { color: '#c5c5cf', lineHeight: 22 }
});
