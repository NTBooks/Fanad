// Feature-module roster. Import order here IS the registry's match order (see registry.js) — keep the
// cheap/narrow matchers first. chat.js imports this once; each module registers itself as a side effect.
import './manual.js';
import './timer.js';
import './metrics.js';
import './diet.js';
import './journal.js';
import './batches.js';
import './homeassistant.js';
