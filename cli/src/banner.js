// The startup banner — rendered ONCE while the first history page loads (one tasteful
// reveal, never looping, reserved for boot). cfonts draws the block letters uncolored; gradient-string
// paints them magenta→cyan (the app's accent), line by line so the wrap math stays honest.
import cfonts from 'cfonts';
import gradientFactory from 'gradient-string';

const accent = gradientFactory(['#c026d3', '#22d3ee']);

// Returns the banner as an array of pre-colored lines (empty when the terminal is too narrow or colors
// are off — the caller falls back to a plain title).
export function bannerLines(width, colors = true) {
  try {
    const r = cfonts.render('FANAD', {
      font: width >= 60 ? 'block' : 'tiny',
      colors: ['white'],
      env: 'node',
      space: false,
      maxLength: 20,
    });
    if (!r || !r.string) return [];
    const lines = r.string.replace(/\x1b\[[0-9;]*m/g, '').split('\n'); // strip cfonts' own color, keep the shape
    if (Math.max(...lines.map((l) => l.length)) > width) return [];
    return colors ? lines.map((l) => accent(l)) : lines;
  } catch {
    return [];
  }
}
