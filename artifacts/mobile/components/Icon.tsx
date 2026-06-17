import React from "react";
import { Text, type StyleProp, type TextStyle } from "react-native";

// Drop-in replacement for `<Feather>` from @expo/vector-icons that
// renders Unicode/emoji glyphs instead of relying on a TTF font being
// loaded. Kane's Android device kept rendering Feather glyphs as
// boxes-with-X no matter how many ways we tried to load the font
// (useFonts spread, Font.loadAsync in useEffect, module-level
// Font.loadAsync x2). The root cause was never confirmed but is most
// likely either pnpm symlink + Metro asset registry interaction, or
// Expo Go bundle caching on his phone. Using Unicode characters
// sidesteps the entire font-loading problem — these glyphs render with
// the system fallback font that's ALWAYS available.
//
// API matches Feather: <Icon name="x" size={16} color="#fff" />.

const ICON_MAP: Record<string, string> = {
  "alert-circle": "\u26A0\uFE0F", // ⚠️
  "arrow-right": "\u2192", // →
  "book-open": "\uD83D\uDCD6", // 📖
  bookmark: "\uD83D\uDD16", // 🔖
  camera: "\uD83D\uDCF7", // 📷
  check: "\u2713", // ✓
  "check-circle": "\u2713", // ✓ (no good circled-check Unicode that renders cross-platform)
  "chevron-down": "\u2304", // ⌄
  "chevron-left": "\u2039", // ‹
  "chevron-right": "\u203A", // ›
  "chevron-up": "\u2303", // ⌃
  clipboard: "\uD83D\uDCCB", // 📋
  copy: "\u29C9", // ⧉
  "corner-up-left": "\u21A9\uFE0F", // ↩️
  download: "\u2B07\uFE0F", // ⬇️
  "edit-2": "\u270E", // ✎
  "edit-3": "\u270E", // ✎
  image: "\uD83D\uDDBC\uFE0F", // 🖼️
  "message-circle": "\uD83D\uDCAC", // 💬
  mic: "\uD83C\uDFA4", // 🎤
  minus: "\u2212", // −
  "file-text": "\uD83D\uDCC4", // 📄
  paperclip: "\uD83D\uDCCE", // 📎
  phone: "\uD83D\uDCDE", // 📞
  play: "\u23F5", // ⏵ (BLACK MEDIUM RIGHT-POINTING TRIANGLE — Continue button; purpose-built media-play glyph, more universally available in Android font fallback than U+25B6)
  plus: "+",
  "refresh-cw": "\u21BB", // ↻
  send: "\u27A4", // ➤
  square: "\u23F9", // ⏹ (BLACK SQUARE FOR STOP — purpose-built media-stop glyph, more universally available in Android font fallback than U+25A0)
  settings: "\u2699\uFE0F", // ⚙️
  star: "\u2605", // ★
  "trash-2": "\uD83D\uDDD1\uFE0F", // 🗑️
  upload: "\u2B06\uFE0F", // ⬆️
  "upload-cloud": "\u2601\uFE0F", // ☁️
  "volume-2": "\uD83D\uDD0A", // 🔊
  "volume-x": "\uD83D\uDD07", // 🔇
  x: "\u2715", // ✕
};

interface IconProps {
  name: string;
  size?: number;
  color?: string;
  style?: StyleProp<TextStyle>;
}

export function Icon({
  name,
  size = 16,
  color,
  style,
}: IconProps): React.JSX.Element {
  const glyph = ICON_MAP[name] ?? "?";
  return (
    <Text
      allowFontScaling={false}
      style={[
        {
          fontSize: size,
          lineHeight: size * 1.15,
          color,
          textAlign: "center",
          includeFontPadding: false,
        },
        style,
      ]}
    >
      {glyph}
    </Text>
  );
}

// Re-export under the Feather name so existing call sites can swap
// imports without renaming JSX. (We do replace the JSX too in the
// codebase, but this lets stragglers keep compiling.)
export const Feather = Icon;
