'use strict';

// ─── Table dialog ────────────────────────────────────────────────────────────
// Creating or editing a table rewrites that table's lines in the text syntax,
// so the text stays the single source of truth (and ⌘Z undoes a dialog edit).

const TYPE_SUGGESTIONS = ['vc', 'vc(32)', 'vc(64)', 'vc(256)', 'int', 'bigint', 'tinyint', 'text', 'date', 'datetime', 'decimal(10,2)', 'bool'];
const SELF = '\u0000self'; // a foreign key to the table being edited, whatever its final name
const LINK_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M10 14a4.2 4.2 0 0 0 6 0l3-3a4.2 4.2 0 0 0-6-6l-1 1"/><path d="M14 10a4.2 4.2 0 0 0-6 0l-3 3a4.2 4.2 0 0 0 6 6l1-1"/></svg>';
const GRIP_ICON = '<svg viewBox="0 0 10 16" aria-hidden="true"><circle cx="2.5" cy="3" r="1.4"/><circle cx="7.5" cy="3" r="1.4"/><circle cx="2.5" cy="8" r="1.4"/><circle cx="7.5" cy="8" r="1.4"/><circle cx="2.5" cy="13" r="1.4"/><circle cx="7.5" cy="13" r="1.4"/></svg>';
const MOVE_KEYS = /mac|iphone|ipad/i.test(navigator.userAgentData?.platform ?? navigator.platform) ? '⌥↑ / ⌥↓' : 'Alt+↑ / Alt+↓';
// the column's yes/no options, as pills: [field, label]. What belongs to one column is on it (indexed: an index over it
// alone); what spans several columns is on the Combined tab, a row each.
const FLAGS = [['pk', 'PK'], ['nullable', 'NULL'], ['unique', 'UNIQUE'], ['indexed', 'INDEX'], ['auto', 'AUTO']];
// what a Combined row is: [kind, label], the kind as the text's word for it; then FK, a foreign key, a form of its own
const KINDS = [['pk', 'PK'], ['unique', 'UNIQUE'], ['index', 'INDEX'], ['fk', 'FK']];
const ONE_COLUMN_KEYS = 'Keys over one column: on the Columns tab'; // under a foreign key's list of keys, which has those over several

const dlgEl = $('#tableDlg'), tdName = $('#tdName'), tdCols = $('#tdCols'), tdCombined = $('#tdCombined');
$('#typeList').innerHTML = TYPE_SUGGESTIONS.map(t => `<option value="${t}">`).join('');

// dlg: { orig, at, nameComment, tables, fk, start, tab, cols: [{ name, origName, type, openedType, pk, nullable, unique, indexed, auto, ref, refCol, comment }],
//        rows: [{ kind, chips: [{ col } | { written }], comment, growing }], fks: [{ table, keyCols, cols, onDelete, onUpdate }] }
// dlg.fk: the open foreign-key chooser { row, table, usePk, col, filter }
// dlg.start: the dialog as it opened (see snapshot), to tell whether closing loses anything
// dlg.tab: the tab shown, 'cols' or 'combined'
// cols[].pk: the key alone (written pk); a column of a key over several columns is a chip of the PK row instead
// cols[].openedType: the type it had as opened where none was written (its reference's, an Id's, vc), '' for one added here
// dlg.rows: the Combined tab's rows, keys and indexes over several columns: the primary key (kind 'pk', one row at most),
// then unique keys and indexes, each over its columns in order, a chip each: one of dlg.cols (col), or a name that is no
// column of the table, kept as written for the text to report. A row over one column is that column's PK, UNIQUE or INDEX
// (foldRows): once the Columns tab shows, unless it is still being filled in (growing: added here and not yet over several
// columns), and once the dialog opens or saves.
// dlg.fks: the Combined tab's foreign keys over several columns, after its rows. Each points at a key: table (another
// table's name, or SELF; null while none is picked) and keyCols, the key's columns in its order as chips (another
// table's by their names, written; this table's its columns, col); and for each of them, the column of this table that
// points at it (cols, by keyCols; null while none is picked), whose own ref it is instead. The actions are kept as read.
let dlg = null;

const blankCol = () => ({ name: '', origName: null, type: '', openedType: '', pk: false, nullable: false, unique: false, indexed: false, auto: false, ref: null, refCol: null, comment: '' });
const inlineComment = line => { const i = commentAt(line ?? ''); return i >= 0 ? line.slice(i).trim() : ''; };
const lc = s => s.toLowerCase();
const keyed = (cls, h) => ` class="${cls}${h == null ? '' : ' h-hue'}"${h == null ? '' : ` style="--h:${h}"`}`; // an element in a key's colour

// The key colours of the diagram (see keyHues), so the dialog shows what the diagram shows
const tableOf = key => key === SELF ? dlg.tables.find(t => t.name === dlg.orig) : dlg.tables.find(t => lc(t.name) === lc(key ?? ''));
const tableHue = key => tableOf(key)?.hue ?? null;
// what an arrow to a table (refCol null: its primary key) or one of its columns gets
function refHue(key, refCol) {
  const t = tableOf(key);
  if (!t) return null;
  if (!refCol) return t.pkCols.length === 1 ? t.hue : null;
  const col = t.cols.find(c => lc(c.name) === lc(refCol));
  if (!col) return null;
  const hue = partKeyHue(t, col);
  if (hue != null) return hue;
  for (const o of dlg.tables) for (const c of o.cols) if (c.targetCol === col) return c.keyHue;
  return null;
}

// The model of the text syntax, converting from SQL first if the SQL was edited last
function textModel() {
  regenerate('text');
  const r = parseText(state.text);
  resolve(r.tables);
  keyHues(r.tables);
  return r;
}

// A table's lines: its name line up to the last indented line before the next table
function blockRange(lines, start) {
  let end = start;
  for (let i = start + 1; i < lines.length; i++) {
    const code = stripComment(lines[i]);
    if (code.trim() && !/^\s/.test(code)) break;
    if (/^\s/.test(lines[i]) && lines[i].trim()) end = i;
  }
  return [start, end];
}

// col: the column to start on (the one double-clicked in the diagram), else the table name
function openTableEditor(name, at = null, col = null) {
  const { tables } = textModel();
  const t = name ? tables.find(t => t.name === name) : null;
  const lines = state.text.split('\n');
  dlg = { orig: t?.name ?? null, at, tables, fk: null, nameComment: t ? inlineComment(lines[t.line - 1]) : '' };
  dlg.cols = t
    ? t.cols.map(c => ({
        name: c.name, origName: c.name, type: c.type ?? '', openedType: c.type ? '' : c.effType, pk: false, nullable: c.nullable, unique: c.unique, indexed: false, auto: c.auto,
        ref: !c.ref ? null : c.target === t || (!c.target && lc(c.ref) === lc(t.name)) ? SELF : c.target?.name ?? c.ref,
        refCol: !c.ref ? null : !c.target ? c.refCol : pointsToPk(c) ? null : c.targetCol.name,
        onDelete: c.onDelete, onUpdate: c.onUpdate, default: c.default, // kept as they are: the dialog doesn't edit them
        comment: inlineComment(lines[c.line - 1]),
      }))
    : [{ ...blankCol(), name: 'Id' }, blankCol()];
  // The keys and indexes as rows, those over one column then its pills: the primary key as written (its pk (…) line,
  // else the columns marked pk), the unique keys, the indexes. A key's or an index's own line keeps its comment; one
  // written after a column is the column's.
  const fromText = (kind, names, line) => ({ kind, comment: line && !t.cols.some(c => c.line === line) ? inlineComment(lines[line - 1]) : '',
    chips: names.map(n => { const col = dlg.cols.find(c => lc(c.name) === lc(n)); return col ? { col } : { written: n }; }) });
  const keyNames = t?.pkLine?.cols ?? t?.cols.filter(c => c.pk).map(c => c.name) ?? [];
  dlg.rows = t ? [
    ...(keyNames.length ? [fromText('pk', keyNames, t.pkLine?.line)] : []),
    ...(t.uniques ?? []).map(u => fromText('unique', u.cols, u.line)),
    ...(t.indexes ?? []).map(ix => fromText('index', ix.cols, ix.line)),
  ] : [];
  // A foreign key over several columns (arrows that point at a key's columns together) is one on Combined
  dlg.fks = (t?.fkGroups ?? []).map(g => {
    const self = g.target === t, colOf = c => dlg.cols[t.cols.indexOf(c)], cols = g.cols.map(colOf);
    for (const c of cols) c.ref = c.refCol = null;
    return { table: self ? SELF : g.target.name, keyCols: g.targetCols.map(k => self ? { col: colOf(k) } : { written: k.name }),
      cols, onDelete: g.cols[0].onDelete, onUpdate: g.cols[0].onUpdate };
  });
  foldRows();
  $('#tdTitle').textContent = t ? `Edit table ${t.name}` : 'New table';
  $('#tdDelete').hidden = !t;
  disarmDelete();
  tdName.value = t ? t.name : '';
  clearError();
  renderCols();
  renderCombined();
  showTab('cols');
  dlg.start = snapshot();
  dlgEl.hidden = false;
  const colIn = col != null && tdCols.querySelector(`.col-row[data-i="${dlg.cols.findIndex(c => c.name === col)}"] .c-name`);
  if (colIn) { colIn.select(); colIn.scrollIntoView({ block: 'nearest' }); }
  else if (t) tdName.select();
  else tdName.focus();
}

function closeTableEditor() {
  dlgEl.hidden = true;
  dlg = null;
}

// The name, the columns, the keys and indexes and the foreign keys over several columns that would be saved (empty
// columns aren't)
const snapshot = () => JSON.stringify([tdName.value, dlg.cols.filter(c => c.name.trim() || c.type.trim() || c.ref),
  dlg.rows.map(r => [r.kind, r.chips.map(chipName)]), dlg.fks.map(f => [f.table, f.keyCols.map(chipName), f.cols.map(c => c && dlg.cols.indexOf(c))])]);

// Esc and a click outside ask before throwing edits away (Cancel says what it does, so it doesn't)
async function requestClose() {
  if (snapshot() === dlg.start) return closeTableEditor();
  const focus = document.activeElement;
  const ok = await confirmBox({
    title: 'Discard changes?',
    body: dlg.orig ? `Your changes to <b>${esc(dlg.orig)}</b> aren't saved.` : 'The new table isn\'t saved.',
    ok: 'Discard', cancel: 'Keep editing',
  });
  if (ok) closeTableEditor(); else focus?.focus();
}

// ─── What a foreign key can point to ─────────────────────────────────────────

// Tables to choose from, alphabetically, with the table being edited as it is in the dialog right now
function targetTables() {
  const selfName = tdName.value.trim() || dlg.orig || 'this table';
  const explicitPk = writesKey();
  const self = {
    key: SELF, name: selfName, self: true,
    cols: dlg.cols.filter(c => c.name.trim()).map(c => ({
      name: c.name.trim(),
      type: c.type.trim() || defaultFormType(c),
      isPk: c.pk || inKeyRow(c) || (!explicitPk && isIdName(c.name.trim())),
      unique: c.unique,
    })),
  };
  const others = dlg.tables.filter(t => t.name !== dlg.orig).map(t => ({
    key: t.name, name: t.name,
    cols: t.cols.map(c => ({ name: c.name, type: c.type ?? c.effType, isPk: c.isPk, unique: c.unique })),
  }));
  const all = [...others, self];
  for (const t of all) {
    t.pkCols = t.cols.filter(c => c.isPk).map(c => c.name);
    t.pk = t.pkCols.length === 1 ? t.pkCols[0] : null;
    t.pkNote = t.pkCols.join(', ') || 'none';
  }
  return all.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
}

// The type a column takes with none typed, as the text gives it: an Id an int, one of a foreign key over several columns
// the type of its key column, one with a reference the type of the column it points to (int where there is none); else
// the type it had as opened, which a reference given up or an Id renamed leaves it (Save writes it), or vc
function defaultFormType(c, depth = 0) {
  if (isIdName(c.name.trim())) return 'int';
  const at = formOf(c), type = at && depth < 8 && refType(at.form.table, chipName(at.form.keyCols[at.k]), depth);
  if (type) return type;
  if (c.ref) return (depth < 8 && refType(c.ref, c.refCol, depth)) || 'int';
  return c.openedType || 'vc';
}

// The type of the column a foreign key to `key` (a table's name, or SELF) and its refCol points to: refCol, else the
// table's one primary key column; null where there is none
function refType(key, refCol, depth) {
  if (key !== SELF) {
    const t = tableOf(key), col = !t ? null : refCol ? t.cols.find(c => lc(c.name) === lc(refCol)) : t.pkCols.length === 1 ? t.pkCols[0] : null;
    return col?.effType ?? null;
  }
  const name = refCol ?? ownKeyColumn(), col = name && dlg.cols.find(c => lc(c.name.trim()) === lc(name));
  return col ? col.type.trim() || defaultFormType(col, depth + 1) : null;
}

function refLabel(c) {
  const t = targetTables().find(t => t.key === c.ref || (c.ref !== SELF && lc(t.name) === lc(c.ref)));
  const name = c.ref === SELF ? (tdName.value.trim() || 'this table') : c.ref;
  return name + '.' + (c.refCol ?? t?.pk ?? '?');
}

// ─── Column rows ─────────────────────────────────────────────────────────────

function renderCols() {
  tdCols.innerHTML = dlg.cols.map((c, i) => {
    const target = c.ref && refLabel(c), at = formOf(c);
    return `
    <div class="col-row${dlg.fk?.row === i ? ' fk-open' : ''}" data-i="${i}">
      <span class="grip" title="Drag to move (${MOVE_KEYS})">${GRIP_ICON}</span>
      <input class="c-name" value="${esc(c.name)}" placeholder="Column name" spellcheck="false" autocomplete="off">
      <input class="c-type" value="${esc(c.type)}" list="typeList" spellcheck="false" autocomplete="off">
      <div class="c-flags">${FLAGS.map(([f, label]) => `<button class="pill" data-act="flag" data-f="${f}">${label}</button>`).join('')}</div>
      <div class="c-fk">${at
        ? `<div${keyed('fk-chip in-fk', fkHue(at.form))}><button class="fk-label" disabled title="In a foreign key over several columns: change it on Combined">` +
            `→ ${esc((at.form.table === SELF ? tdName.value.trim() || 'this table' : at.form.table) + '.' + chipName(at.form.keyCols[at.k]))}</button></div>`
        : c.ref
        ? `<div${keyed('fk-chip', refHue(c.ref, c.refCol))}>` +
            `<button class="fk-label" data-act="fk" title="Points to ${esc(target)}. Click to change">→ ${esc(target)}</button>` +
            `<button class="fk-unlink" data-act="unlink" title="Not a foreign key" aria-label="Not a foreign key">×</button></div>`
        : `<button class="icon-btn link" data-act="fk" title="Make this a foreign key">${LINK_ICON}</button>`}</div>
      <div class="c-actions"><button class="icon-x" data-act="del" title="Remove column">×</button></div>
    </div>${dlg.fk?.row === i ? fkPanelMarkup() : ''}`;
  }).join('');
  refreshHints();
  if (dlg.fk) renderFkPanel();
}

// on: filled; locked: on because of the name, not a choice; gone: can't apply to this column
function setPill(b, on, { locked = false, gone = false, title }) {
  b.setAttribute('aria-pressed', on);
  b.disabled = locked || gone;
  b.classList.toggle('gone', gone);
  b.title = title;
}

// Placeholders and pills that depend on other fields (Id is the PK unless another column says pk, or a PK row is over
// columns), and the hints
function refreshHints() {
  const explicitPk = writesKey(), key = keyRow();
  const pkCount = dlg.cols.filter(c => c.pk && c.name.trim()).length;
  for (const row of tdCols.querySelectorAll('.col-row')) {
    const c = dlg.cols[+row.dataset.i];
    const pill = f => row.querySelector(`.pill[data-f="${f}"]`);
    const isId = isIdName(c.name.trim());
    const autoPk = !explicitPk && isId, combined = inKeyRow(c), alone = c.pk || autoPk;
    const isPk = alone || combined;
    setPill(pill('pk'), isPk, { locked: autoPk, title: combined ? 'In the primary key over several columns: untick to take it out'
      : autoPk ? 'Id is the primary key automatically' : 'Primary key' });
    // a primary key column in the table's colour, as in the diagram
    const hue = isPk ? tableHue(SELF) : null;
    for (const el of [pill('pk'), row.querySelector('.c-name')]) {
      el.classList.toggle('h-hue', hue != null);
      el.style.setProperty('--h', hue ?? '');
    }
    // a primary key is never NULL
    if (isPk) c.nullable = false;
    setPill(pill('nullable'), c.nullable, { gone: isPk, title: 'May be NULL' });
    // a unique key or index being filled in on Combined, over it alone so far, shows on its pill: Combined's to change
    const uniqueRow = growingRowOver(c, 'unique'), indexRow = growingRowOver(c, 'index');
    setPill(pill('unique'), c.unique || uniqueRow, { locked: uniqueRow, title: uniqueRow ? 'A unique key on Combined is over it: change it there' : 'UNIQUE' });
    // an index of its own adds nothing to a key's
    setPill(pill('indexed'), c.indexed || indexRow, { locked: alone || c.unique || indexRow, title: indexRow ? 'An index on Combined is over it: change it there'
      : alone || c.unique ? `Indexed already, as ${c.unique ? 'a unique column' : 'the primary key'}` : 'INDEX: an index over this column alone' });
    // auto_increment: only an integer column that is the primary key on its own; such an Id has it already
    const canAuto = (autoPk || (c.pk && pkCount === 1 && !key?.chips.length)) && INT_TYPES.has(typeParts(normType(c.type.trim() || 'int')).base);
    const implied = canAuto && isId;
    if (!canAuto) c.auto = false;
    setPill(pill('auto'), canAuto && (c.auto || implied), {
      locked: implied, gone: !canAuto, title: implied ? 'Id is numbered by the database automatically' : 'AUTO_INCREMENT',
    });
    row.querySelector('.c-type').placeholder = defaultFormType(c);
  }
  renderHints();
}

// The band above Save: on the Columns tab, what the Combined tab holds that the rows don't show, as the diagram's
// footer writes it; Delete table armed, the foreign keys into the table, which go with it
function renderHints() {
  const onCols = dlg.tab === 'cols', key = keyRow(), names = r => r.chips.map(ch => chipName(ch) || 'no name').join(', ');
  const others = dlg.rows.filter(r => r.kind !== 'pk' && r.chips.length).map(r => `${r.kind} (${names(r)})`);
  const hints = [
    [$('#tdKeyHint'), onCols && key?.chips.length ? `The primary key is over ${names(key)}: change it on Combined.` : ''],
    [$('#tdCombinedHint'), onCols && others.length ? `Also on Combined: ${others.join(', ')}.` : ''],
    [$('#tdDeleteNote'), $('#tdDelete').classList.contains('armed') ? keysIntoText(keysInto(dlg.tables, [dlg.orig])) : ''],
  ];
  for (const [el, text] of hints) { el.textContent = text; el.hidden = !text; }
  $('#tdHints').hidden = hints.every(([, text]) => !text);
}

tdCols.addEventListener('input', e => {
  if (e.target.id === 'fkFilter') { dlg.fk.filter = e.target.value; renderFkPanel(); return; }
  if (e.target.id === 'fkUsePk') { dlg.fk.usePk = e.target.checked; renderFkPanel(); return; }
  const row = e.target.closest('.col-row');
  if (!row) return;
  const c = dlg.cols[+row.dataset.i], cl = e.target.classList;
  if (cl.contains('c-name')) c.name = e.target.value;
  else if (cl.contains('c-type')) c.type = e.target.value;
  if (cl.contains('invalid')) clearError();
  refreshHints();
});

tdCols.addEventListener('click', e => {
  const b = e.target.closest('[data-act]');
  if (!b) return;
  const act = b.dataset.act;
  if (act.startsWith('fk-')) return fkPanelClick(b);
  const i = +b.closest('.col-row').dataset.i, cols = dlg.cols;
  switch (act) {
    case 'flag': {
      const on = b.getAttribute('aria-pressed') !== 'true', f = b.dataset.f;
      if (f === 'pk') toggleColumnKey(cols[i]);
      else cols[i][f] = on;
      if (f === 'unique' && on) cols[i].indexed = false; // an index of its own adds nothing to a key's
      if (f === 'pk') renderCombined();
      return refreshHints();
    }
    case 'del': dropCombinedColumn(cols[i]); cols.splice(i, 1); dlg.fk = null; foldRows(true); renderCombined(); break;
    case 'unlink': cols[i].ref = cols[i].refCol = null; if (dlg.fk?.row === i) dlg.fk = null; break;
    case 'fk': return openFk(i);
  }
  renderCols();
});

// ─── Moving a column: drag its grip, or Alt+↑/↓ in the row ───────────────────

function moveCol(i, to) {
  if (to < 0 || to >= dlg.cols.length || to === i) return false;
  dlg.cols.splice(to, 0, ...dlg.cols.splice(i, 1));
  dlg.fk = null;
  renderCols();
  return true;
}

tdCols.addEventListener('pointerdown', e => {
  if (e.button !== 0 || !e.target.closest('.grip')) return;
  e.preventDefault();
  const from = +e.target.closest('.col-row').dataset.i;
  clearError();
  if (dlg.fk) { dlg.fk = null; renderCols(); } // the rows alone, nothing between them
  const row = tdCols.querySelector(`.col-row[data-i="${from}"]`);
  row.classList.add('dragging');
  tdCols.classList.add('reordering');
  tdCols.setPointerCapture(e.pointerId); // on the list, which stays while the row moves in it
  // the row goes before the first other row whose middle is below the pointer
  const move = ev => {
    const before = [...tdCols.children].find(r => r !== row && ev.clientY < r.getBoundingClientRect().top + r.offsetHeight / 2) ?? null;
    if (row.nextElementSibling !== before) tdCols.insertBefore(row, before);
  };
  const end = () => {
    tdCols.removeEventListener('pointermove', move);
    tdCols.removeEventListener('pointerup', end);
    tdCols.removeEventListener('pointercancel', end);
    tdCols.classList.remove('reordering');
    dlg.cols = [...tdCols.children].map(r => dlg.cols[+r.dataset.i]);
    renderCols();
  };
  tdCols.addEventListener('pointermove', move);
  tdCols.addEventListener('pointerup', end);
  tdCols.addEventListener('pointercancel', end);
});

function addColumn() {
  showTab('cols');
  dlg.fk = null;
  dlg.cols.push(blankCol());
  renderCols();
  tdCols.querySelector(`.col-row[data-i="${dlg.cols.length - 1}"] .c-name`).focus();
  $('#tdAdd').scrollIntoView({ block: 'nearest' }); // the focus shows the row alone: Add, under it, too
}
$('#tdAdd').onclick = addColumn;

// ─── Tabs: Columns, Combined ─────────────────────────────────────────────────

function showTab(tab) {
  dlg.tab = tab;
  for (const b of dlgEl.querySelectorAll('.dlg-tabs [data-tab]')) {
    b.classList.toggle('on', b.dataset.tab === tab);
    b.setAttribute('aria-selected', String(b.dataset.tab === tab));
    b.tabIndex = b.dataset.tab === tab ? 0 : -1;
  }
  $('#tdColsPane').hidden = tab !== 'cols';
  $('#tdCombinedPane').hidden = tab !== 'combined';
  if (tab === 'combined') { renderCombined(); renderHints(); } // the columns' names as typed
  else { foldRows(true); refreshHints(); } // the pills as the rows say
}
for (const b of dlgEl.querySelectorAll('.dlg-tabs [data-tab]')) b.onclick = () => { if (dlg.fk) closeFk(); showTab(b.dataset.tab); };
// ← → between the tabs, as a tab list does
dlgEl.querySelector('.dlg-tabs').addEventListener('keydown', e => {
  if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
  e.preventDefault();
  const tab = dlg.tab === 'cols' ? 'combined' : 'cols';
  showTab(tab);
  dlgEl.querySelector(`.dlg-tabs [data-tab="${tab}"]`).focus();
});

// ─── Combined rows: keys and indexes over several columns ────────────────────

// A chip's name as it stands: its column's as typed, else the name it was written with; '' for a column with none
const chipName = ch => ch.col ? ch.col.name.trim() : ch.written;
// The row that is the primary key, if any, and whether a column is one of its chips
const keyRow = () => dlg.rows.find(r => r.kind === 'pk') ?? null;
const inKeyRow = c => !!keyRow()?.chips.some(ch => ch.col === c);
// Whether the dialog writes a primary key: a named column ticked PK, or a PK row over a column. Then no Id is the key
// by its name.
const writesKey = () => dlg.cols.some(c => c.pk && c.name.trim()) || !!keyRow()?.chips.length;
// The columns that are the key alone, but `except`: those ticked PK, else, while no PK row is over a column, an Id by
// its name
function keyAlone(except) {
  const ticked = dlg.cols.filter(c => c !== except && c.pk && c.name.trim());
  if (ticked.length || keyRow()?.chips.length) return ticked;
  return dlg.cols.filter(c => c !== except && isIdName(c.name.trim()));
}
// The column the table is keyed by: the PK row's where it is over one, else the one that is the key alone; null for a key
// over several columns, or none
function ownKeyColumn() {
  const key = keyRow();
  if (key?.chips.length) return key.chips.length === 1 ? chipName(key.chips[0]) : null;
  const alone = keyAlone(null);
  return alone.length === 1 ? alone[0].name.trim() : null;
}
// The columns added to the end of the row, those not in it yet. Over several, it is filled in.
function addChips(row, cols) {
  for (const col of cols) if (!row.chips.some(ch => ch.col === col)) row.chips.push({ col });
  if (row.chips.length > 1) row.growing = false;
}
// Whether a row of `kind` being filled in is over just the column c
const growingRowOver = (c, kind) => dlg.rows.some(r => r.kind === kind && r.growing && r.chips.length === 1 && r.chips[0].col === c);

// Each row over one named column of the table, that column's PK, UNIQUE or INDEX. `live`, while the dialog is open: but
// a row still being filled in, and one over a column whose name is being typed again.
function foldRows(live = false) {
  dlg.rows = dlg.rows.filter(r => {
    const named = r.chips.filter(chipName);
    if (named.length !== 1 || !named[0].col || (live && (r.growing || r.chips.length !== 1))) return true;
    named[0].col[{ pk: 'pk', unique: 'unique', index: 'indexed' }[r.kind]] = true;
    return false;
  });
}

// PK on a column ticked or not. Ticked where another column is the key alone (ticked, or an Id by its name) or a PK
// row is there, they are one key over several columns: the PK row, this column last.
function setColumnKey(c, on) {
  c.pk = on;
  if (!on) return;
  c.indexed = false;
  let row = keyRow();
  const others = keyAlone(c);
  if (!row && !others.length) return;
  if (!row) dlg.rows.unshift(row = { kind: 'pk', chips: [], comment: '' });
  addChips(row, [...others, c]);
  for (const o of [...others, c]) o.pk = false;
}

// PK clicked on a column: in the PK row, it leaves it; else it is ticked or not (setColumnKey). A PK row left over one
// column is that column's PK, as the Columns tab shows.
function toggleColumnKey(c) {
  const key = keyRow(), at = key ? key.chips.findIndex(ch => ch.col === c) : -1;
  if (at >= 0) key.chips.splice(at, 1);
  else setColumnKey(c, !c.pk);
  foldRows(true);
}

// A row's kind picked. Made PK (while no other row is), the columns that were the key alone join it first, in order.
// Made FK, it is a foreign key instead, its key to pick first.
function setRowKind(row, kind) {
  if (kind === row.kind || (kind === 'pk' && keyRow())) return;
  if (kind === 'fk') {
    dlg.rows.splice(dlg.rows.indexOf(row), 1);
    dlg.fks.push(blankFk());
    return;
  }
  if (kind === 'pk') {
    const alone = keyAlone(null);
    for (const c of alone) c.pk = false;
    row.chips.unshift(...alone.filter(c => !row.chips.some(ch => ch.col === c)).map(col => ({ col })));
    if (row.chips.length > 1) row.growing = false;
  }
  row.kind = kind;
}

// A column removed: a unique key over it goes, as dropping the column takes it along; the primary key and an index
// lose it, and keep their other columns. A foreign key's column it was is to pick again; a foreign key to a key of this
// table over it goes whole, and says so: half a key can't be pointed at.
function dropCombinedColumn(c) {
  dlg.rows = dlg.rows.filter(r => {
    const at = r.chips.findIndex(ch => ch.col === c);
    if (at < 0) return true;
    if (r.kind === 'unique') return false;
    r.chips.splice(at, 1);
    return true;
  });
  for (const form of dlg.fks) form.cols = form.cols.map(o => o === c ? null : o);
  dlg.fks = dlg.fks.filter(form => {
    if (form.table !== SELF || !form.keyCols.some(ch => ch.col === c)) return true;
    toast(`Removed the foreign key to ${fkLabel(form)} with ${c.name.trim()}: a foreign key needs every column of its key`);
    return false;
  });
}

// The kind list of a row or a foreign key: the table has one primary key, so PK is offered to the row that is it, or to
// any while none is
function kindList(kind, taken) {
  return `<select class="cb-kind" aria-label="Kind" title="${taken ? 'The table has a primary key already' : 'Primary key, unique key, index or foreign key'}">` +
    KINDS.map(([k, label]) => `<option value="${k}"${k === kind ? ' selected' : ''}${k === 'pk' && taken ? ' disabled' : ''}>${label}</option>`).join('') + '</select>';
}

// The rows, then the foreign keys. A row: its kind; its columns as chips in its order in a field as wide on every row,
// wrapping onto more lines, a + at their end that lists the others; ×.
function renderCombined() {
  const key = keyRow(), targets = dlg.fks.length ? fkTargets() : [];
  tdCombined.innerHTML = dlg.rows.map((r, i) => {
    const chips = r.chips.map((ch, k) => {
      const name = chipName(ch), lost = !ch.col || !name; // a name no column has, or a column with no name to save under
      return `<span class="cb-chip${lost ? ' lost' : ''}" title="${lost ? (ch.col ? 'This column has no name yet' : `${esc(name)} is no column of this table`) : ''}">` +
        `${esc(name || 'no name')}<button data-act="cb-chip" data-k="${k}" title="Take ${esc(name || 'it')} out" aria-label="Take ${esc(name || 'it')} out">×</button></span>`;
    }).join('');
    const choices = dlg.cols.map((c, j) => [c, j]).filter(([c]) => c.name.trim() && !r.chips.some(ch => ch.col === c));
    const what = { pk: 'primary key', unique: 'unique key', index: 'index' }[r.kind];
    return `<div class="cb-row" data-r="${i}">
      ${kindList(r.kind, key && key !== r)}
      <div class="cb-cols">${chips}<select class="cb-add" aria-label="Add a column" title="Add a column"${choices.length ? '' : ' disabled'}>` +
        `<option value="" hidden selected>+</option>${choices.map(([c, j]) => `<option value="${j}">${esc(c.name.trim())}</option>`).join('')}</select></div>
      <button class="icon-x" data-act="cb-del" title="Remove this ${what}" aria-label="Remove this ${what}">×</button>
    </div>`;
  }).join('') + dlg.fks.map((form, f) => fkMarkup(form, f, targets, !!key)).join('') ||
    '<div class="cb-empty">Nothing over several columns yet. A primary key, unique key, index or foreign key over two or more columns goes here; one over a single column is set on the Columns tab.</div>';
}

// A foreign key: FK, → the key it points at, from `targets` (fkTargets), ×; under it a line for each column of that key,
// as the foreign key points: the list of this table's columns to pick the one that points at it, → the key column's
// name; then, while none is picked, that one is still to pick
function fkMarkup(form, f, targets, pkTaken) {
  const at = targets.findIndex(t => sameTarget(form, t)), hue = fkHue(form);
  // a key no longer offered (its table renamed, its key changed) shows as the foreign key has it
  const shown = at < 0 && form.table != null ? fkLabel(form) : 'Points at…';
  const target = `<select class="fk-pick fk-target${at < 0 ? ' unpicked' : ''}" aria-label="The key it points at"` +
    (targets.length ? '' : ` disabled title="No table has a key over several columns to point at. ${ONE_COLUMN_KEYS}."`) + '>' +
    `<option value="" hidden${at < 0 ? ' selected' : ''}>${esc(shown)}</option>` +
    targets.map((t, j) => `<option value="${j}"${j === at ? ' selected' : ''}>${esc(fkLabel(t))}</option>`).join('') +
    `<option disabled>${ONE_COLUMN_KEYS}</option></select>`;
  const lines = form.keyCols.map((ch, k) => {
    const c = form.cols[k], name = chipName(ch);
    const choices = dlg.cols.map((o, j) => {
      if (!o.name.trim()) return '';
      const other = fkElsewhere(form, o);
      return `<option value="${j}"${o === c ? ' selected' : ''}${other ? ' disabled' : ''}>${esc(o.name.trim())}${other ? ` · points at ${esc(fkLabel(other))} already` : ''}</option>`;
    }).join('');
    return `<div class="fk-line" data-k="${k}">
      <select class="fk-pick fk-col${c ? '' : ' unpicked'}" aria-label="The column that points at ${esc(name)}"><option value="" hidden${c ? '' : ' selected'}>Pick a column</option>${choices}</select>
      <span class="fk-arrow">→</span><span${keyed('fk-keycol', hue)}>${esc(name)}</span>
      <span class="fk-note">${c ? '' : `Pick a column for ${esc(name)}`}</span>
    </div>`;
  }).join('');
  return `<div class="fk-form" data-f="${f}">
    <div class="fk-head">${kindList('fk', pkTaken)}<span class="fk-arrow">→</span>${target}<span></span>
      <button class="icon-x" data-act="cb-fk-del" title="Remove this foreign key" aria-label="Remove this foreign key">×</button></div>${lines}
  </div>`;
}

tdCombined.addEventListener('click', e => {
  const b = e.target.closest('[data-act]');
  if (!b) return;
  if (b.dataset.act === 'cb-fk-del') {
    const f = +b.closest('.fk-form').dataset.f;
    dlg.fks.splice(f, 1); // its columns keep the types they have
    renderCombined();
    renderCols();
    (tdCombined.querySelector(`.fk-form[data-f="${Math.min(f, dlg.fks.length - 1)}"] [data-act="cb-fk-del"]`) ?? $('#tdAddCombined')).focus();
    return;
  }
  const i = +b.closest('.cb-row').dataset.r;
  if (b.dataset.act === 'cb-chip') dlg.rows[i].chips.splice(+b.dataset.k, 1);
  else if (b.dataset.act === 'cb-del') dlg.rows.splice(i, 1);
  renderCombined();
  // the focus stays in the row: on its + once a chip is gone, else on the next row's ×
  const row = tdCombined.querySelector(`.cb-row[data-r="${Math.min(i, dlg.rows.length - 1)}"]`);
  ((b.dataset.act === 'cb-chip' && row?.querySelector('.cb-add:not(:disabled)')) || row?.querySelector('[data-act="cb-del"]'))?.focus();
});
tdCombined.addEventListener('change', e => {
  const sel = e.target, form = sel.closest('.fk-form');
  if (form) return fkChange(sel, +form.dataset.f);
  const i = +sel.closest('.cb-row')?.dataset.r, kind = sel.classList.contains('cb-kind');
  if (kind) setRowKind(dlg.rows[i], sel.value);
  else if (sel.classList.contains('cb-add') && sel.value !== '') addChips(dlg.rows[i], [dlg.cols[+sel.value]]);
  else return;
  renderCombined();
  // made FK, the foreign key it is now has its key picked first
  const fk = kind && sel.value === 'fk' && tdCombined.querySelector(`.fk-form[data-f="${dlg.fks.length - 1}"]`);
  (fk ? fk.querySelector('.fk-target:not(:disabled)') ?? fk.querySelector('.cb-kind')
    : tdCombined.querySelector(`.cb-row[data-r="${i}"] .${kind ? 'cb-kind' : 'cb-add'}`))?.focus();
});
function addCombined() {
  showTab('combined');
  dlg.rows.push({ kind: 'index', chips: [], comment: '', growing: true });
  renderCombined();
  tdCombined.querySelector(`.cb-row[data-r="${dlg.rows.length - 1}"] .cb-kind`)?.focus();
  $('#tdAddCombined').scrollIntoView({ block: 'nearest' });
}
$('#tdAddCombined').onclick = addCombined;

// ─── Foreign keys over several columns, on Combined ──────────────────────────

const blankFk = () => ({ table: null, keyCols: [], cols: [], onDelete: null, onUpdate: null });
// The foreign key over several columns a column is one of, and the place of its key column there; null for none
function formOf(c) {
  for (const form of dlg.fks) { const k = form.cols.indexOf(c); if (k >= 0) return { form, k }; }
  return null;
}
// Another foreign key over several columns than `form` that the column c is one of
const fkElsewhere = (form, c) => dlg.fks.find(o => o !== form && o.cols.includes(c));
// "Table (A, B)", or "this table (A, B)", of a foreign key or what it may point at
const fkLabel = ({ table, keyCols }) => `${table === SELF ? 'this table' : table} (${keyCols.map(chipName).join(', ')})`;
// Whether the foreign key points at `target`: the same table, the same columns in order (SELF has no name's case)
const sameTarget = (form, target) => lc(form.table ?? '') === lc(target.table) && form.keyCols.length === target.keyCols.length &&
  form.keyCols.every((ch, k) => lc(chipName(ch)) === lc(chipName(target.keyCols[k])));
// The colour of the key it points at, as the diagram has it
function fkHue(form) {
  const t = tableOf(form.table), names = form.keyCols.map(ch => lc(chipName(ch)));
  return (t && keyGroups(t).find(k => k.cols.length === names.length && k.cols.every((c, i) => lc(c.name) === names[i]))?.hue) ?? null;
}

// The keys over several columns a foreign key may point at, as the text pairs arrows with them: each other table's
// primary key, then its unique keys; then this table's, as its PK and UNIQUE rows have them. [{ table, keyCols }]
function fkTargets() {
  const out = [], named = cols => cols.map(c => ({ written: c.name }));
  for (const t of dlg.tables) {
    if (t.name === dlg.orig) continue;
    if (t.pkCols.length > 1) out.push({ table: t.name, keyCols: named(t.pkCols) });
    for (const u of t.multiUniques) out.push({ table: t.name, keyCols: named(u.cols) });
  }
  for (const r of dlg.rows) if ((r.kind === 'pk' || r.kind === 'unique') && r.chips.length > 1) out.push({ table: SELF, keyCols: r.chips });
  return out;
}

// The foreign key points at `target`, a column to pick for each of its key's: one picked for a key column of the same
// name stays; else the column of that name is picked, unless it points somewhere already, by a reference of its own or
// in another foreign key. The columns picked take their key columns' types.
function setFkTarget(form, target) {
  const was = new Map(form.keyCols.map((ch, k) => [lc(chipName(ch)), form.cols[k]]));
  form.table = target.table;
  form.keyCols = target.keyCols.map(ch => ({ ...ch }));
  form.cols = [];
  for (const ch of form.keyCols) {
    const name = lc(chipName(ch)), kept = was.get(name);
    form.cols.push(kept && !form.cols.includes(kept) ? kept
      : dlg.cols.find(c => lc(c.name.trim()) === name && !c.ref && !form.cols.includes(c) && !fkElsewhere(form, c)) ?? null);
  }
  fitFkTypes(form);
}

// The column c points at the key column at place k, of its type, and at no other: its own reference, or its place for
// another key column, goes
function pickFkCol(form, k, c) {
  form.cols = form.cols.map(o => o === c ? null : o);
  form.cols[k] = c;
  c.ref = c.refCol = null;
  fitFkTypes(form);
}

// Each column of the foreign key takes the type of the key column it points at, where it has another, written or not
function fitFkTypes(form) {
  form.cols.forEach((c, k) => {
    const type = c && refType(form.table, chipName(form.keyCols[k]), 0);
    if (type && normType(type) !== normType(c.type.trim() || defaultFormType(c))) c.type = type;
  });
}

// A pick from a foreign key's lists: its kind (PK, UNIQUE or INDEX: a row of that kind over its columns picked, in its
// key's order), its key, or the column for one of its key's
function fkChange(sel, f) {
  const form = dlg.fks[f];
  let focus;
  if (sel.classList.contains('cb-kind')) {
    dlg.fks.splice(f, 1);
    const row = { kind: 'index', chips: [], comment: '', growing: true };
    dlg.rows.push(row);
    addChips(row, form.cols.filter(Boolean));
    setRowKind(row, sel.value);
    focus = `.cb-row[data-r="${dlg.rows.length - 1}"] .cb-kind`;
  } else if (sel.classList.contains('fk-target')) {
    setFkTarget(form, fkTargets()[+sel.value]);
    focus = form.cols.includes(null) ? `.fk-form[data-f="${f}"] .fk-col.unpicked` : `.fk-form[data-f="${f}"] .fk-target`;
  } else {
    const k = +sel.closest('.fk-line').dataset.k;
    pickFkCol(form, k, dlg.cols[+sel.value]);
    focus = `.fk-form[data-f="${f}"] .fk-line[data-k="${k}"] .fk-col`;
  }
  renderCombined();
  renderCols(); // the columns' references and types as they are now
  tdCombined.querySelector(focus)?.focus();
}

// A pick in the chooser of a key over several columns (target), or of its column keyCol: the column i is one of the
// foreign key that points at that key, the one there or a new one: for keyCol, else for the key column of its own name,
// else for the first still to pick. The Combined tab shows, the one place to change it.
function pointWithForeignKey(i, target, keyCol) {
  const c = dlg.cols[i];
  let form = dlg.fks.find(f => sameTarget(f, target));
  if (!form) {
    dlg.fks.push(form = blankFk());
    setFkTarget(form, target);
  }
  const names = form.keyCols.map(ch => lc(chipName(ch)));
  let k = names.indexOf(lc(keyCol ?? c.name.trim()));
  if (k < 0) k = Math.max(0, form.cols.findIndex(o => !o || o === c));
  if (!c.name.trim()) { // named after what it points to
    const n = (target.table === SELF ? 'Parent' : target.table) + chipName(form.keyCols[k]);
    if (!dlg.cols.some(o => lc(o.name) === lc(n))) c.name = n;
  }
  pickFkCol(form, k, c);
  dlg.fk = null;
  renderCols();
  showTab('combined');
  const at = tdCombined.querySelector(`.fk-form[data-f="${dlg.fks.indexOf(form)}"]`);
  (at.querySelector('.fk-col.unpicked') ?? at.querySelector('.fk-target')).focus();
}

// ─── Foreign-key chooser: table list, then primary key or a specific column ──

function openFk(i) {
  if (dlg.fk?.row === i) return closeFk();
  const c = dlg.cols[i];
  dlg.fk = { row: i, table: c.ref, usePk: !c.refCol, col: c.refCol, filter: '' };
  renderCols();
  $('#fkFilter').focus();
  tdCols.querySelector('.fk-panel').scrollIntoView({ block: 'nearest' }); // its OK too
}

function closeFk() {
  const row = dlg.fk?.row;
  dlg.fk = null;
  renderCols();
  if (row != null) tdCols.querySelector(`.col-row[data-i="${row}"] .c-name`)?.focus();
}

function fkPanelMarkup() {
  return `
    <div class="fk-panel">
      <div class="fk-left">
        <input id="fkFilter" placeholder="Find table…" spellcheck="false" autocomplete="off">
        <div class="fk-list" id="fkTables" role="listbox" aria-label="Tables"></div>
      </div>
      <div class="fk-right">
        <label class="fk-pk"><input type="checkbox" id="fkUsePk"> <span id="fkPkLabel">Primary key</span></label>
        <div class="fk-list" id="fkCols" role="listbox" aria-label="Columns"></div>
        <div class="fk-foot">
          <span id="fkPreview"></span>
          <span class="spacer"></span>
          <button data-act="fk-cancel" class="btn-outline">Cancel</button>
          <button data-act="fk-ok" id="fkOk" class="btn-primary">OK</button>
        </div>
      </div>
    </div>`;
}

function fkState() {
  const fk = dlg.fk, tables = targetTables();
  const filter = lc(fk.filter.trim());
  const shown = tables.filter(t => !filter || lc(t.name).includes(filter));
  const table = tables.find(t => t.key === fk.table || (fk.table !== SELF && lc(t.name) === lc(fk.table ?? '')));
  const usePk = !!table?.pkCols.length && fk.usePk;
  const col = usePk ? table.pk : table?.cols.find(c => lc(c.name) === lc(fk.col ?? ''))?.name ?? null;
  // a primary key over several columns, or a column of one: a foreign key over several columns points at it, on Combined
  const several = table?.pkCols.length > 1 && (usePk || table.pkCols.includes(col))
    ? { table: table.key, keyCols: table.self ? keyRow().chips : table.pkCols.map(n => ({ written: n })) } : null;
  return { tables, shown, table, usePk, col, several, ok: !!(col || several) };
}

function renderFkPanel() {
  const fk = dlg.fk, { shown, table, usePk, col, several, ok } = fkState();
  $('#fkTables').innerHTML = shown.length
    ? shown.map(t => `<button class="fk-item${t === table ? ' on' : ''}" data-act="fk-table" data-key="${esc(t.key === SELF ? '' : t.key)}" role="option" aria-selected="${t === table}">` +
        `<span${keyed('', tableHue(t.key))}>${esc(t.name)}</span>${t.self ? ' <em>(this table)</em>' : ''}</button>`).join('')
    : '<div class="fk-empty">No table matches</div>';

  const pkBox = $('#fkUsePk');
  pkBox.checked = usePk;
  pkBox.disabled = !table?.pkCols.length;
  $('#fkPkLabel').textContent = table ? `Primary key (${table.pkNote})` : 'Primary key';

  const colsEl = $('#fkCols');
  if (!table) colsEl.innerHTML = '<div class="fk-empty">Choose a table</div>';
  else if (usePk) colsEl.innerHTML = '<div class="fk-empty">Untick "Primary key" to point to another column</div>';
  else colsEl.innerHTML = table.cols.map(c => {
    const tag = ` <b${keyed('', refHue(table.key, c.name))}>`;
    const tags = (c.isPk ? tag + 'PK</b>' : '') + (c.unique ? tag + 'UNIQUE</b>' : '') + (!c.isPk && !c.unique ? ' <i>not unique</i>' : '');
    return `<button class="fk-item${c.name === col ? ' on' : ''}" data-act="fk-col" data-col="${esc(c.name)}" role="option" aria-selected="${c.name === col}">` +
      `${esc(c.name)}:${esc(c.type)}${tags}</button>`;
  }).join('') || '<div class="fk-empty">This table has no columns yet</div>';

  const preview = $('#fkPreview'), hue = several ? tableHue(table.key) : col ? refHue(table.key, usePk ? null : col) : null;
  preview.textContent = several ? `→ ${fkLabel(several)}` : col ? `→ ${table.name}.${col}` : '';
  preview.classList.toggle('h-hue', hue != null);
  preview.style.setProperty('--h', hue ?? '');
  $('#fkOk').disabled = !ok;
  $('#fkTables .fk-item.on')?.scrollIntoView({ block: 'nearest' });
}

function fkPanelClick(b) {
  const fk = dlg.fk;
  switch (b.dataset.act) {
    case 'fk-table': {
      const key = b.dataset.key || SELF;
      if (key !== fk.table) { fk.table = key; fk.col = null; fk.usePk = true; }
      renderFkPanel();
      break;
    }
    case 'fk-col': fk.col = b.dataset.col; renderFkPanel(); break;
    case 'fk-cancel': closeFk(); break;
    case 'fk-ok': applyFk(); break;
  }
}

// A key over several columns goes to Combined (pointWithForeignKey)
function applyFk() {
  const { table, usePk, col, several, ok } = fkState();
  if (!ok) return;
  if (several) return pointWithForeignKey(dlg.fk.row, several, usePk ? null : col);
  const c = dlg.cols[dlg.fk.row];
  c.ref = table.key;
  c.refCol = usePk ? null : col;
  if (!c.name.trim()) { // name the column after what it points to
    const n = (table.self ? 'Parent' : table.name) + (usePk ? 'Id' : col);
    if (!dlg.cols.some(o => lc(o.name) === lc(n))) c.name = n;
  }
  closeFk();
}

// Arrow keys move through the table list; Enter picks / confirms; Esc closes the chooser
function fkKeydown(e) {
  const fk = dlg.fk, { shown, table, ok } = fkState();
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    if (!shown.length) return;
    const i = shown.indexOf(table);
    const next = shown[e.key === 'ArrowDown' ? Math.min(shown.length - 1, i + 1) : Math.max(0, i - 1)];
    if (next !== table) { fk.table = next.key; fk.col = null; fk.usePk = true; }
    renderFkPanel();
  } else if (e.key === 'Enter') {
    e.preventDefault();
    if (e.target.tagName === 'BUTTON') { e.target.click(); return; }
    if (ok) applyFk();
    else if (!table && shown.length) { fk.table = shown[0].key; fk.usePk = true; renderFkPanel(); }
  } else if (e.key === 'Escape') {
    e.preventDefault();
    closeFk();
  }
}

// ─── Save / delete ───────────────────────────────────────────────────────────

// Why Save didn't, under the field it is about (lined up with it), on the tab it is on
function fail(input, msg) {
  if (input.closest('#tdColsPane')) showTab('cols');
  clearError();
  input.classList.add('invalid');
  input.focus();
  const at = input.closest('.col-row, .field, .fk-line');
  const err = document.createElement('div');
  err.className = 'field-error';
  err.textContent = msg;
  err.style.paddingLeft = input.getBoundingClientRect().left - at.getBoundingClientRect().left + 'px';
  at.after(err);
  err.scrollIntoView({ block: 'nearest' });
}

function clearError() {
  for (const el of dlgEl.querySelectorAll('.field-error')) el.remove();
  for (const el of dlgEl.querySelectorAll('.invalid')) el.classList.remove('invalid');
}

const REF_RE = /->\s*[\p{L}_][\p{L}\p{N}_$]*(?:\s*[.(]\s*[\p{L}_][\p{L}\p{N}_$]*\s*\)?)?/u;

function saveTable() {
  if (dlg.fk) closeFk();
  const name = tdName.value.trim();
  if (!IDENT.test(name)) return fail(tdName, 'The table name must start with a letter or _, and contain only letters, digits and _.');
  const tables = dlg.tables;
  if (tables.some(t => t.name !== dlg.orig && lc(t.name) === lc(name))) {
    return fail(tdName, `There is already a table named ${name}.`);
  }

  foldRows(); // a row left over one column is that column's PK, UNIQUE or INDEX
  // A foreign key over several columns is its columns' arrows, each to its key column (the text makes them one again).
  // One with a column still to pick isn't saved, nor is the table; one with no key picked is none.
  for (const [f, form] of dlg.fks.entries()) {
    const k = form.cols.indexOf(null);
    if (k < 0) continue;
    showTab('combined');
    return fail(tdCombined.querySelector(`.fk-form[data-f="${f}"] .fk-line[data-k="${k}"] .fk-col`),
      `Pick a column for ${chipName(form.keyCols[k])}, in the foreign key to ${fkLabel(form)}.`);
  }
  const rows = [...tdCols.querySelectorAll('.col-row')];
  const seen = new Set(), cols = [];
  for (const [i, c] of dlg.cols.entries()) {
    const nameIn = rows[i].querySelector('.c-name'), typeIn = rows[i].querySelector('.c-type');
    const cn = c.name.trim(), ct = c.type.trim(), inFk = formOf(c);
    if (!cn && !ct && !c.ref && !inFk) continue; // empty row
    if (!IDENT.test(cn)) return fail(nameIn, cn ? `"${cn}" is not a valid column name.` : 'This column needs a name.');
    if (seen.has(lc(cn))) return fail(nameIn, `There are two columns named ${cn}.`);
    if (/#|->/.test(ct)) return fail(typeIn, 'The type can\'t contain # or ->.');
    seen.add(lc(cn));
    // a type a reference gave, or an Id's int, that nothing gives it now: kept, written
    const kept = !ct && !c.ref && !inFk && !isIdName(cn) && c.openedType !== 'vc' ? c.openedType : '';
    cols.push({ ...c, name: cn, type: ct || kept, inFk });
  }
  const broken = dlg.orig && brokenForeignKey();
  if (broken) {
    const i = dlg.cols.indexOf(broken.col);
    return fail(i < 0 ? tdName : rows[i].querySelector('.c-name'), broken.msg);
  }

  // Columns renamed in the dialog: references to them (here and in other tables) follow along
  const renamed = new Map(cols.filter(c => c.origName && c.origName !== c.name).map(c => [lc(c.origName), c.name]));
  const toSelf = c => c.ref === SELF || (dlg.orig && c.ref && lc(c.ref) === lc(dlg.orig));

  // The Combined rows, under their columns' names as saved: the PK row the pk (…) line, the others unique (…) and
  // index (…) lines, each with its comment. A column with no name leaves them, and a row over none is none; a name that
  // was no column of the table stays as written, for the text to report.
  const keyLines = { pk: [], unique: [], index: [] };
  for (const r of dlg.rows) {
    const names = r.chips.map(chipName).filter(Boolean);
    if (names.length) keyLines[r.kind].push(`  ${r.kind} (${names.join(', ')})` + (r.comment ? '  ' + r.comment : ''));
  }
  const block = [name + (dlg.nameComment ? '  ' + dlg.nameComment : '')];
  // columns ticked PK that are one key together (only text written so, read as it was, can be) get a line too
  const pkLine = keyLines.pk.length > 0 || cols.filter(c => c.pk).length > 1;
  if (!keyLines.pk.length && pkLine) keyLines.pk.push(`  pk (${cols.filter(c => c.pk).map(c => c.name).join(', ')})`);
  // what a column's -> points at, a column of this table by the name it is saved under
  const refTo = c => {
    if (c.inFk) return (c.inFk.form.table === SELF ? name : c.inFk.form.table) + '.' + chipName(c.inFk.form.keyCols[c.inFk.k]);
    if (!c.ref) return null;
    const self = toSelf(c), refCol = self && c.refCol ? renamed.get(lc(c.refCol)) ?? c.refCol : c.refCol;
    return (self ? name : c.ref) + (refCol ? '.' + refCol : '');
  };
  for (const c of cols) {
    const actions = c.inFk && { onDelete: c.inFk.form.onDelete, onUpdate: c.inFk.form.onUpdate }; // one key does one thing
    block.push(columnLine({ ...c, ...actions, pk: c.pk && !pkLine, ref: refTo(c) }) + (c.comment ? '  ' + c.comment : ''));
  }
  block.push(...keyLines.pk, ...keyLines.unique, ...keyLines.index);

  histBegin(dlg.orig ? 'edit table' : 'new table');
  const lines = state.text.split('\n');
  let at;
  const t = dlg.orig && tables.find(t => t.name === dlg.orig);
  if (t) {
    for (const o of tables) {
      if (o === t) continue;
      for (const c of o.cols) {
        if (!c.ref || lc(c.ref) !== lc(dlg.orig)) continue;
        const refCol = c.refCol ? renamed.get(lc(c.refCol)) ?? c.refCol : null;
        if (name === dlg.orig && refCol === c.refCol) continue;
        lines[c.line - 1] = lines[c.line - 1].replace(REF_RE, '-> ' + name + (refCol ? '.' + refCol : ''));
      }
    }
    if (name !== dlg.orig && pos[dlg.orig]) { pos[name] = pos[dlg.orig]; delete pos[dlg.orig]; }
    const [s, e] = blockRange(lines, t.line - 1);
    const comments = lines.slice(s + 1, e + 1).filter(l => /^\s+#/.test(l)); // keep comment lines inside the table
    lines.splice(s, e - s + 1, block[0], ...comments, ...block.slice(1));
    at = s + 1;
  } else {
    while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
    if (lines.length) lines.push('');
    at = lines.length + 1;
    lines.push(...block, '');
    // double-click on the canvas: exactly there; otherwise the layout picks the best spot
    if (dlg.at) pos[name] = { ...dlg.at };
    else delete pos[name];
  }
  saveDoc();
  closeTableEditor();
  commitText(lines.join('\n'), at);
  histCommit();
}

// Another table's foreign key to a key of this table that the dialog doesn't keep, as a refusal to save that says so:
// { col: the first of the key's columns still here, msg }; null for none. Saved, it would point at no key: the other
// table is changed first. Asked once the rows are folded.
function brokenForeignKey() {
  const t = dlg.tables.find(t => t.name === dlg.orig), key = keyRow();
  // the primary key and the unique keys as saved
  const keys = [key?.chips.length ? key.chips.map(ch => ch.col) : keyAlone(null),
    ...dlg.rows.filter(r => r.kind === 'unique').map(r => r.chips.map(ch => ch.col)), ...dlg.cols.filter(c => c.unique).map(c => [c])];
  for (const o of dlg.tables) {
    if (o === t) continue;
    for (const c of o.cols) {
      if (c.target !== t || c.implicit || !leadsFk(c) || !pointsAtKey(c)) continue;
      const { cols, targetCols } = fkCols(c);
      const pointed = targetCols.map(k => dlg.cols.find(d => d.origName && d.name.trim() && lc(d.origName) === lc(k.name))).filter(Boolean);
      if (pointed.length === targetCols.length && keys.some(kept => kept.length === pointed.length && pointed.every(d => kept.includes(d)))) continue;
      return { col: pointed[0] ?? null, msg: `${o.name}'s foreign key (${cols.map(x => x.name).join(', ')}) points at ${t.name} ` +
        `(${targetCols.map(x => x.name).join(', ')}): keep that key, or change ${o.name} first.` };
    }
  }
  return null;
}

function deleteTable() {
  const btn = $('#tdDelete');
  if (!btn.classList.contains('armed')) {
    btn.classList.add('armed');
    btn.textContent = 'Click again to delete';
    renderHints();
    return;
  }
  const name = dlg.orig;
  closeTableEditor();
  deleteTables([name]);
}
function disarmDelete() {
  const btn = $('#tdDelete');
  btn.classList.remove('armed');
  btn.textContent = 'Delete table';
}

// ─── Deleting and duplicating tables (the dialog, the keys for the selected tables) ──

// Their lines go, from the bottom up so the line numbers of the others still hold, and the foreign keys into them with
// them: the columns stay, of the type they had. Undo in the toast, which says what went.
function deleteTables(names) {
  const { tables } = textModel();
  const doomed = tables.filter(t => names.includes(t.name)).sort((a, b) => b.line - a.line);
  if (!doomed.length) return;
  const gone = new Set(doomed.map(t => lc(t.name))), keys = keysInto(tables, names);
  histBegin(doomed.length > 1 ? 'delete tables' : 'delete table');
  const lines = state.text.split('\n');
  for (const t of tables) {
    if (gone.has(lc(t.name))) continue;
    for (const c of t.cols) if (c.ref && gone.has(lc(c.ref))) lines[c.line - 1] = unlinkedLine(lines[c.line - 1], c);
  }
  for (const t of doomed) {
    const [s, e] = blockRange(lines, t.line - 1);
    lines.splice(s, e - s + 1);
    while (s < lines.length && !lines[s].trim() && (s === 0 || !lines[s - 1].trim())) lines.splice(s, 1);
    delete pos[t.name];
  }
  saveDoc();
  setSelected([...selected].filter(n => !names.includes(n)));
  commitText(lines.join('\n'), null);
  histCommit();
  const what = doomed.length > 1 ? `Deleted ${doomed.length} tables` : `Deleted ${doomed[0].name}`;
  toast(what + (keys.length === 1 ? ` and the foreign key from ${keys[0]}` : keys.length === 2 ? ` and the foreign keys from ${keys[0]} and ${keys[1]}`
    : keys.length ? ` and ${keys.length} foreign keys into ${doomed.length > 1 ? 'them' : 'it'}` : ''), 'Undo', histUndo);
}

// The foreign keys of the other tables that point into the tables `names`, which deleting those takes along:
// "Course.TeacherId", one over several columns "Line (OrderNo, LineNo)"
function keysInto(tables, names) {
  const gone = new Set(names.map(lc)), keys = [];
  for (const t of tables) {
    if (gone.has(lc(t.name))) continue;
    for (const c of t.cols) {
      if (c.ref && gone.has(lc(c.ref)) && leadsFk(c)) keys.push(c.fkGroup ? `${t.name} (${c.fkGroup.cols.map(o => o.name).join(', ')})` : `${t.name}.${c.name}`);
    }
  }
  return keys;
}

// What deleting a table says of keysInto, as Squill says it; '' for none
function keysIntoText(keys) {
  if (!keys.length) return '';
  if (keys.length === 1) return `${keys[0]} points here; its foreign key goes too`;
  const which = keys.length === 2 ? `${keys[0]} and ${keys[1]}` : `${keys[0]}, ${keys[1]} and ${keys.length - 2} more`;
  return `${which} point here; their foreign keys go too`;
}

// A column's line without its -> and the [delete …] and [update …] that go with it, of the type it had where none was
// written; the rest as written
function unlinkedLine(line, c) {
  const at = commentAt(line), code = at < 0 ? line : line.slice(0, at), bi = code.indexOf('[');
  let head = (bi < 0 ? code : code.slice(0, bi)).replace(REF_RE, '').trimEnd();
  if (!c.type) head = head.replace(/^\s*\S+/, m => m + ' ' + c.effType); // after its name
  const opts = bi < 0 ? [] : splitOpts(code.slice(bi + 1).replace(/\]\s*$/, '')).filter(item => !/^(delete|update)\b/i.test(item));
  return head + (opts.length ? ` [${opts.join(', ')}]` : '') + (at < 0 ? '' : '  ' + line.slice(at));
}

// A table a foreign key points to but that isn't there yet ({ table, col, type } of the problem):
// at the end of the text with an Id, and the column it points to if that is another one
function createTable({ table, col, type }) {
  const { tables } = textModel();
  if (tables.some(t => lc(t.name) === lc(table))) return;
  histBegin('new table');
  const lines = state.text.split('\n');
  while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
  if (lines.length) lines.push('');
  const at = lines.length + 1;
  lines.push(table, '  Id');
  if (col && !isIdName(col)) lines.push(`  ${col}${type ? ' ' + type : ''} unique`);
  lines.push('');
  delete pos[table];
  saveDoc();
  commitText(lines.join('\n'), at);
  histCommit();
}

// Copies at the end of the text, named TableCopy (TableCopy2, …), placed like new tables and selected.
// A foreign key to a table copied along points to its copy (so a self-reference stays one).
function duplicateTables(names) {
  const { tables } = textModel();
  const originals = tables.filter(t => names.includes(t.name));
  if (!originals.length) return;
  const taken = new Set(tables.map(t => lc(t.name))), copyOf = new Map();
  for (const t of originals) {
    let n = t.name + 'Copy';
    for (let k = 2; taken.has(lc(n)); k++) n = t.name + 'Copy' + k;
    taken.add(lc(n));
    copyOf.set(lc(t.name), n);
  }
  histBegin(originals.length > 1 ? 'duplicate tables' : 'duplicate table');
  const lines = state.text.split('\n');
  while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
  for (const t of originals) {
    const [s, e] = blockRange(lines, t.line - 1);
    const block = lines.slice(s, e + 1), copy = copyOf.get(lc(t.name));
    block[0] = copy + block[0].slice(block[0].indexOf(t.name) + t.name.length);
    for (const c of t.cols) {
      const to = c.ref && copyOf.get(lc(c.ref));
      if (to) block[c.line - 1 - s] = block[c.line - 1 - s].replace(REF_RE, '-> ' + to + (c.refCol ? '.' + c.refCol : ''));
    }
    if (lines.length) lines.push('');
    lines.push(...block);
    delete pos[copy];
  }
  lines.push('');
  saveDoc();
  commitText(lines.join('\n'), null);
  histCommit();
  setSelected([...copyOf.values()]);
}

// Write new text into the editor (in SQL mode the SQL is regenerated from it).
// Undo is handled by the app's history, which records the caller's action.
function commitText(text, line) {
  state.text = text;
  state.sqlStale = true;
  if (state.mode === 'text') {
    const top = ta.scrollTop;
    ta.value = text;
    update();
    ta.scrollTop = top;
    if (line) selectLine(line); else syncScroll();
    saveState();
  } else {
    const r = parseText(text);
    resolve(r.tables);
    state.sql = genSQL(r.tables, state.dialect);
    state.sqlStale = false;
    ta.value = state.sql;
    update();
    saveState();
  }
}

// ─── Wiring ──────────────────────────────────────────────────────────────────

$('#newTableBtn').onclick = () => openTableEditor(null);
$('#tdSave').onclick = saveTable;
$('#tdCancel').onclick = closeTableEditor;
$('#tdDelete').onclick = deleteTable;
tdName.addEventListener('input', () => {
  if (tdName.classList.contains('invalid')) clearError();
  if (dlg.fk) renderFkPanel(); // "this table" shows the new name
});
dlgEl.addEventListener('pointerdown', e => { if (e.target === dlgEl) requestClose(); });

// Esc closes the chooser if it is open, else the dialog: from anywhere, since the focus leaves
// the dialog when the row it was in is re-rendered (the chooser's own keys are handled below)
document.addEventListener('keydown', e => {
  if (e.key !== 'Escape' || dlgEl.hidden || !$('#confirmDlg').hidden || e.target.closest('.fk-panel')) return;
  e.preventDefault();
  if (dlg.fk) closeFk(); else requestClose();
});

dlgEl.addEventListener('keydown', e => {
  if (e.target.closest('.fk-panel')) return fkKeydown(e);
  const row = e.target.closest('.col-row');
  if (row && e.altKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
    e.preventDefault();
    // the same field of the moved row keeps the focus
    const i = +row.dataset.i, to = i + (e.key === 'ArrowUp' ? -1 : 1);
    const k = [...row.querySelectorAll('input, button')].indexOf(e.target);
    if (moveCol(i, to)) tdCols.querySelectorAll(`.col-row[data-i="${to}"] :is(input, button)`)[k]?.focus();
    return;
  }
  if (e.key !== 'Enter' || e.target.tagName !== 'INPUT') return;
  e.preventDefault();
  // Enter in the last column's name adds another column; anywhere else it saves
  if (row && e.target.classList.contains('c-name') && +row.dataset.i === dlg.cols.length - 1 && e.target.value.trim()) addColumn();
  else saveTable();
});

// The table a selection of one is, if it still exists
const selectedTable = () => selected.size === 1 ? model.tables.find(t => selected.has(t.name)) ?? null : null;

// ↵ (edit), ⌫ / Delete and ⌘D act on the tables selected in the diagram, unless you are typing
document.addEventListener('keydown', e => {
  if (!selected.size || !dlgEl.hidden || !$('#confirmDlg').hidden || e.target.closest('input, textarea, [contenteditable]')) return;
  const mod = e.metaKey || e.ctrlKey;
  if ((e.key === 'Backspace' || e.key === 'Delete') && !mod && !e.altKey) {
    e.preventDefault();
    closeMenus();
    deleteTables([...selected]);
  } else if (mod && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'd') {
    e.preventDefault(); // not the browser's bookmark
    closeMenus();
    duplicateTables([...selected]);
  } else if (e.key === 'Enter' && !mod && selectedTable() && !e.target.closest('button, a, select')) {
    e.preventDefault();
    closeMenus();
    openTableEditor(selectedTable().name);
  }
});

// ─── Right-click menus: a table's, and the empty canvas's ────────────────────

const tableMenu = $('#tableMenu'), canvasMenu = $('#canvasMenu');
let menuAt = null; // where the canvas was right-clicked, in diagram coordinates

function openCtxMenu(menu, e) {
  closeMenus();
  menu.hidden = false;
  const r = menu.getBoundingClientRect();
  menu.style.left = Math.max(8, Math.min(e.clientX, innerWidth - r.width - 8)) + 'px';
  menu.style.top = Math.max(8, Math.min(e.clientY, innerHeight - r.height - 8)) + 'px';
  menu.focus(); // for ↓ ↑ and the shortcuts; Esc closes it
}

svg.addEventListener('contextmenu', e => {
  e.preventDefault();
  const g = document.elementFromPoint(e.clientX, e.clientY)?.closest('.tbl');
  if (!g) {
    menuAt = toWorld(e);
    for (const b of canvasMenu.querySelectorAll('[data-needs-tables]')) b.disabled = !model.tables.length;
    return openCtxMenu(canvasMenu, e);
  }
  if (!selected.has(g.dataset.t)) setSelected([g.dataset.t]);
  // several selected: only what works on all of them
  const n = selected.size;
  for (const el of tableMenu.querySelectorAll('.one')) el.hidden = n > 1;
  $('#tmDup').textContent = n > 1 ? `Duplicate ${n} tables` : 'Duplicate';
  $('#tmDel').textContent = n > 1 ? `Delete ${n} tables` : 'Delete';
  openCtxMenu(tableMenu, e);
});

for (const menu of [tableMenu, canvasMenu]) menu.addEventListener('keydown', e => {
  if (e.key === 'Escape') { e.stopPropagation(); return closeMenus(); } // the menu only, the selection stays
  const items = [...menu.querySelectorAll('button')].filter(b => !b.hidden && !b.disabled), i = items.indexOf(document.activeElement);
  const to = { ArrowDown: i + 1, ArrowUp: i < 0 ? -1 : i - 1, Home: 0, End: items.length - 1 }[e.key];
  if (to === undefined) return;
  e.preventDefault();
  items[(to + items.length) % items.length].focus();
});

canvasMenu.addEventListener('click', e => {
  const cmd = e.target.closest('[data-cmd]')?.dataset.cmd;
  if (!cmd) return;
  closeMenus();
  if (cmd === 'new') openTableEditor(null, dragSpot(menuAt.x, menuAt.y, -20, -15, state.snap)); // as a double-click there
  else if (cmd === 'find') openFinder();
  else if (cmd === 'all') selectAll();
  else if (cmd === 'layout') layoutAndShow();
  else if (cmd === 'fit') fitView();
  else if (cmd === 'zoom') zoom100();
  else if (cmd === 'copy') copyImage();
});

tableMenu.addEventListener('click', e => {
  const cmd = e.target.closest('[data-cmd]')?.dataset.cmd, t = selectedTable();
  if (!cmd) return;
  closeMenus();
  if (cmd === 'dup') duplicateTables([...selected]);
  else if (cmd === 'del') deleteTables([...selected]);
  else if (!t) return;
  else if (cmd === 'edit') openTableEditor(t.name);
  else if (cmd === 'addcol') { openTableEditor(t.name); addColumn(); }
  else if (cmd === 'show') selectLine(t.line);
});

svg.addEventListener('dblclick', e => {
  // the canvas captures the pointer on mousedown (for dragging), so the event's target
  // is the canvas itself: ask what is really under the pointer
  const el = document.elementFromPoint(e.clientX, e.clientY), g = el?.closest('.tbl');
  if (g) {
    const key = el.closest('.row')?.dataset.key; // "Table.Column"
    openTableEditor(g.dataset.t, null, key ? key.slice(g.dataset.t.length + 1) : null);
  } else {
    const w = toWorld(e);
    openTableEditor(null, dragSpot(w.x, w.y, -20, -15, state.snap && !e.altKey)); // on the grid with Snap on, but with ⌥
  }
});
