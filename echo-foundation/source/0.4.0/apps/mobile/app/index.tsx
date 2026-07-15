import { router } from 'expo-router';
import { Pressable, StyleSheet, Text, View } from 'react-native';

export default function Home() {
  return <View style={styles.page}>
    <Text style={styles.eyebrow}>ECHO FOUNDATION 0.5</Text>
    <Text style={styles.title}>Talk to Echo.</Text>
    <Text style={styles.body}>A working, guarded conversation build for Kane's Galaxy S24. Model calls happen only when you press Send.</Text>
    <Pressable style={styles.button} onPress={() => router.push('/chat')}><Text style={styles.buttonText}>Open Echo chat</Text></Pressable>
    <Pressable style={styles.secondary} onPress={() => router.push('/developer')}><Text style={styles.light}>Developer Mode</Text></Pressable>
    <Pressable style={styles.secondary} onPress={() => router.push('/openai-setup')}><Text style={styles.light}>Model connection</Text></Pressable>
    <Pressable style={styles.secondary} onPress={() => router.push('/memory-upload')}><Text style={styles.light}>Memory installer</Text></Pressable>
    <Text style={styles.guard}>No purchases, external actions, deployments, destructive changes, device control, or memory promotion without Kane's explicit human approval.</Text>
  </View>;
}

const styles = StyleSheet.create({
  page: { flex: 1, padding: 24, justifyContent: 'center', gap: 16, backgroundColor: '#09090c' },
  eyebrow: { color: '#9999a8', letterSpacing: 2 },
  title: { color: '#fff', fontSize: 40, fontWeight: '800' },
  body: { color: '#c5c5cf', fontSize: 17, lineHeight: 25 },
  button: { backgroundColor: '#f4f4f6', padding: 18, borderRadius: 16, alignItems: 'center' },
  buttonText: { color: '#09090c', fontWeight: '800' },
  secondary: { borderColor: '#444450', borderWidth: 1, borderRadius: 16, padding: 15, alignItems: 'center' },
  light: { color: '#fff', fontWeight: '700' },
  guard: { color: '#d6b787', lineHeight: 21, paddingTop: 4 }
});
