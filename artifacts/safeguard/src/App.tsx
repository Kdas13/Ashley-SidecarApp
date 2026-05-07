import { Switch, Route, Router as WouterRouter, Redirect } from "wouter";
import { QueryClient, QueryClientProvider, useQuery } from "@tanstack/react-query";
import {
  ClerkProvider,
  SignedIn,
  SignedOut,
  useAuth,
} from "@clerk/clerk-react";
import { useEffect } from "react";
import "./i18n";
import { useApi, type SafeguardProfile } from "@/lib/api";
import Landing from "@/pages/Landing";
import Onboarding from "@/pages/Onboarding";
import Home from "@/pages/Home";
import CheckIn from "@/pages/CheckIn";
import Week from "@/pages/Week";

const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: 1, refetchOnWindowFocus: false } },
});

const PUBLISHABLE_KEY = import.meta.env.VITE_CLERK_PUBLISHABLE_KEY as
  | string
  | undefined;

function AppShell() {
  return (
    <Switch>
      <Route path="/">
        <SignedOut>
          <Landing />
        </SignedOut>
        <SignedIn>
          <Redirect to="/home" />
        </SignedIn>
      </Route>
      <Route path="/home">
        <SignedOut>
          <Redirect to="/" />
        </SignedOut>
        <SignedIn>
          <Authed>{(p) => <Home profile={p} />}</Authed>
        </SignedIn>
      </Route>
      <Route path="/onboarding">
        <SignedOut>
          <Redirect to="/" />
        </SignedOut>
        <SignedIn>
          <Authed allowMissingProfile>
            {(p) => <Onboarding initial={p} />}
          </Authed>
        </SignedIn>
      </Route>
      <Route path="/checkin">
        <SignedIn>
          <Authed>{(p) => <CheckIn profile={p} />}</Authed>
        </SignedIn>
        <SignedOut>
          <Redirect to="/" />
        </SignedOut>
      </Route>
      <Route path="/week">
        <SignedIn>
          <Authed>{() => <Week />}</Authed>
        </SignedIn>
        <SignedOut>
          <Redirect to="/" />
        </SignedOut>
      </Route>
    </Switch>
  );
}

function Authed({
  children,
  allowMissingProfile = false,
}: {
  children: (profile: SafeguardProfile) => React.ReactNode;
  allowMissingProfile?: boolean;
}) {
  const { isLoaded, isSignedIn } = useAuth();
  const { request } = useApi();
  const profileQ = useQuery({
    queryKey: ["profile"],
    enabled: isLoaded && !!isSignedIn,
    queryFn: () =>
      request<{ profile: SafeguardProfile | null }>("/me/profile"),
  });

  // Apply accessibility prefs from server profile when it loads.
  useEffect(() => {
    const p = profileQ.data?.profile;
    if (!p) return;
    document.documentElement.classList.toggle(
      "large-text",
      p.accessibilityLargeText,
    );
    document.documentElement.classList.toggle(
      "high-contrast",
      p.accessibilityHighContrast,
    );
  }, [profileQ.data?.profile]);

  if (!isLoaded || profileQ.isLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center text-muted-foreground">
        …
      </div>
    );
  }
  if (profileQ.isError) {
    return (
      <div className="min-h-screen flex items-center justify-center p-6 text-center text-destructive">
        {(profileQ.error as Error).message}
      </div>
    );
  }
  const profile = profileQ.data?.profile ?? null;
  if (!profile && !allowMissingProfile) {
    return <Redirect to="/onboarding" />;
  }
  return <>{children((profile ?? null) as SafeguardProfile)}</>;
}

function App() {
  if (!PUBLISHABLE_KEY) {
    return (
      <div className="min-h-screen flex items-center justify-center p-6 text-center">
        <div>
          <h1 className="text-xl font-semibold">Safeguard</h1>
          <p className="mt-2 text-sm text-muted-foreground">
            VITE_CLERK_PUBLISHABLE_KEY is not set.
          </p>
        </div>
      </div>
    );
  }
  return (
    <ClerkProvider publishableKey={PUBLISHABLE_KEY}>
      <QueryClientProvider client={queryClient}>
        <WouterRouter base={import.meta.env.BASE_URL.replace(/\/$/, "")}>
          <AppShell />
        </WouterRouter>
      </QueryClientProvider>
    </ClerkProvider>
  );
}

export default App;
