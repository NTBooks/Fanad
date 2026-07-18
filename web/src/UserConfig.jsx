import ModulesSection from './ModulesSection.jsx';
import ThemeSection from './ThemeSection.jsx';

// The non-owner config panel: the per-user module opt-ins plus the (per-browser) theme picker —
// none of the owner-gated sections (LLM, channels, security…), so it never trips a 403.
// Owners get the full Settings instead.
export default function UserConfig({ onClose, theme, onTheme }) {
  return (
    <div className="settings-overlay" onClick={onClose}>
      <div className="settings" onClick={(e) => e.stopPropagation()}>
        <div className="settings-head">
          <h2>Your modules</h2>
          <button className="x" onClick={onClose} aria-label="Close">✕</button>
        </div>
        <ModulesSection filterDisabled />
        <ThemeSection theme={theme} onTheme={onTheme} />
      </div>
    </div>
  );
}
