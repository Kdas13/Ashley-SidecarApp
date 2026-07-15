import { Link, Stack } from 'expo-router';
import { useEffect, useMemo, useRef, useState } from 'react';
import { FlatList, KeyboardAvoidingView, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { EchoMessage, sendToEcho } from '../src/openai';
import { getOpenAiKey } from '../src/settings';

export default function Chat() {
  const [messages, setMessages] = useState<EchoMessage[]>([{ id: 'welcome', role: 'assistant', text: 'Hello, Kane. Echo is online. What are we working on?' }]);
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const [configured, setConfigured] = useState<boolean | null>(null);
  const [error, setError] = useState('');
  const listRef = useRef<FlatList<EchoMessage>>(null);
  const canSend = useMemo(() => configured && draft.trim().length > 0 && !sending, [configured, draft, sending]);

  useEffect(() => { void getOpenAiKey().then((key) => setConfigured(Boolean(key))); }, []);
  useEffect(() => { setTimeout(() => listRef.current?.scrollToEnd({ animated: true }), 50); }, [messages, sending]);

  async function send() {
    if (!canSend) return;
    const user: EchoMessage = { id: `${Date.now()}-u`, role: 'user', text: draft.trim() };
    const next = [...messages, user];
    setMessages(next);
    setDraft('');
    setError('');
    setSending(true);
    try {
      const result = await sendToEcho(next);
      setMessages((current) => [...current, { id: `${Date.now()}-a`, role: 'assistant', text: result.text }]);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSending(false);
    }
  }

  return <KeyboardAvoidingView style={styles.page} behavior="padding">
    <Stack.Screen options={{ title: 'Echo', headerRight: () => <Link href="/developer" style={styles.headerLink}>Status</Link> }} />
    {configured === false ? <View style={styles.center}>
      <Text style={styles.title}>Model key required</Text>
      <Text style={styles.muted}>Echo needs the OpenAI project key stored securely on this device.</Text>
      <Link href="/openai-setup" asChild><Pressable style={styles.button}><Text style={styles.buttonText}>Connect model</Text></Pressable></Link>
    </View> : <>
      <FlatList
        ref={listRef}
        data={messages}
        keyExtractor={(item) => item.id}
        contentInsetAdjustmentBehavior="automatic"
        contentContainerStyle={styles.list}
        renderItem={({ item }) => <View style={[styles.bubble, item.role === 'user' ? styles.user : styles.echo]}><Text selectable style={styles.message}>{item.text}</Text></View>}
        ListFooterComponent={sending ? <Text style={styles.thinking}>Echo is thinking…</Text> : error ? <Text selectable style={styles.error}>{error}</Text> : null}
      />
      <View style={styles.composer}>
        <TextInput value={draft} onChangeText={setDraft} placeholder="Message Echo…" placeholderTextColor="#777784" multiline style={styles.input} editable={!sending} />
        <Pressable disabled={!canSend} onPress={() => void send()} style={[styles.send, !canSend && styles.disabled]}><Text style={styles.sendText}>Send</Text></Pressable>
      </View>
    </>}
  </KeyboardAvoidingView>;
}

const styles = StyleSheet.create({
  page: { flex: 1, backgroundColor: '#09090c' },
  headerLink: { color: '#fff', fontWeight: '700' },
  list: { padding: 16, gap: 12 },
  bubble: { maxWidth: '88%', padding: 14, borderRadius: 18 },
  user: { alignSelf: 'flex-end', backgroundColor: '#f4f4f6' },
  echo: { alignSelf: 'flex-start', backgroundColor: '#1a1a22', borderColor: '#343440', borderWidth: 1 },
  message: { color: '#fff', fontSize: 16, lineHeight: 23 },
  thinking: { color: '#a9a9b4', paddingVertical: 8 },
  error: { color: '#ff9b8f', paddingVertical: 8, lineHeight: 21 },
  composer: { flexDirection: 'row', gap: 10, padding: 12, borderTopColor: '#24242d', borderTopWidth: 1, backgroundColor: '#101015' },
  input: { flex: 1, maxHeight: 130, minHeight: 48, color: '#fff', backgroundColor: '#191920', borderRadius: 16, paddingHorizontal: 14, paddingVertical: 12 },
  send: { justifyContent: 'center', paddingHorizontal: 16, borderRadius: 16, backgroundColor: '#f4f4f6' },
  disabled: { opacity: 0.35 },
  sendText: { color: '#09090c', fontWeight: '800' },
  center: { flex: 1, justifyContent: 'center', padding: 24, gap: 18 },
  title: { color: '#fff', fontSize: 34, fontWeight: '800' },
  muted: { color: '#c5c5cf', fontSize: 17, lineHeight: 25 },
  button: { backgroundColor: '#f4f4f6', padding: 17, borderRadius: 14, alignItems: 'center' },
  buttonText: { color: '#09090c', fontWeight: '800' }
});
