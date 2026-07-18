// Cheap, offline-safe phrasing detectors shared by the router (server/chat.js) and the LLM intent
// classifier's heuristic fallback. "what's next?", "what should I do", "any ideas?" → the user is
// ASKING for a suggestion (a question that routes to /whatdo), never a task to file. A trailing "today"
// ("what's next today", "what should I do today") is stripped here so it still reads as a suggest request;
// the router separately notices the "today" word and scopes the suggestion to tasks due today.
export function isSuggestRequest(text) {
  const s = (text || '').toLowerCase().replace(/[?!.\s]+$/, '').trim().replace(/\s+(?:for\s+)?today$/, '').trim();
  return [
    /^what('?s| is)? next$/, /^what now$/, /^what to do( next| now)?$/,
    /^what should i (do|work on|tackle)( next| now)?$/,
    /^what (should|can|do) i do( next| now)?$/,
    /^any (suggestions?|ideas?)$/, /^suggest( me)?( a| something| a task)?$/,
    /^i'?m bored$/, /^help me (pick|choose|decide)( something)?$/,
  ].some((re) => re.test(s));
}
