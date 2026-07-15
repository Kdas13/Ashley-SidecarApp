import { Stack, router } from 'expo-router';
import { useEffect, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, TextInput } from 'react-native';
import { getOpenAiKey, setOpenAiKey } from '../src/settings';

export default function OpenAiSetup() {
  const [key, setKey] = useState('');
  const [saved, setSaved] = useState(false);
  const [status, setStatus] = useState('The key stays encrypted on this Galaxy S24 and is never committed to the APK or GitHub.');

  useEffect(() => {
    void getOpenAiKey().then((value) => {
      setSaved(Boolean(value));
      if (value) setStatus('An OpenAI key is already stored securely on this device.');
    });
  }, []);

  async function save() {
    try {
      await setOpenAiKey(key);
      setKey('');
      setSaved(true);
      setStatus('Key saved securely. Opening Echo chat…');
      router.replace('/chat');
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
    }
  }

  return <ScrollView contentInsetAdjustmentBehavior="automatic" contentContainerStyle={styles.page}>
    <Stack.Screen options={{ title: 'Model connection' }} />
    <Text style={styles.eyebrow}>FOUNDATION 0.5</Text>
    <Text style={styles.title}>Connect Echo</Text>
    <Text style={styles.body}>Paste the OpenAI project key created for Echo. This development build calls OpenAI only when you press Send. Auto-recharge is off and there are no background calls.</Text>
    <TextInput
      value={key}
      onChangeText={setKey}
      autoCapitalize="none"
      autoCorrect={false}
      secureTextEntry
      style={styles.input}
      placeholder={saved ? 'Replace stored key' : 'sk-proj-…'}
      placeholderTextColor="#6f6f7c"
    />
    <Pressable style={styles.button} onPress={() => void save()}>
      <Text style={styles.buttonText}>{saved ? 'Replace key and open chat' : 'Save key and open chat'}</Text>
    </Pressable>
    <Text selectable style={styles.status}>{status}</Text>
    <Text style={styles.guard}>Echo cannot purchase, message, deploy, delete, control devices, or promote memories without Kane's explicit approval.</Text>
  </ScrollView>;
}

const styles = StyleSheet.create({
  page: { flexGrow: 1, padding: 24, justifyContent: 'center', gap: 18, backgroundColor: '#09090c' },
  eyebrow: { color: '#9999a8', letterSpacing: 2 },
  title: { color: '#fff', fontSize: 38, fontWeight: '800' },
  body: { color: '#c5c5cf', fontSize: 17, lineHeight: 25 },
  input: { backgroundColor: '#17171f', borderColor: '#444450', borderWidth: 1, color: '#fff', padding: 16, borderRadius: 14 },
  button: { backgroundColor: '#f4f4f6', padding: 17, borderRadius: 14, alignItems: 'center' },
  buttonText: { color: '#09090c', fontWeight: '800' },
  status: { color: '#c5c5cf', lineHeight: 22 },
  guard: { color: '#d6b787', lineHeight: 21 }
});
