import { useEffect, useState } from 'react';
import * as api from './api.js';
import { ViewToggle } from './ModulesPanel.jsx';

// The nestable outliner as one big tree. Each node can expand/collapse, be renamed inline, gain a child, or
// be deleted (with its whole subtree — the server cascades). Add a top-level list at the top. Text tab is the
// same tree as an indented outline.
export default function ListsTree() {
  const [tree, setTree] = useState(null);
  const [view, setView] = useState('gui');
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [collapsed, setCollapsed] = useState(() => new Set()); // expanded by default (a "big tree")
  const [rename, setRename] = useState(null);   // { id, text }
  const [adding, setAdding] = useState(null);    // { parentId|null, text }
  const [topText, setTopText] = useState('');

  const load = () => api.getListTree().then((r) => { setTree(r.tree); setError(null); }).catch((e) => setError(e.message));
  useEffect(() => { load(); }, []);

  async function act(fn) {
    if (busy) return; setBusy(true); setError(null);
    try { await fn(); await load(); } catch (e) { setError(e.message); } finally { setBusy(false); }
  }
  const toggle = (id) => setCollapsed((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const addTop = () => { const t = topText.trim(); if (!t) return; setTopText(''); act(() => api.createListItem(t, null)); };
  const submitAdd = () => {
    const t = (adding?.text || '').trim();
    if (t) act(() => api.createListItem(t, adding.parentId));
    setAdding(null);
  };
  const submitRename = () => {
    const t = (rename?.text || '').trim();
    if (t) act(() => api.renameListItem(rename.id, t));
    setRename(null);
  };

  const Node = ({ node, depth }) => {
    const kids = node.children || [];
    const open = !collapsed.has(node.id);
    return (
      <div className="tree-node" style={{ marginLeft: depth ? 16 : 0 }}>
        <div className="tree-row">
          <button className="tree-toggle" onClick={() => kids.length && toggle(node.id)} aria-hidden={!kids.length}>
            {kids.length ? (open ? '▾' : '▸') : '•'}
          </button>
          {rename && rename.id === node.id ? (
            <input
              autoFocus className="tree-edit" value={rename.text}
              onChange={(e) => setRename({ ...rename, text: e.target.value })}
              onBlur={submitRename}
              onKeyDown={(e) => { if (e.key === 'Enter') submitRename(); if (e.key === 'Escape') setRename(null); }}
            />
          ) : (
            <span className="tree-title" onDoubleClick={() => setRename({ id: node.id, text: node.title })}>{node.title}</span>
          )}
          {kids.length > 0 && <span className="n">{kids.length}</span>}
          <span className="tree-actions">
            <button className="link" title="Add sub-item" onClick={() => { setAdding({ parentId: node.id, text: '' }); setCollapsed((s) => { const n = new Set(s); n.delete(node.id); return n; }); }}>＋</button>
            <button className="link" title="Rename" onClick={() => setRename({ id: node.id, text: node.title })}>✎</button>
            <button className="link danger" title="Delete (with sub-items)" onClick={() => { if (window.confirm(`Delete “${node.title}”${kids.length ? ' and everything under it' : ''}?`)) act(() => api.deleteListItem(node.id)); }}>🗑</button>
          </span>
        </div>
        {adding && adding.parentId === node.id && (
          <form className="add-row tree-add" style={{ marginLeft: 16 }} onSubmit={(e) => { e.preventDefault(); submitAdd(); }}>
            <input autoFocus value={adding.text} placeholder="New sub-item…" onChange={(e) => setAdding({ ...adding, text: e.target.value })} onBlur={submitAdd} />
          </form>
        )}
        {open && kids.map((k) => <Node key={k.id} node={k} depth={depth + 1} />)}
      </div>
    );
  };

  const outline = (nodes, depth = 0) => nodes.map((n) => `${'  '.repeat(depth)}- ${n.title}${n.children?.length ? `\n${outline(n.children, depth + 1)}` : ''}`).join('\n');

  if (error && !tree) return <p className="err">⚠ {error}</p>;
  if (!tree) return <p className="hint">Loading…</p>;

  return (
    <div className="module-view">
      <div className="module-bar">
        <form className="add-row" onSubmit={(e) => { e.preventDefault(); addTop(); }}>
          <input value={topText} onChange={(e) => setTopText(e.target.value)} placeholder="New list…" />
          <button type="submit" disabled={busy || !topText.trim()}>Add list</button>
        </form>
        <ViewToggle view={view} onView={setView} />
      </div>
      {error && <p className="err">⚠ {error}</p>}

      {view === 'text' ? (
        <pre className="text-mirror">{tree.length ? outline(tree) : 'No lists yet.'}</pre>
      ) : (
        <div className="tree">
          {tree.length === 0 ? <p className="hint">No lists yet — add one above.</p> : tree.map((n) => <Node key={n.id} node={n} depth={0} />)}
        </div>
      )}
    </div>
  );
}
