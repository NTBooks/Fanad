// The Appearance (theme) picker, shared between the owner Settings panel and the non-owner
// UserConfig panel — the theme is a per-browser preference, so every signed-in user gets to set it.
export default function ThemeSection({ theme = 'auto', onTheme = () => {} }) {
  return (
    <div className="tg-section">
      <h3>Appearance</h3>
      <p className="hint">Fanad eases into soothing night colors after dark on its own. Override it here. Ocean is a dressed-up theme — a retro-pixel sea that follows your clock: bright lagoon water by day, golden at dusk, a moonlit sea with its reflection rippling on the waves at night. It animates, so Auto never picks it for you.</p>
      <div className="seg">
        {[['auto', 'Auto'], ['light', 'Light'], ['dark', 'Dark'], ['bokeh', '🌊 Ocean']].map(([t, label]) => (
          <button key={t} type="button" className={theme === t ? 'on' : ''} onClick={() => onTheme(t)}>{label}</button>
        ))}
      </div>
    </div>
  );
}
