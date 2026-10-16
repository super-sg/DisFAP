import { useCallback, useEffect, useMemo, useState, type JSX } from 'react';
import { ApiClient } from './api/client.js';
import { AuthGate } from './auth/AuthGate.js';
import { createOidcAuth, type OidcAuth } from './auth/OidcAuth.js';
import { oidcSettingsFromEnv, type EnvRecord } from './auth/oidc-settings.js';
import { Navbar, type NavPage, type NavbarProps } from './components/Navbar.js';
import { LandingPage } from './pages/LandingPage.js';
import { DashboardPage } from './pages/DashboardPage.js';
import { LaunchPage, type LaunchResult } from './session/LaunchPage.js';
import { SessionView } from './session/SessionView.js';

type AppPage = NavPage | 'session';

function hashToPage(hash: string): AppPage {
  switch (hash) {
    case '#/dashboard': return 'dashboard';
    case '#/workspaces': return 'workspaces';
    default: return 'landing';
  }
}

type AuthStatus = 'loading' | 'authenticated' | 'unauthenticated';

/**
 * Top-level shell. Routes between the landing page, dashboard, workspace
 * launcher, and a live session. The control-plane client is created once.
 *
 * When OIDC is configured (VITE_OIDC_ISSUER + VITE_OIDC_CLIENT_ID) the app
 * processes the login callback, gates the UI behind authentication, and attaches
 * the verified-at-the-API access token to every request. When OIDC is not
 * configured the app runs without frontend login (local development only).
 */
export function App(): JSX.Element {
  // Built once. `null` means "no frontend OIDC configured" (local dev).
  const oidc = useMemo<OidcAuth | null>(() => {
    const settings = oidcSettingsFromEnv(import.meta.env as unknown as EnvRecord, window.location.origin);
    return settings ? createOidcAuth(settings) : null;
  }, []);

  const api = useMemo(
    () => new ApiClient(oidc ? { getAccessToken: () => oidc.getAccessToken() } : {}),
    [oidc],
  );

  const [authStatus, setAuthStatus] = useState<AuthStatus>(oidc ? 'loading' : 'authenticated');
  const [authError, setAuthError] = useState<string | null>(null);
  const [signingIn, setSigningIn] = useState(false);

  useEffect(() => {
    if (!oidc) return;
    let cancelled = false;
    void oidc.init().then(() => {
      if (cancelled) return;
      setAuthError(oidc.error());
      setAuthStatus(oidc.isAuthenticated() ? 'authenticated' : 'unauthenticated');
    });
    return () => {
      cancelled = true;
    };
  }, [oidc]);

  const handleSignIn = useCallback(() => {
    if (!oidc) return;
    setSigningIn(true);
    setAuthError(null);
    // Navigates to the provider; on return the callback is processed by init().
    void oidc.signin();
  }, [oidc]);

  const handleSignOut = useCallback(() => {
    if (!oidc) return;
    void oidc.signout().then(() => setAuthStatus('unauthenticated'));
  }, [oidc]);

  const [page, setPage] = useState<AppPage>(() => hashToPage(window.location.hash));
  const [active, setActive] = useState<LaunchResult | null>(null);

  // Sync hash → state
  useEffect(() => {
    const handler = () => {
      if (!active) setPage(hashToPage(window.location.hash));
    };
    window.addEventListener('hashchange', handler);
    return () => window.removeEventListener('hashchange', handler);
  }, [active]);

  const navigate = useCallback((p: NavPage) => {
    window.location.hash = p === 'landing' ? '#/' : `#/${p}`;
    setPage(p);
  }, []);

  const handleReady = useCallback((result: LaunchResult) => {
    setActive(result);
    setPage('session');
  }, []);

  const handleExit = useCallback(() => {
    setActive(null);
    navigate('workspaces');
  }, [navigate]);

  // Unauthenticated (or mid-callback) with OIDC configured: never render the app.
  if (oidc && authStatus !== 'authenticated') {
    return <AuthGate error={authError} pending={signingIn || authStatus === 'loading'} onSignIn={handleSignIn} />;
  }

  const navbarAuth: Pick<NavbarProps, 'onSignOut' | 'userLabel'> = {};
  if (oidc) {
    navbarAuth.onSignOut = handleSignOut;
    const label = oidc.displayName();
    if (label) navbarAuth.userLabel = label;
  }

  const isSession = page === 'session' && active;

  return (
    <>
      <Navbar
        current={page === 'session' ? 'workspaces' : page}
        onNavigate={navigate}
        sessionActive={!!isSession}
        {...navbarAuth}
      />
      {isSession ? (
        <SessionView api={api} initial={active} onExit={handleExit} />
      ) : page === 'dashboard' ? (
        <DashboardPage onNavigate={navigate} />
      ) : page === 'workspaces' ? (
        <LaunchPage api={api} onReady={handleReady} />
      ) : (
        <LandingPage onNavigate={navigate} />
      )}
    </>
  );
}
