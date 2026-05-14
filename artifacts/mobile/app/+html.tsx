import { ScrollViewStyleReset } from "expo-router/html";
import type { PropsWithChildren } from "react";

export default function Root({ children }: PropsWithChildren) {
  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <meta httpEquiv="X-UA-Compatible" content="IE=edge" />
        <meta
          name="viewport"
          content="width=device-width, initial-scale=1, shrink-to-fit=no"
        />
        <meta
          name="description"
          content="Ashley-Sidecar is a personal AI companion mobile app: local-first profile and memory, real-time streaming chat, and AI-generated selfies."
        />
        <meta name="theme-color" content="#d97757" />
        <ScrollViewStyleReset />
      </head>
      <body>{children}</body>
    </html>
  );
}
