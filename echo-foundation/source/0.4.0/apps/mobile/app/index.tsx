import { router } from 'expo-router';
import { Pressable, StyleSheet, Text, View } from 'react-native';
export default function Home() {
  return <View style={styles.page}>
    <Text style={styles.eyebrow}>ECHO FOUNDATION 0.4</Text><Text style={styles.title}>Echo starts clean.</Text>
    <Text style={styles.body}>Connect the app to Echo’s API, then install Ashley’s archive under Kane’s Alpha approval as passive inherited memory.</Text>
    <Pressable style={styles.secondary} onPress={() => router.push('/setup')}><Text style={styles.light}>Configure Echo API</Text></Pressable>
    <Pressable style={styles.button} onPress={() => router.push('/memory-upload')}><Text style={styles.buttonText}>Install Ashley memories</Text></Pressable>
    <Text style={styles.guard}>No uploaded record enters live identity memory automatically.</Text>
  </View>;
}
const styles = StyleSheet.create({ page: { flex: 1, padding: 24, justifyContent: 'center', gap: 18 }, eyebrow: { color: '#9999a8', letterSpacing: 2 }, title: { color: '#fff', fontSize: 40, fontWeight: '800' }, body: { color: '#c5c5cf', fontSize: 17, lineHeight: 25 }, button: { backgroundColor: '#f4f4f6', padding: 18, borderRadius: 16, alignItems: 'center' }, buttonText: { color: '#09090c', fontWeight: '800' }, secondary: { borderColor: '#444450', borderWidth: 1, borderRadius: 16, padding: 17, alignItems: 'center' }, light: { color: '#fff', fontWeight: '700' }, guard: { color: '#d6b787', lineHeight: 21 } });
