import * as DocumentPicker from 'expo-document-picker';
import { Image } from 'expo-image';
import { useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  KeyboardAvoidingView,
  Pressable,
  Text,
  TextInput,
  View,
} from 'react-native';

import { Button, Card, palette } from '@/components/ui';
import { atlasApi, ApiError } from '@/lib/api';
import { chatStore } from '@/lib/chat-store';
import { connectionStore } from '@/lib/connection';
import { useConnection } from '@/providers/connection-provider';
import type { ChatMessage, ChatResult, Interruption } from '@/types/api';

const makeMessage = (
  role: ChatMessage['role'],
  content: string,
  extra: Partial<ChatMessage> = {},
): ChatMessage => ({
  id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
  role,
  content,
  createdAt: new Date().toISOString(),
  ...extra,
});

export default function ChatScreen() {
  const { connection, ready } = useConnection();
  const [messages, setMessages] = useState<ChatMessage[]>(() => chatStore.list());
  const [text, setText] = useState('');
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [pending, setPending] = useState<{ id: string; interruptions: Interruption[] } | null>(null);
  const [busy, setBusy] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [generatingImage, setGeneratingImage] = useState(false);
  const listRef = useRef<FlatList<ChatMessage>>(null);

  useEffect(() => {
    connectionStore.getConversationId().then(setConversationId);
  }, []);

  const append = (...items: ChatMessage[]) => {
    items.forEach(chatStore.add);
    setMessages((current) => [...current, ...items]);
    requestAnimationFrame(() => listRef.current?.scrollToEnd({ animated: true }));
  };

  const applyResult = async (result: ChatResult) => {
    setConversationId(result.conversation_id);
    await connectionStore.setConversationId(result.conversation_id);
    if (result.status === 'completed') {
      setPending(null);
      append(makeMessage('assistant', result.reply || 'Action completed.'));
    } else {
      setPending({ id: result.pending_id, interruptions: result.interruptions });
      append(makeMessage('system', 'Approval required before Atlas One can perform this action.'));
    }
  };

  const send = async (override?: string) => {
    const outgoing = (override ?? text).trim();
    if (!outgoing || busy) return;
    if (!override) setText('');
    append(makeMessage('user', outgoing));
    setBusy(true);
    try {
      await applyResult(await atlasApi.chat(connection, outgoing, conversationId));
    } catch (error) {
      append(makeMessage('system', error instanceof ApiError ? error.message : 'The request failed.'));
    } finally {
      setBusy(false);
    }
  };

  const generateImage = async () => {
    const prompt = text.trim();
    if (!prompt || busy || generatingImage) return;
    setText('');
    append(makeMessage('user', `Generate image: ${prompt}`));
    setGeneratingImage(true);
    try {
      const result = await atlasApi.generateImage(connection, prompt, 'square');
      append(
        makeMessage('assistant', `Generated image via ${result.provider}.`, {
          imageUrl: atlasApi.fileUrl(connection, result.content_url),
          fileName: result.path,
          mimeType: 'image/png',
        }),
      );
    } catch (error) {
      append(makeMessage('system', error instanceof Error ? error.message : 'Image generation failed.'));
    } finally {
      setGeneratingImage(false);
    }
  };

  const decide = async (approve: boolean) => {
    if (!pending || busy) return;
    setBusy(true);
    try {
      append(makeMessage('system', approve ? 'Action approved.' : 'Action rejected.'));
      await applyResult(await atlasApi.approval(connection, pending.id, approve));
    } catch (error) {
      append(makeMessage('system', error instanceof Error ? error.message : 'Approval failed.'));
    } finally {
      setBusy(false);
    }
  };

  const upload = async () => {
    if (uploading) return;
    const selection = await DocumentPicker.getDocumentAsync({ copyToCacheDirectory: true, multiple: false });
    if (selection.canceled) return;
    const asset = selection.assets[0];
    const isImage = Boolean(asset.mimeType?.startsWith('image/'));
    if (isImage) {
      append(
        makeMessage('user', `Sent image: ${asset.name}`, {
          imageUri: asset.uri,
          fileName: asset.name,
          mimeType: asset.mimeType || 'image/*',
        }),
      );
    }
    setUploading(true);
    try {
      const result = await atlasApi.upload(connection, asset.uri, asset.name, asset.mimeType);
      if (!isImage) {
        append(makeMessage('system', `Uploaded ${result.item.original_name}.`));
      } else {
        append(
          makeMessage(
            'assistant',
            result.vision_summary
              ? `Image received and analysed.\n\n${result.vision_summary}`
              : `Image received: ${result.item.original_name}.`,
          ),
        );
      }
      await send(
        `A file was uploaded into my private workspace at "${result.item.stored_path}". ` +
          `Inspect it when relevant to this request.${result.vision_summary ? ' The image already has a vision summary attached.' : ''}`,
      );
    } catch (error) {
      append(makeMessage('system', error instanceof Error ? error.message : 'Upload failed.'));
    } finally {
      setUploading(false);
    }
  };

  const clearConversation = async () => {
    chatStore.clear();
    await connectionStore.clearConversationId();
    setMessages([]);
    setConversationId(null);
    setPending(null);
  };

  return (
    <KeyboardAvoidingView
      behavior={process.env.EXPO_OS === 'ios' ? 'padding' : undefined}
      style={{ flex: 1, backgroundColor: palette.background }}>
      <FlatList
        ref={listRef}
        data={messages}
        keyExtractor={(item) => item.id}
        contentInsetAdjustmentBehavior="automatic"
        contentContainerStyle={{ padding: 16, paddingTop: 24, paddingBottom: 180, gap: 12 }}
        ListHeaderComponent={
          <View style={{ gap: 16, paddingBottom: 14 }}>
            <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
                <View
                  style={{
                    width: 44,
                    height: 44,
                    borderRadius: 22,
                    alignItems: 'center',
                    justifyContent: 'center',
                    backgroundColor: '#1c1938',
                    borderWidth: 1,
                    borderColor: palette.accent,
                  }}>
                  <Text style={{ color: palette.text, fontSize: 20, fontWeight: '900' }}>A</Text>
                </View>
                <View>
                  <Text selectable style={{ color: palette.text, fontSize: 25, fontWeight: '900', letterSpacing: -0.6 }}>
                    Atlas One
                  </Text>
                  <Text selectable style={{ color: ready && connection.apiKey ? palette.accent2 : palette.warning, fontSize: 12, fontWeight: '700' }}>
                    {ready && connection.apiKey ? 'CHAT + IMAGE READY' : 'CONNECTION REQUIRED'}
                  </Text>
                </View>
              </View>
              <Pressable onPress={clearConversation} hitSlop={12}>
                <Text style={{ color: palette.muted, fontWeight: '700' }}>New thread</Text>
              </Pressable>
            </View>
            {messages.length === 0 ? (
              <Card style={{ backgroundColor: '#0d1220' }}>
                <Text selectable style={{ color: palette.text, fontSize: 19, fontWeight: '800' }}>Give me the objective.</Text>
                <Text selectable style={{ color: palette.muted, lineHeight: 21 }}>
                  Chat normally, tap + to upload a file or image, or type an image prompt and tap the image button to generate.
                </Text>
              </Card>
            ) : null}
          </View>
        }
        renderItem={({ item }) => {
          const remoteSource = item.imageUrl ? { uri: item.imageUrl, headers: { 'X-API-Key': connection.apiKey } } : null;
          const localSource = item.imageUri ? { uri: item.imageUri } : null;
          return (
            <View
              style={{
                maxWidth: '91%',
                alignSelf: item.role === 'user' ? 'flex-end' : 'flex-start',
                backgroundColor:
                  item.role === 'user' ? '#332d69' : item.role === 'system' ? '#251e12' : palette.panel,
                borderWidth: 1,
                borderColor:
                  item.role === 'user' ? '#6558c7' : item.role === 'system' ? '#614a1f' : palette.border,
                paddingHorizontal: 16,
                paddingVertical: 13,
                borderRadius: 20,
                borderBottomRightRadius: item.role === 'user' ? 5 : 20,
                borderBottomLeftRadius: item.role === 'assistant' ? 5 : 20,
              }}>
              {remoteSource || localSource ? (
                <Image
                  source={remoteSource || localSource!}
                  contentFit="cover"
                  style={{ width: 250, height: 250, borderRadius: 14, marginBottom: item.content ? 10 : 0 }}
                />
              ) : null}
              {item.content ? (
                <Text selectable style={{ color: palette.text, fontSize: 16, lineHeight: 23 }}>
                  {item.content}
                </Text>
              ) : null}
            </View>
          );
        }}
        ListFooterComponent={
          <View style={{ gap: 12, paddingTop: 12 }}>
            {busy || generatingImage ? <ActivityIndicator color={palette.accent} /> : null}
            {pending ? (
              <Card style={{ borderColor: palette.warning }}>
                <Text selectable style={{ color: palette.warning, fontWeight: '900', fontSize: 17 }}>Approval gate</Text>
                {pending.interruptions.map((item, index) => (
                  <Text key={`${item.tool_call_id}-${index}`} selectable style={{ color: palette.text, lineHeight: 21 }}>
                    {item.tool_name || 'Sensitive action'}
                    {item.arguments ? `\n${JSON.stringify(item.arguments, null, 2)}` : ''}
                  </Text>
                ))}
                <View style={{ flexDirection: 'row', gap: 10 }}>
                  <View style={{ flex: 1 }}><Button title="Reject" tone="danger" onPress={() => decide(false)} disabled={busy} /></View>
                  <View style={{ flex: 1 }}><Button title="Approve" onPress={() => decide(true)} disabled={busy} /></View>
                </View>
              </Card>
            ) : null}
          </View>
        }
      />

      <View
        style={{
          position: 'absolute',
          left: 12,
          right: 12,
          bottom: 92,
          borderRadius: 22,
          borderWidth: 1,
          borderColor: palette.border,
          backgroundColor: '#11151df2',
          padding: 10,
          flexDirection: 'row',
          alignItems: 'flex-end',
          gap: 8,
        }}>
        <Pressable
          accessibilityLabel="Upload file or image"
          onPress={upload}
          disabled={uploading || busy || generatingImage}
          style={({ pressed }) => ({
            width: 44,
            height: 44,
            borderRadius: 14,
            backgroundColor: palette.panelRaised,
            alignItems: 'center',
            justifyContent: 'center',
            opacity: pressed ? 0.65 : 1,
          })}>
          {uploading ? <ActivityIndicator color={palette.accent} /> : <Text style={{ color: palette.text, fontSize: 24 }}>+</Text>}
        </Pressable>
        <Pressable
          accessibilityLabel="Generate image"
          onPress={generateImage}
          disabled={!text.trim() || busy || generatingImage}
          style={({ pressed }) => ({
            width: 44,
            height: 44,
            borderRadius: 14,
            backgroundColor: palette.panelRaised,
            alignItems: 'center',
            justifyContent: 'center',
            opacity: pressed ? 0.65 : 1,
          })}>
          {generatingImage ? <ActivityIndicator color={palette.accent} /> : <Text style={{ color: palette.text, fontSize: 18 }}>🖼</Text>}
        </Pressable>
        <TextInput
          value={text}
          onChangeText={setText}
          placeholder="Message Atlas One…"
          placeholderTextColor={palette.muted}
          multiline
          maxLength={200000}
          style={{
            flex: 1,
            maxHeight: 130,
            minHeight: 44,
            color: palette.text,
            fontSize: 16,
            paddingHorizontal: 10,
            paddingVertical: 11,
          }}
        />
        <Pressable
          accessibilityLabel="Send"
          disabled={!text.trim() || busy || generatingImage}
          onPress={() => send()}
          style={({ pressed }) => ({
            width: 44,
            height: 44,
            borderRadius: 14,
            backgroundColor: !text.trim() || busy || generatingImage ? '#22283a' : '#24304b',
            alignItems: 'center',
            justifyContent: 'center',
            opacity: pressed ? 0.65 : 1,
          })}>
          <Text style={{ color: palette.text, fontSize: 22, fontWeight: '900' }}>↑</Text>
        </Pressable>
      </View>
    </KeyboardAvoidingView>
  );
}
