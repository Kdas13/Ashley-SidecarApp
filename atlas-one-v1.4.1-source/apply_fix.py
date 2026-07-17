from pathlib import Path
import sys

path = Path(sys.argv[1])
lines = path.read_text(encoding='utf-8').splitlines()

if any('function isArtifactAccessQuestion' in line for line in lines):
    raise SystemExit('artifact context fix already applied')

for i, line in enumerate(lines):
    if line.startswith('function makeMessage('):
        end = i
        while end < len(lines) and lines[end] != '}':
            end += 1
        insert_at = end + 1
        break
else:
    raise SystemExit('makeMessage not found')

helper = r'''

function latestArtifact(): Message | null {
  const row = db.getFirstSync<{
    id: string;
    role: Role;
    content: string;
    created_at: string;
    artifact_uri?: string | null;
    artifact_name?: string | null;
    artifact_mime?: string | null;
    artifact_kind?: ArtifactKind | null;
  }>(
    `SELECT id, role, content, created_at, artifact_uri, artifact_name, artifact_mime, artifact_kind
     FROM messages
     WHERE artifact_uri IS NOT NULL AND artifact_name IS NOT NULL
     ORDER BY created_at DESC
     LIMIT 1`,
  );
  if (!row) return null;
  return {
    id: row.id,
    role: row.role,
    content: row.content,
    createdAt: row.created_at,
    artifactUri: row.artifact_uri,
    artifactName: row.artifact_name,
    artifactMime: row.artifact_mime,
    artifactKind: row.artifact_kind,
  };
}

function isArtifactAccessQuestion(value: string) {
  const text = value.toLowerCase().replace(/[’]/g, "'");
  const asksAboutAccess = /\b(access|see|read|open|still have|still got|retain|remember|find|use|reuse|edit|change|refer to)\b/.test(text);
  const refersToArtifact = /\b(it|that|this|the file|the document|the image|file|document|image|copy)\b/.test(text);
  const asksForCreation = /\b(create|make|generate|recreate|another|new|send me|give me|downloadable|export|save as)\b/.test(text);
  return asksAboutAccess && refersToArtifact && !asksForCreation;
}

function artifactAccessReply(item: Message | null) {
  if (!item?.artifactUri || !item.artifactName) {
    return 'I do not currently have a tracked working copy in this app. Upload the file and I can inspect it.';
  }
  let exists = false;
  try {
    exists = new File(item.artifactUri).exists;
  } catch {
    exists = false;
  }
  if (!exists) {
    return `I remember creating ${item.artifactName}, but the app-private working copy is no longer present. Upload your saved copy and I can continue from it.`;
  }
  return `Yes. I still have access to my app-private working copy of ${item.artifactName}, so I can read, revise, convert or reuse it here. I do not automatically have access to the separate copy you downloaded into an Android folder; upload that exported copy if you want me to inspect that exact file.`;
}'''.splitlines()
lines[insert_at:insert_at] = helper

for i, line in enumerate(lines):
    if line.startswith('- When Kane asks for a downloadable TXT'):
        lines.insert(
            i + 1,
            '- A follow-up asking whether you can access, see, read, reuse or edit an existing file is NOT a creation request. Do not call create_document again. Answer about the existing tracked artifact and distinguish the app-private working copy from the exported Android copy.',
        )
        break
else:
    raise SystemExit('file-tool instruction not found')

for i, line in enumerate(lines):
    if line.strip().startswith('const wantsDocument = /'):
        if i + 1 >= len(lines) or '|| /\\b(txt|pdf|docx' not in lines[i + 1]:
            raise SystemExit('unexpected document classifier shape')
        lines[i:i + 2] = [
            '  const wantsDocument = !isArtifactAccessQuestion(latestText)',
            r'    && /\b(downloadable|download|export|save as|create|make|generate|send me|give me)\b[\s\S]{0,100}\b(txt|text file|markdown|md|pdf|docx|word document|document|file|csv|json|html)\b/i.test(latestText);',
        ]
        break
else:
    raise SystemExit('document classifier not found')

for i, line in enumerate(lines):
    if line.strip().startswith('const fallback = artifacts.length'):
        end = i
        while end < len(lines) and 'return { text:' not in lines[end]:
            end += 1
        if end >= len(lines):
            raise SystemExit('document response return not found')
        lines[i:end + 1] = [
            '    const cleanText = result.text.trim();',
            r"    const normalizedText = cleanText.toLowerCase().replace(/\s+/g, ' ');",
            '    const duplicatesArtifactCaption = artifacts.some((artifact) => {',
            r"      const caption = artifact.caption.toLowerCase().replace(/\s+/g, ' ');",
            '      return Boolean(normalizedText) && (normalizedText === caption || normalizedText.includes(caption) || caption.includes(normalizedText));',
            '    });',
            '    const responseText = cleanText && !duplicatesArtifactCaption',
            '      ? `${cleanText}${sourceText}`',
            '      : sourceText.trim();',
            '    return { text: responseText, artifacts };',
        ]
        break
else:
    raise SystemExit('duplicate artifact fallback not found')

for i, line in enumerate(lines):
    if line.strip() == "if (settings.mode === 'standalone') {" and i > 700:
        lines[i:i] = [
            "      if (settings.mode === 'standalone' && !attachment && isArtifactAccessQuestion(outgoing)) {",
            "        append(makeMessage('assistant', artifactAccessReply(latestArtifact())));",
            '        return;',
            '      }',
        ]
        break
else:
    raise SystemExit('standalone send branch not found')

path.write_text('\n'.join(lines) + '\n', encoding='utf-8')
