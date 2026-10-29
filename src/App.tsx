import { useEffect, useState } from 'react';
import { Brain, ListOrdered, Settings2 } from 'lucide-react';
import { useGame } from './game/store';
import { flushSettingsSave, onSettingsSaveError, useSettings } from './settings';
import { SetupEditor } from './components/SetupEditor';
import { BoardArea } from './components/BoardArea';
import { TopBar } from './components/TopBar';
import { AiPanel } from './components/panels/AiPanel';
import { GamePanel } from './components/panels/GamePanel';
import { NewGameDialog } from './components/panels/NewGameDialog';
import { SettingsPanel } from './components/panels/SettingsPanel';
import { ToastHost } from './components/ui/Toast';

type Tab = 'game' | 'ai' | 'settings';

/** True for widgets that own their own keyboard handling. */
function ownsKeyboard(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  const tag = target.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || tag === 'BUTTON';
}

export function App() {
  const mode = useGame((s) => s.mode);
  const setupDraft = useGame((s) => s.setupDraft);
  const aiTurn = useGame((s) => s.aiTurn);
  const thinking = useGame((s) => s.thinking);
  const notify = useGame((s) => s.notify);
  const ui = useSettings((s) => s.settings.ui);
  const settings = useSettings((s) => s.settings);
  const loadSettings = useSettings((s) => s.loadSettings);
  const loaded = useSettings((s) => s.loaded);
  const loadError = useSettings((s) => s.loadError);
  const [tab, setTab] = useState<Tab>('game');
  const [newGameOpen, setNewGameOpen] = useState(false);

  useEffect(() => {
    void loadSettings();
  }, [loadSettings]);

  useEffect(() => {
    if (loadError) {
      notify(`读取设置失败，已使用默认配置：${loadError}`, 'error');
    }
  }, [loadError, notify]);

  useEffect(() => {
    onSettingsSaveError((message) => notify(message, 'error'));
    return () => onSettingsSaveError(null);
  }, [notify]);

  useEffect(() => {
    window.addEventListener('beforeunload', flushSettingsSave);
    return () => window.removeEventListener('beforeunload', flushSettingsSave);
  }, []);

  useEffect(() => {
    document.documentElement.dataset.theme = ui.theme;
  }, [ui.theme]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      // Any open dialog owns the keyboard, and so do form widgets.
      if (newGameOpen || mode === 'setup') return;
      if (ownsKeyboard(event.target)) return;
      if (event.ctrlKey || event.metaKey || event.altKey) return;
      const game = useGame.getState();
      if (event.key === 'f') game.flip();
      if (event.key === 'u') game.undo();
      if (event.key === ' ') {
        event.preventDefault();
        game.togglePause();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [newGameOpen, mode]);

  // Restore the saved side preference without starting a game behind the user's back.
  const [booted, setBooted] = useState(false);
  useEffect(() => {
    if (!loaded || booted) return;
    setBooted(true);
    useGame.setState({
      players: settings.players,
      orientation: settings.orientation,
    });
  }, [loaded, booted, settings.players, settings.orientation]);

  const attemptCount = aiTurn?.attempts.length ?? 0;

  // Wait for the persisted settings before rendering anything that could write
  // to them: the defaults in memory would otherwise overwrite the saved file.
  if (!loaded) {
    return <div className="app-loading">正在载入设置…</div>;
  }

  return (
    <div className="app">
      <TopBar
        onNewGame={() => setNewGameOpen(true)}
        onOpenSettings={() => setTab('settings')}
      />

      <div className="layout">
        <div className="board-column">
          <BoardArea />
          {mode === 'setup' && setupDraft && <SetupEditor />}
        </div>

        <aside className="side-column">
          <div className="tabs">
            <button
              type="button"
              className="tab"
              data-active={tab === 'game'}
              onClick={() => setTab('game')}
            >
              <ListOrdered size={14} /> 对局
            </button>
            <button
              type="button"
              className="tab"
              data-active={tab === 'ai'}
              onClick={() => setTab('ai')}
            >
              <Brain size={14} /> AI 思考
              {thinking && <span className="tab-badge">…</span>}
              {!thinking && attemptCount > 0 && <span className="tab-badge">{attemptCount}</span>}
            </button>
            <button
              type="button"
              className="tab"
              data-active={tab === 'settings'}
              onClick={() => setTab('settings')}
            >
              <Settings2 size={14} /> 设置
            </button>
          </div>
          <div className="panel-body">
            {tab === 'game' && <GamePanel />}
            {tab === 'ai' && <AiPanel />}
            {tab === 'settings' && <SettingsPanel />}
          </div>
        </aside>
      </div>

      <NewGameDialog open={newGameOpen} onClose={() => setNewGameOpen(false)} />
      <ToastHost />
    </div>
  );
}
