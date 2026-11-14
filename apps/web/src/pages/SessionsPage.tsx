import { useState, type JSX } from 'react';
import type { ApiClient } from '../api/client.js';
import type { LaunchResult } from '../session/launch-types.js';
import { Badge } from '../ui/Badge.js';
import { Button } from '../ui/Button.js';
import { EmptyState } from '../ui/EmptyState.js';
import { IconArrowRight, IconLaptop, IconRefresh, IconServer } from '../ui/Icons.js';
import styles from './SessionsPage.module.css';

export interface SessionsPageProps {
  api: ApiClient;
  activeSession: LaunchResult | null;
  onOpenSession: () => void;
  onNavigate: (page: 'workspaces') => void;
  onSessionEnded: () => void;
}

export function SessionsPage({
  api,
  activeSession,
  onOpenSession,
  onNavigate,
  onSessionEnded,
}: SessionsPageProps): JSX.Element {
  const [ending, setEnding] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleEnd = async () => {
    if (!activeSession) return;
    setEnding(true);
    setError(null);
    try {
      await api.endSession(activeSession.session.id);
      onSessionEnded();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Could not end this session.');
      setEnding(false);
    }
  };

  return (
    <div className={styles.page}>
      <header className={styles.header}>
        <h1 className={styles.title}>Active Sessions & Workspaces</h1>
        <p className={styles.subtitle}>
          Manage the remote desktop session launched in this browser. Your account’s full session history is not available through the current API.
        </p>
      </header>

      {activeSession ? (
        <div className={styles.grid}>
          {error && <p role="alert" className={styles.error}>{error}</p>}
          <div className={styles.sessionCard}>
            <div className={styles.sessionCardHeader}>
              <h3 className={styles.sessionCardTitle}>{activeSession.template.name}</h3>
              <Badge variant={activeSession.session.state === 'connected' ? 'success' : 'neutral'} dot>
                {activeSession.session.state.toUpperCase()}
              </Badge>
            </div>

            <div className={styles.metaList}>
              <div className={styles.metaRow}>
                <span>Session ID:</span>
                <span>{activeSession.session.id}</span>
              </div>
              <div className={styles.metaRow}>
                <span>Template:</span>
                <span>{activeSession.template.id}</span>
              </div>
              <div className={styles.metaRow}>
                <span>Protocol:</span>
                <span>xrdp (3389) via guacd</span>
              </div>
              <div className={styles.metaRow}>
                <span>Broker:</span>
                <span>{activeSession.connect.brokerUrl}</span>
              </div>
            </div>

            <div className={styles.actions}>
              <Button
                variant="primary"
                onClick={onOpenSession}
                iconRight={<IconArrowRight size={16} />}
              >
                Resume Remote Desktop
              </Button>
              <Button variant="danger" onClick={handleEnd} loading={ending}>
                End Session
              </Button>
            </div>
          </div>
        </div>
      ) : (
        <EmptyState
          icon={<IconLaptop size={24} />}
          title="No session open in this browser"
          description="Launch software from the marketplace to start a remote desktop session."
          action={
            <Button
              variant="primary"
              onClick={() => onNavigate('workspaces')}
              iconRight={<IconArrowRight size={16} />}
            >
              Browse Marketplace
            </Button>
          }
        />
      )}
    </div>
  );
}

