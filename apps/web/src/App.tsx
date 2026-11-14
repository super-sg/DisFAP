import { useCallback, useEffect, useMemo, useState, type JSX } from 'react';
import { ApiClient, isConnectable } from './api/client.js';
import { AuthGate } from './auth/AuthGate.js';
import {
  DEMO_IDENTITIES,
  DemoIdentityGate,
  demoAuthEnabled,
  demoRoleFromSearch,
  type DemoRole,
} from './auth/DemoIdentityGate.js';
import { createOidcAuth, type OidcAuth } from './auth/OidcAuth.js';
import { oidcSettingsFromEnv, type EnvRecord } from './auth/oidc-settings.js';
import { ApplicationShell } from './components/ApplicationShell.js';
import type { NavPage } from './components/Sidebar.js';
import { LandingPage } from './pages/LandingPage.js';
import { DashboardPage } from './pages/DashboardPage.js';
import { SessionsPage } from './pages/SessionsPage.js';
import { ActivityPage } from './pages/ActivityPage.js';
import { SecurityPage } from './pages/SecurityPage.js';
import { LaunchPage, type LaunchResult } from './session/LaunchPage.js';
import { SessionView } from './session/SessionView.js';

type AppPage = NavPage | 'session';

function hashToPage(hash: string): AppPage {
  switch (hash) {
    case '#/dashboard': return 'dashboard';
    case '#/workspaces': return 'workspaces';
    case '#/owner': return 'owner';
    case '#/list-software': return 'list-software';
    case '#/sessions': return 'sessions';
    case '#/activity': return 'activity';
    case '#/security': return 'security';
    default: return 'landing';
  }
}

type AuthStatus = 'loading' | 'authenticated' | 'unauthenticated';

/**
 * Top-level shell for DisFAP.
 * Routes between the landing page, dashboard, marketplace, owner console,
 * active sessions, activity history, security posture, and live remote desktop.
 */
export function App(): JSX.Element {
  // Built once. `null` means "no frontend OIDC configured" (local dev).
  const oidc = useMemo<OidcAuth | null>(() => {
    const settings = oidcSettingsFromEnv(import.meta.env as unknown as EnvRecord, window.location.origin);
    return settings ? createOidcAuth(settings) : null;
  }, []);

  const demoEnabled = demoAuthEnabled(import.meta.env, window.location);
  const [demoRole, setDemoRole] = useState<DemoRole | null>(() =>
    demoEnabled ? demoRoleFromSearch(window.location.search) : null,
  );

  const api = useMemo(() => {
    const identity = !oidc && demoRole ? DEMO_IDENTITIES[demoRole] : null;
    return new ApiClient({
      ...(oidc ? { getAccessToken: () => oidc.getAccessToken() } : {}),
      ...(identity ? { devIdentity: { userId: identity.userId, orgId: identity.orgId } } : {}),
    });
  }, [oidc, demoRole]);

  const chooseDemoRole = useCallback((role: DemoRole) => {
    const url = new URL(window.location.href);
    url.searchParams.set('as', role);
    window.history.replaceState(null, '', url);
    setDemoRole(role);
  }, []);

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
    void oidc.signin();
  }, [oidc]);

  const handleSignOut = useCallback(() => {
    if (!oidc) return;
    void oidc.signout().then(() => setAuthStatus('unauthenticated'));
  }, [oidc]);

  const [page, setPage] = useState<AppPage>(() => hashToPage(window.location.hash));
  const [active, setActive] = useState<LaunchResult | null>(null);
  const [resumeError, setResumeError] = useState<string | null>(null);

  const switchDemoRole = useCallback(() => {
    const url = new URL(window.location.href);
    url.searchParams.delete('as');
    window.history.replaceState(null, '', url);
    setDemoRole(null);
    setActive(null);
    setPage('landing');
  }, []);

  // Resume an ALREADY-RUNNING session from the URL (`#/session/<id>`).
  useEffect(() => {
    const match = /^#\/session\/([A-Za-z0-9_-]+)$/.exec(window.location.hash);
    if (!match || active) return;
    const sessionId = match[1];
    if (!sessionId) return;
    let cancelled = false;
    void (async () => {
      try {
        const info = await api.getSession(sessionId);
        if (cancelled) return;
        if (isConnectable(info.state) && info.connect) {
          setActive({
            session: info,
            template: {
              id: info.templateId,
              name: 'Resumed session',
              os: 'linux',
              recording: info.recording,
            },
            connect: info.connect,
          });
          setPage('session');
        } else {
          setResumeError(`Session ${sessionId} is "${info.state}" and cannot be opened.`);
        }
      } catch (err: unknown) {
        if (!cancelled) setResumeError(err instanceof Error ? err.message : 'Failed to resume session');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [api, active]);

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

  // Local-evaluation sign-in
  if (!oidc && demoEnabled && !demoRole) {
    return <DemoIdentityGate onSelect={chooseDemoRole} />;
  }

  // Unauthenticated OIDC
  if (oidc && authStatus !== 'authenticated') {
    return <AuthGate error={authError} pending={signingIn || authStatus === 'loading'} onSignIn={handleSignIn} />;
  }

  const currentDemo = demoRole ? DEMO_IDENTITIES[demoRole] : null;
  // Role is authoritative in the API, but the current OIDC client exposes no
  // role claim endpoint. Keep the UI least-privileged until one is available.
  const isOwner = currentDemo ? currentDemo.role === 'owner' : false;

  const authProps: { onSignOut?: () => void; userLabel?: string; onSwitchUser?: () => void } = {};
  if (oidc) {
    authProps.onSignOut = handleSignOut;
    const label = oidc.displayName();
    if (label) authProps.userLabel = label;
  } else if (currentDemo) {
    authProps.userLabel = `${currentDemo.label} · ${currentDemo.role}`;
    authProps.onSwitchUser = switchDemoRole;
  }

  const isSession = page === 'session' && active;

  if (isSession) {
    return <SessionView api={api} initial={active} onExit={handleExit} />;
  }

  return (
    <ApplicationShell
      current={page === 'session' ? 'workspaces' : page}
      onNavigate={navigate}
      isOwner={isOwner}
      {...(authProps.userLabel ? { userLabel: authProps.userLabel } : {})}
      {...(authProps.onSignOut ? { onSignOut: authProps.onSignOut } : {})}
      {...(authProps.onSwitchUser ? { onSwitchUser: authProps.onSwitchUser } : {})}
    >
      {resumeError && (
        <div
          role="alert"
          style={{
            margin: '0 0 1.5rem',
            padding: '0.75rem 1rem',
            background: 'rgba(239, 68, 68, 0.1)',
            border: '1px solid rgba(239, 68, 68, 0.25)',
            borderRadius: 6,
            color: '#f87171',
            fontSize: '0.84375rem',
          }}
        >
          {resumeError}
        </div>
      )}

      {page === 'dashboard' ? (
        <DashboardPage api={api} isOwner={isOwner} onNavigate={() => navigate('workspaces')} />
      ) : page === 'workspaces' ? (
        <LaunchPage api={api} isOwner={isOwner} onReady={handleReady} />
      ) : page === 'owner' ? (
        <DashboardPage api={api} isOwner={isOwner} onNavigate={() => navigate('workspaces')} />
      ) : page === 'list-software' ? (
        <LaunchPage api={api} isOwner={isOwner} initialTab="owner" onReady={handleReady} />
      ) : page === 'sessions' ? (
        <SessionsPage
          api={api}
          activeSession={active}
          onOpenSession={() => setPage('session')}
          onNavigate={() => navigate('workspaces')}
          onSessionEnded={() => {
            setActive(null);
            navigate('workspaces');
          }}
        />
      ) : page === 'activity' ? (
        <ActivityPage api={api} isOwner={isOwner} />
      ) : page === 'security' ? (
        <SecurityPage />
      ) : (
        <LandingPage onNavigate={(target) => navigate(target)} />
      )}
    </ApplicationShell>
  );
}
