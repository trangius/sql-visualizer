'use strict';

// ─── Model → SQL, for each database ──────────────────────────────────────────
// DIALECTS holds what differs between the databases: how a name is quoted, how the
// script is written (gen), what the database refuses (problems) and how sample rows go
// in (sampleInserts). state.dialect is one of its keys. Reading SQL is in sql.js.

// Reserved words in MariaDB and MySQL 8 together (as jaidb has them): names like these must be quoted
const MARIADB_RESERVED = new Set(`ACCESSIBLE ADD ALL ALTER ANALYZE AND AS ASC ASENSITIVE BEFORE BETWEEN BIGINT BINARY
BLOB BOTH BY CALL CASCADE CASE CHANGE CHAR CHARACTER CHECK COLLATE COLUMN CONDITION CONSTRAINT CONTINUE CONVERT CREATE CROSS CUBE CUME_DIST
CURRENT_DATE CURRENT_ROLE CURRENT_TIME CURRENT_TIMESTAMP CURRENT_USER CURSOR DATABASE DATABASES DAY_HOUR
DAY_MICROSECOND DAY_MINUTE DAY_SECOND DEC DECIMAL DECLARE DEFAULT DELAYED DELETE DELETE_DOMAIN_ID DENSE_RANK DESC
DESCRIBE DETERMINISTIC DISTINCT DISTINCTROW DIV DOUBLE DO_DOMAIN_IDS DROP DUAL EACH ELSE ELSEIF EMPTY ENCLOSED ESCAPED
EXCEPT EXISTS EXIT EXPLAIN FALSE FETCH FIRST_VALUE FLOAT FLOAT4 FLOAT8 FOR FORCE FOREIGN FROM FULLTEXT FUNCTION
GENERAL GENERATED GRANT GROUP GROUPING GROUPS HAVING HIGH_PRIORITY HOUR_MICROSECOND HOUR_MINUTE HOUR_SECOND IF IGNORE
IGNORE_DOMAIN_IDS IGNORE_SERVER_IDS IN INDEX INFILE INNER INOUT INSENSITIVE INSERT INT INT1 INT2 INT3 INT4 INT8
INTEGER INTERSECT INTERVAL INTO IS ITERATE JOIN JSON_TABLE KEY KEYS KILL LAG LAST_VALUE LATERAL LEAD LEADING LEAVE
LEFT LIKE LIMIT LINEAR LINES LOAD LOCALTIME LOCALTIMESTAMP LOCK LONG LONGBLOB LONGTEXT LOOP LOW_PRIORITY
MASTER_HEARTBEAT_PERIOD MASTER_SSL_VERIFY_SERVER_CERT MATCH MAXVALUE MEDIUMBLOB MEDIUMINT MEDIUMTEXT MIDDLEINT
MINUTE_MICROSECOND MINUTE_SECOND MOD MODIFIES NATURAL NOT NO_WRITE_TO_BINLOG NTH_VALUE NTILE NULL NUMERIC OF OFFSET ON
OPTIMIZE OPTION OPTIONALLY OR ORDER OUT OUTER OUTFILE OVER PAGE_CHECKSUM PARSE_VCOL_EXPR PARTITION PERCENT_RANK
POSITION PRECISION PRIMARY PROCEDURE PURGE RANGE RANK READ READS READ_WRITE REAL RECURSIVE REFERENCES REF_SYSTEM_ID
REGEXP RELEASE RENAME REPEAT REPLACE REQUIRE RESIGNAL RESTRICT RETURN RETURNING REVOKE RIGHT RLIKE ROW ROWS ROW_NUMBER
SCHEMA SCHEMAS SECOND_MICROSECOND SELECT SENSITIVE SEPARATOR SET SHOW SIGNAL SLOW SMALLINT SPATIAL SPECIFIC SQL
SQLEXCEPTION SQLSTATE SQLWARNING SQL_BIG_RESULT SQL_CALC_FOUND_ROWS SQL_SMALL_RESULT SSL STARTING STATS_AUTO_RECALC
STATS_PERSISTENT STATS_SAMPLE_PAGES STORED STRAIGHT_JOIN SYSTEM TABLE TERMINATED THEN TINYBLOB TINYINT TINYTEXT TO
TRAILING TRIGGER TRUE UNDO UNION UNIQUE UNLOCK UNSIGNED UPDATE USAGE USE USING UTC_DATE UTC_TIME UTC_TIMESTAMP VALUES
VARBINARY VARCHAR VARCHARACTER VARYING VIRTUAL WHEN WHERE WHILE WINDOW WITH WRITE XOR YEAR_MONTH ZEROFILL
GET IO_AFTER_GTIDS IO_BEFORE_GTIDS MANUAL MASTER_BIND OPTIMIZER_COSTS PARALLEL QUALIFY`.split(/\s+/));

// MySQL 8.4 reserves one more
const MYSQL_RESERVED = new Set([...MARIADB_RESERVED, 'TABLESAMPLE']);

const SQLITE_KEYWORDS = new Set(`ABORT ACTION ADD AFTER ALL ALTER ALWAYS ANALYZE AND AS ASC ATTACH AUTOINCREMENT BEFORE
BEGIN BETWEEN BY CASCADE CASE CAST CHECK COLLATE COLUMN COMMIT CONFLICT CONSTRAINT CREATE CROSS CURRENT CURRENT_DATE
CURRENT_TIME CURRENT_TIMESTAMP DATABASE DEFAULT DEFERRABLE DEFERRED DELETE DESC DETACH DISTINCT DO DROP EACH ELSE END
ESCAPE EXCEPT EXCLUDE EXCLUSIVE EXISTS EXPLAIN FAIL FILTER FIRST FOLLOWING FOR FOREIGN FROM FULL GENERATED GLOB GROUP
GROUPS HAVING IF IGNORE IMMEDIATE IN INDEX INDEXED INITIALLY INNER INSERT INSTEAD INTERSECT INTO IS ISNULL JOIN KEY LAST
LEFT LIKE LIMIT MATCH MATERIALIZED NATURAL NO NOT NOTHING NOTNULL NULL NULLS OF OFFSET ON OR ORDER OTHERS OUTER OVER
PARTITION PLAN PRAGMA PRECEDING PRIMARY QUERY RAISE RANGE RECURSIVE REFERENCES REGEXP REINDEX RELEASE RENAME REPLACE
RESTRICT RETURNING RIGHT ROLLBACK ROW ROWS SAVEPOINT SELECT SET TABLE TEMP TEMPORARY THEN TIES TO TRANSACTION TRIGGER
UNBOUNDED UNION UNIQUE UPDATE USING VACUUM VALUES VIEW VIRTUAL WHEN WHERE WINDOW WITH WITHOUT`.split(/\s+/));

const POSTGRES_RESERVED = new Set(`ALL ANALYSE ANALYZE AND ANY ARRAY AS ASC ASYMMETRIC AUTHORIZATION BINARY BOTH CASE CAST
CHECK COLLATE COLLATION COLUMN CONCURRENTLY CONSTRAINT CREATE CROSS CURRENT_CATALOG CURRENT_DATE CURRENT_ROLE
CURRENT_SCHEMA CURRENT_TIME CURRENT_TIMESTAMP CURRENT_USER DEFAULT DEFERRABLE DESC DISTINCT DO ELSE END EXCEPT FALSE
FETCH FOR FOREIGN FREEZE FROM FULL GRANT GROUP HAVING ILIKE IN INITIALLY INNER INTERSECT INTO IS ISNULL JOIN LATERAL
LEADING LEFT LIKE LIMIT LOCALTIME LOCALTIMESTAMP NATURAL NOT NOTNULL NULL OFFSET ON ONLY OR ORDER OUTER OVERLAPS
PLACING PRIMARY REFERENCES RETURNING RIGHT SELECT SESSION_USER SIMILAR SOME SYMMETRIC SYSTEM_USER TABLE TABLESAMPLE
THEN TO TRAILING TRUE UNION UNIQUE USER USING VARIADIC VERBOSE WHEN WHERE WINDOW WITH`.split(/\s+/));

const MSSQL_RESERVED = new Set(`ADD ALL ALTER AND ANY AS ASC AUTHORIZATION BACKUP BEGIN BETWEEN BREAK BROWSE BULK BY
CASCADE CASE CHECK CHECKPOINT CLOSE CLUSTERED COALESCE COLLATE COLUMN COMMIT COMPUTE CONSTRAINT CONTAINS CONTAINSTABLE
CONTINUE CONVERT CREATE CROSS CURRENT CURRENT_DATE CURRENT_TIME CURRENT_TIMESTAMP CURRENT_USER CURSOR DATABASE DBCC
DEALLOCATE DECLARE DEFAULT DELETE DENY DESC DISK DISTINCT DISTRIBUTED DOUBLE DROP DUMP ELSE END ERRLVL ESCAPE EXCEPT
EXEC EXECUTE EXISTS EXIT EXTERNAL FETCH FILE FILLFACTOR FOR FOREIGN FREETEXT FREETEXTTABLE FROM FULL FUNCTION GO GOTO
GRANT GROUP HAVING HOLDLOCK IDENTITY IDENTITY_INSERT IDENTITYCOL IF IN INDEX INNER INSERT INTERSECT INTO IS JOIN KEY
KILL LEFT LIKE LINENO LOAD MERGE NATIONAL NOCHECK NONCLUSTERED NOT NULL NULLIF OF OFF OFFSETS ON OPEN OPENDATASOURCE
OPENQUERY OPENROWSET OPENXML OPTION OR ORDER OUTER OVER PERCENT PIVOT PLAN PRECISION PRIMARY PRINT PROC PROCEDURE
PUBLIC RAISERROR READ READTEXT RECONFIGURE REFERENCES REPLICATION RESTORE RESTRICT RETURN REVERT REVOKE RIGHT ROLLBACK
ROWCOUNT ROWGUIDCOL RULE SAVE SCHEMA SECURITYAUDIT SELECT SEMANTICKEYPHRASETABLE SEMANTICSIMILARITYDETAILSTABLE
SEMANTICSIMILARITYTABLE SESSION_USER SET SETUSER SHUTDOWN SOME STATISTICS SYSTEM_USER TABLE TABLESAMPLE TEXTSIZE THEN
TO TOP TRAN TRANSACTION TRIGGER TRUNCATE TRY_CONVERT TSEQUAL UNION UNIQUE UNPIVOT UPDATE UPDATETEXT USE USER VALUES
VARYING VIEW WAITFOR WHEN WHERE WHILE WITH WITHIN WRITETEXT`.split(/\s+/));

// Oracle's reserved words (V$RESERVED_WORDS); some are common column names, like Date, Level, Size and User
const ORACLE_RESERVED = new Set(`ACCESS ADD ALL ALTER AND ANY AS ASC AUDIT BETWEEN BY CHAR CHECK CLUSTER COLUMN COMMENT
COMPRESS CONNECT CREATE CURRENT DATE DECIMAL DEFAULT DELETE DESC DISTINCT DROP ELSE EXCLUSIVE EXISTS FILE FLOAT FOR FROM
GRANT GROUP HAVING IDENTIFIED IMMEDIATE IN INCREMENT INDEX INITIAL INSERT INTEGER INTERSECT INTO IS LEVEL LIKE LOCK LONG
MAXEXTENTS MINUS MLSLABEL MODE MODIFY NOAUDIT NOCOMPRESS NOT NOWAIT NULL NUMBER OF OFFLINE ON ONLINE OPTION OR ORDER
PCTFREE PRIOR PUBLIC RAW RENAME RESOURCE REVOKE ROW ROWID ROWNUM ROWS SELECT SESSION SET SHARE SIZE SMALLINT START
SUCCESSFUL SYNONYM SYSDATE TABLE THEN TO TRIGGER UID UNION UNIQUE UPDATE USER VALIDATE VALUES VARCHAR VARCHAR2 VIEW
WHENEVER WHERE WITH`.split(/\s+/));

// ─── Names ───────────────────────────────────────────────────────────────────
// The scripts are written as Squill's database library (jaidb) writes them: a name bare where the database
// takes it bare, else quoted. PostgreSQL folds a bare name to lower case, so there one with capitals is quoted
// and every name stays as it is spelled. A table is named in the database's default schema where it has one
// (public., dbo.).

const quoter = (words, open, close = open, folds = false) => n =>
  IDENT.test(n) && !words.has(n.toUpperCase()) && !(folds && /[A-Z]/.test(n)) ? n : open + n.split(close).join(close + close) + close;
const tableSQL = (D, n) => (D.schema ? D.q(D.schema) + '.' : '') + D.q(n);

// Lengths in bytes, as the databases count a name's
const utf8Length = s => { let n = 0; for (const ch of s) { const p = ch.codePointAt(0); n += p < 0x80 ? 1 : p < 0x800 ? 2 : p < 0x10000 ? 3 : 4; } return n; };
function clipUtf8(s, max) {
  let out = '', n = 0;
  for (const ch of s) { n += utf8Length(ch); if (n > max) break; out += ch; }
  return out;
}

// A constraint's name: PK_table, UQ_table_column, FK_table_column, numbered from _2 and cut to `max` bytes
function givenName(kind, table, column, number, max) {
  const base = kind === 'pk' ? `PK_${table}` : `${kind === 'unique' ? 'UQ' : 'FK'}_${table}_${column}`, suffix = number ? '_' + (number + 1) : '';
  return clipUtf8(base, max - utf8Length(suffix)) + suffix;
}
// MariaDB's own: PRIMARY, a unique key named after its column (numbered from _2), a foreign key given its name
const mariadbName = (kind, table, column, number, max) => kind === 'pk' ? 'PRIMARY'
  : kind === 'unique' ? (number ? clipUtf8(column, max - utf8Length('_' + (number + 1))) + '_' + (number + 1) : column)
  : givenName(kind, table, column, number, max);
// PostgreSQL's own: table_column_fkey (table_pkey, table_column_key), the longer name cut first until it fits,
// then numbered fkey1, fkey2…
function postgresName(kind, table, column, number, max) {
  const label = { pk: 'pkey', unique: 'key', fk: 'fkey' }[kind] + (number || ''), second = kind === 'pk' ? '' : column;
  const room = max - utf8Length(label) - 1 - (second ? 1 : 0);
  let a = utf8Length(table), b = utf8Length(second);
  while (a + b > room) { if (a > b) a--; else b--; }
  return [clipUtf8(table, a), ...(second ? [clipUtf8(second, b)] : []), label].join('_');
}

// Takes each constraint's name in turn, as the script makes them: { name, sql } with sql "CONSTRAINT name "
// for one the database wouldn't give that name itself (D.names.own), "" otherwise. A name already taken where
// it must be unique (D.names.scope: per table, or for the whole schema) gets the next number.
function constraintNamer(D) {
  const N = D.names, taken = new Set();
  if (!N) return () => ({ name: null, sql: '' });
  return (kind, table, column = '') => {
    const key = name => { const k = (N.scope[kind] === 'table' ? table : '') + '\u0000' + name; return N.exact ? k : k.toLowerCase(); };
    let name;
    for (let n = 0; ; n++) {
      name = N.name(kind, table, column, n, N.max);
      if (kind === 'pk' && N.pk) break; // MariaDB's is PRIMARY in every table
      if (!taken.has(key(name))) { taken.add(key(name)); break; }
    }
    const own = N.own.includes(kind) && name === N.name(kind, table, column, 0, N.max);
    return { name, sql: own ? '' : `CONSTRAINT ${D.q(name)} ` };
  };
}

// ─── Shared by the scripts ───────────────────────────────────────────────────

function topoOrder(tables) {
  const deps = new Map(tables.map(t => [t, t.cols.filter(c => c.target && c.target !== t).map(c => c.target)]));
  const out = [], done = new Set();
  let progress = true;
  while (out.length < tables.length && progress) {
    progress = false;
    for (const t of tables) {
      if (!done.has(t) && deps.get(t).every(d => done.has(d))) { out.push(t); done.add(t); progress = true; }
    }
  }
  const cyclic = out.length < tables.length;
  for (const t of tables) if (!done.has(t)) out.push(t);
  return { order: out, cyclic };
}

// A name the database takes: a longer one is cut, with a hash of the whole to keep it unique
function shortName(n, max) {
  if (n.length <= max) return n;
  let h = 0;
  for (const ch of n) h = (h * 31 + ch.codePointAt(0)) >>> 0;
  return n.slice(0, max - 7) + '_' + h.toString(36).padStart(6, '0').slice(-6);
}

const isBoolType = t => /^(bool|boolean|bit)\b/.test(t);
const enumValues = t => t.match(/^enum\((.*)\)$/)?.[1] ?? null;
const enumCheckSQL = (c, Q) => enumValues(c.effType) ? ` CHECK (${Q(c.name)} IN (${enumValues(c.effType)}))` : '';

// The DEFAULT of a column. [default now] is today's date in a date column, otherwise the current time.
function colDefault(c, D) {
  const d = c.default;
  if (d === 'now') return /^date\b/.test(c.effType) ? D.today : 'CURRENT_TIMESTAMP';
  if (isBoolType(c.effType) && /^(true|false|0|1)$/.test(d)) return D.bool(d === 'true' || d === '1', c);
  if (d === 'true' || d === 'false') return d === 'true' ? '1' : '0'; // in a number column
  if (d === 'null') return 'NULL';
  if (d[0] !== "'") return d;
  const s = d.slice(1, -1).replace(/''/g, "'");
  return D.typed?.(c, s) ?? D.str(s);
}
const defaultSQL = (c, D) => {
  if (c.default == null) return '';
  const v = colDefault(c, D);
  return ' DEFAULT ' + (D.defaultFor ? D.defaultFor(c, v) : v);
};

// The actions the database writes; NO ACTION goes without saying, and RESTRICT where it is the same (D.noActions)
const fkActionsSQL = (c, D) => [['DELETE', c.onDelete], ['UPDATE', c.onUpdate]]
  .map(([on, a]) => a && !D.noActions.includes(a) ? ` ON ${on} ${a.toUpperCase()}` : '').join('');
// FOREIGN KEY over an arrow's column, or over the arrows that are one key together (fkCols)
const fkSQL = (c, D, named = '') => { const { cols, targetCols } = fkCols(c);
  return `${named}FOREIGN KEY (${keyList(cols, D.q)}) REFERENCES ${tableSQL(D, c.target.name)}(${keyList(targetCols, D.q)})` + fkActionsSQL(c, D); };
const keyList = (cols, Q) => cols.map(c => Q(c.name)).join(', ');
const column = (c, w, Q, type, rest) => `  ${Q(c.name).padEnd(w)} ${type}${rest}`;
const nullSQL = c => c.nullable ? ' NULL' : ' NOT NULL';
const colWidth = (t, Q) => Math.max(...t.cols.map(c => Q(c.name).length));

// The table's indexes, [{ name, cols }], with names not in `taken` (which it adds to)
function namedIndexes(t, taken, D) {
  return (t.indexes ?? []).filter(ix => ix.cols.every(n => t.cols.some(c => c.name === n))).map(ix => {
    const base = shortName(ix.name ?? indexName(t.name, ix.cols), D.maxName);
    let name = base;
    for (let i = 2; taken.has(name.toLowerCase()); i++) name = base.slice(0, D.maxName - 1 - String(i).length) + '_' + i;
    taken.add(name.toLowerCase());
    return { name, cols: ix.cols };
  });
}
const createIndexes = (t, taken, D) => namedIndexes(t, taken, D).map(ix =>
  `CREATE INDEX ${D.q(ix.name)} ON ${tableSQL(D, t.name)} (${ix.cols.map(D.q).join(', ')});`);

const tablesOf = tables => topoOrder(tables.filter(t => t.cols.length));
// an arrow to the primary key or a unique column, or one of the arrows to a key over several columns
const isKey = c => pointsToPk(c) || c.targetCol.unique || !!c.fkGroup;
const links = tables => tables.flatMap(t => t.cols.filter(c => c.target && !c.implicit).map(c => ({ t, c })));
const foreignKeys = tables => links(tables).filter(({ c }) => leadsFk(c)); // the arrows of a group as one

// ─── What the databases refuse ───────────────────────────────────────────────

const keyProblems = (tables, db) => links(tables).filter(({ c }) => !isKey(c)).map(({ c }) =>
  problem(c.line, `${db} needs ${c.target.name}.${c.targetCol.name} to be the primary key or unique`));

// Columns in a key or index of a type the database can't key (isLob: TEXT, BLOB…)
const keyedCol = (t, c) => c.isPk || c.unique || t.multiUniques.some(u => u.cols.includes(c)) || t.indexes?.some(ix => ix.cols.includes(c.name));
const lobKeyProblems = (tables, isLob, db) => tables.flatMap(t => t.cols.filter(c => keyedCol(t, c) && isLob(c.effType)).map(c =>
  problem(c.line, `${db} can't make a key or index of ${c.name} (${c.effType}). Use vc instead.`)));

// A foreign key's two sides must be of types that fit: fits(its column's type, the one it points at), else `why`
// ends the problem; unlinkable(type): no foreign key may be over the type at all
function linkTypeProblems(tables, unlinkable, fits, why) {
  const problems = [];
  for (const { c } of links(tables)) {
    const tc = c.targetCol, where = `${c.target.name}.${tc.name}`;
    if (unlinkable(c.effType) || unlinkable(tc.effType)) {
      const there = unlinkable(tc.effType);
      problems.push(problem(c.line, `${there ? where : c.name} is ${there ? tc.effType : c.effType}, ` +
        'which can\'t be part of a foreign key. Use vc instead.'));
    } else if (!fits(c.effType, tc.effType)) {
      problems.push(problem(c.line, `${c.name} is ${c.effType} but ${where} is ${tc.effType}${why}`));
    }
  }
  return problems;
}

// The SQL type a foreign key compares, as jaidb's key_type_sql: as typeSQL writes it, without the fraction of a
// second that goes without saying (D.defaultFraction: TIME(7) is TIME), its sizes left out where they may differ
// (D.keyLengthsMayDiffer)
function keyTypeSQL(t, D) {
  let s = typeSQL(t, D);
  const f = D.defaultFraction;
  if (f && s.endsWith(f.size) && f.types.includes(s.slice(0, -f.size.length))) s = s.slice(0, -f.size.length);
  if (!D.keyLengthsMayDiffer) return s;
  let depth = 0, out = '';
  for (const ch of s) { if (ch === '(') depth++; else if (ch === ')') depth--; else if (!depth) out += ch; }
  return out.trim();
}
// Whether a foreign key from a column of type `a` may point at one of type `b`, as jaidb's key_types_fit says: as
// keyTypeSQL writes them one type, or of one of D.keyTypeKinds ({ type: kind }, both ways), or `a` one that
// D.keyTypeWidenings ({ from: [to] }, one way) lets point at `b`
function keyTypesFit(a, b, D) {
  if (a === b) return true;
  const from = keyTypeSQL(a, D), to = keyTypeSQL(b, D), kind = D.keyTypeKinds?.[from];
  return from === to || (!!kind && kind === D.keyTypeKinds[to]) || !!D.keyTypeWidenings?.[from]?.includes(to);
}
// What a database refuses of a foreign key's types, in jaidb's words (D.keyTypesNeeded)
const keyTypeProblems = (tables, D, unlinkable = () => false) => linkTypeProblems(tables, unlinkable, (a, b) => keyTypesFit(a, b, D),
  `: ${D.name} needs a foreign key's columns ${D.keyTypesNeeded}`);

// ─── Types ───────────────────────────────────────────────────────────────────
// A type as jaidb writes it for the database (written_type), with no server version known: one past its size
// limit as the type D.sizeLimits says ({ name: [max, instead, % the size] }); vc as D.varchar(n); a short name
// as D.types has it ({ name: [sql, the sql when unsigned, 'sized': its size kept where it has one] }); one of
// TYPE_FALLBACKS the database hasn't (D.native) as the first of its stand-ins the database has, else the last;
// anything else in capitals. Where !D.signWords, UNSIGNED, SIGNED and ZEROFILL go (they are MariaDB's and MySQL's).

const VALUES_VC = 'vc(values)'; // a vc as long as an enum's longest value, or a set's values together
const TYPE_FALLBACKS = {
  serial: ['bigint'], uuid: ['char(36)'], inet4: ['inet', 'vc(15)'], inet6: ['inet', 'vc(45)'], inet: ['vc(49)'], cidr: ['vc(49)'],
  macaddr: ['vc(17)'], interval: ['vc(64)'], json: ['longtext'], jsonb: ['json', 'longtext'], xml: ['longtext'], geometry: ['longtext'],
  point: ['geometry', 'longtext'], linestring: ['geometry', 'longtext'], polygon: ['geometry', 'longtext'], money: ['decimal(19,4)'],
  rowversion: ['binary(8)'], enum: [VALUES_VC], set: [VALUES_VC],
};
const signless = s => s.replace(/ (unsigned|signed|zerofill)\b/gi, '');
// Whether the database writes the type as it is, or by its own spelling: not as another that stands in
const hasType = (t, D) => { const { base } = typeParts(t); return !!D.types?.[base] || !TYPE_FALLBACKS[base] || D.native.includes(base); };
// The type that stands in for `t` where the database hasn't it: past its size limit, or at all; null where it has it
function standIn(t, D) {
  const { base, args } = typeParts(t), limit = D.sizeLimits?.[base];
  if (limit && args != null && +args > limit[0]) return limit[1].replace('%', args);
  if (hasType(t, D)) return null;
  const list = TYPE_FALLBACKS[base], pick = list.find((c, i) => i === list.length - 1 || hasType(c, D));
  return pick === VALUES_VC ? `vc(${Math.max(1, base === 'set' ? enumOptions(t).join(',').length : Math.max(0, ...enumOptions(t).map(v => v.length)))})` : pick;
}
function typeSQL(t, D) {
  const instead = standIn(t, D);
  if (instead) return typeSQL(instead, D);
  const { base, args, rest, unsigned } = typeParts(t), row = D.types?.[base], tail = D.signWords ? rest : signless(rest);
  if (base === 'vc') return `${D.varchar}(${args ?? DEFAULT_VC})` + sqlType(tail);
  if (!row) return sqlType(t.slice(0, t.length - rest.length) + tail);
  if (unsigned && row[1]) return row[1];
  return row[2] === 'sized' && args != null ? row[0] + sqlType(signless(t.slice(base.length))) : row[0];
}
// Whether a key or unique key may be over a column of the type there (D.unkeyable)
function keyable(t, D) {
  let { base, args } = typeParts(t);
  const limit = D.sizeLimits?.[base];
  if (limit && args != null && +args > limit[0]) base = typeParts(limit[1].replace('%', args)).base;
  if (TYPE_FALLBACKS[base] && !hasType(base, D)) base = typeParts(TYPE_FALLBACKS[base].at(-1)).base;
  return !(D.unkeyable ?? []).includes(base);
}
const TEXT_TYPES = ['text', 'tinytext', 'mediumtext', 'longtext'], BLOB_TYPES = ['blob', 'tinyblob', 'mediumblob', 'longblob'];
const typeRows = (names, row) => Object.fromEntries(names.map(n => [n, row]));
const SPATIAL = ['geometry', 'point', 'linestring', 'polygon'];

// MariaDB: as written, but REAL is DOUBLE, and CHAR and BINARY hold 255 at most. UUID, INET6 and INET4 are its
// own from 10.7, 10.5 and 10.10: with no version known, text that holds one.
const MARIADB_TYPES = { real: ['DOUBLE'] };
const MARIADB_NATIVE = [...SPATIAL, 'enum', 'set'];
const MARIADB_SIZE_LIMITS = { char: [255, 'vc(%)'], binary: [255, 'varbinary(%)'] };
// A foreign key joins numbers of one type and sign, and strings, binaries, decimals and times of any size
const MARIADB_KEY_KINDS = { VARCHAR: 'string', CHAR: 'string', VARBINARY: 'binary', BINARY: 'binary', DATETIME: 'datetime', TIMESTAMP: 'datetime',
  TINYINT: 'tinyint', BOOL: 'tinyint' };
// MySQL: no UUID nor INET; no key over TEXT, BLOB, JSON or a spatial type
const MYSQL_NATIVE = ['json', ...SPATIAL, 'enum', 'set'];
const MYSQL_UNKEYABLE = [...TEXT_TYPES, ...BLOB_TYPES, 'json', ...SPATIAL];

// SQLite takes any type name and only uses it as a hint, but every integer is INTEGER (only an INTEGER PRIMARY KEY
// numbers its rows), and an enum or a set, whose list it can't take, is a vc (with a CHECK here).
const SQLITE_TYPES = { float: ['REAL'], ...typeRows(['int', 'bigint', 'smallint', 'mediumint', 'tinyint'], ['INTEGER']), bool: ['BOOLEAN'] };
const SQLITE_NATIVE = Object.keys(TYPE_FALLBACKS).filter(n => !['serial', 'enum', 'set'].includes(n));

// PostgreSQL: an unsigned number needs the next size up.
const PG_TYPES = {
  tinyint: ['SMALLINT'], smallint: ['SMALLINT', 'INT'], mediumint: ['INT'], int: ['INT', 'BIGINT'], bigint: ['BIGINT', 'NUMERIC(20)'],
  datetime: ['TIMESTAMP'], double: ['DOUBLE PRECISION'], float: ['REAL'], bool: ['BOOLEAN'], decimal: ['NUMERIC', '', 'sized'],
  ...typeRows(TEXT_TYPES, ['TEXT']), ...typeRows([...BLOB_TYPES, 'binary', 'varbinary'], ['BYTEA']), year: ['SMALLINT'],
};
const PG_NATIVE = ['uuid', 'inet', 'cidr', 'macaddr', 'interval', 'json', 'jsonb', 'xml', 'point', 'polygon', 'money'];
// A foreign key joins integers, floats, dates and times, strings and networks each of one kind, and points from a
// number at a wider kind of number and from a time at a time with a zone or an interval, which it converts to;
// not the other way (jaidb's key_type_kinds and key_type_widenings)
const PG_KEY_KINDS = { ...typeRows(['SMALLINT', 'INT', 'BIGINT'], 'integer'), ...typeRows(['REAL', 'DOUBLE PRECISION'], 'float'),
  ...typeRows(['DATE', 'TIMESTAMP', 'TIMESTAMPTZ'], 'datetime'), ...typeRows(['VARCHAR', 'CHAR', 'TEXT'], 'text'), ...typeRows(['INET', 'CIDR'], 'network') };
const PG_KEY_WIDENINGS = { ...typeRows(['SMALLINT', 'INT', 'BIGINT'], ['NUMERIC', 'REAL', 'DOUBLE PRECISION']),
  NUMERIC: ['REAL', 'DOUBLE PRECISION'], TIME: ['TIMETZ', 'INTERVAL'] };

// SQL Server: text is NVARCHAR, so any language fits. NVARCHAR holds 4000 characters and the others 8000 bytes,
// past which they are (MAX), which no key may be over; a BIT is one bit.
const MSSQL_TYPES = {
  smallint: ['SMALLINT', 'INT'], bigint: ['BIGINT', 'DECIMAL(20,0)'], mediumint: ['INT'], int: ['INT', 'BIGINT'],
  datetime: ['DATETIME2'], timestamp: ['DATETIME2'], double: ['FLOAT'], float: ['REAL'], bool: ['BIT'],
  ...typeRows([...TEXT_TYPES, 'json'], ['NVARCHAR(MAX)']), ...typeRows(BLOB_TYPES, ['VARBINARY(MAX)']), uuid: ['UNIQUEIDENTIFIER'], year: ['SMALLINT'],
};
const MSSQL_SIZE_LIMITS = { vc: [4000, 'text'], char: [8000, 'text'], binary: [8000, 'blob'], varbinary: [8000, 'blob'], bit: [1, 'bigint'] };
const mssqlType = t => typeSQL(t, DIALECTS.mssql);
const isMax = t => /\(MAX\)/.test(mssqlType(t));

// ─── The script ──────────────────────────────────────────────────────────────
// One for every database, as jaidb's generate_schema_sql writes it, with what differs in DIALECTS: tables in
// key order, each with its columns (type, NULL, numbering, DEFAULT, UNIQUE), its primary key and its foreign
// keys; a key to a table made later is added after it (where D.fkInline, as SQLite's are, it goes in the table
// all the same). Before them the tables are dropped, after them their indexes made.

// The names the constraints take, table by table, in the order the script makes them
function constraintNames(order, D) {
  const take = constraintNamer(D), names = new Map();
  const pointedTo = new Set(order.flatMap(t => t.cols.filter(c => c.target).map(c => c.targetCol)));
  // where D.nullUniqueIndex, a unique key that may be null is a unique index of the rows where it isn't:
  // SQL Server's UNIQUE allows one NULL only. An FK may only point to a constraint, so one pointed to stays one.
  const groupedTo = new Set(order.flatMap(t => t.fkGroups.map(g => g.targetCols)));
  const isIndex = cols => D.nullUniqueIndex && cols.some(c => c.nullable) && !(cols.length === 1 && pointedTo.has(cols[0])) && !groupedTo.has(cols);
  const created = new Set();
  for (const t of order) {
    created.add(t);
    const rowid = D.numberingIsKey ? t.cols.find(c => c.autoInc) : null;
    const unique = new Map(), indexes = [], multi = [];
    for (const c of t.cols.filter(c => c.unique)) {
      const k = take('unique', t.name, c.name);
      if (isIndex([c])) indexes.push({ cols: [c], ...k });
      else unique.set(c, k);
    }
    const pk = t.pkCols.length && !rowid ? take('pk', t.name) : null;
    for (const u of t.multiUniques) (isIndex(u.cols) ? indexes : multi).push({ cols: u.cols, ...take('unique', t.name, u.cols.map(c => c.name).join('_')) });
    const fks = t.cols.filter(c => c.target && leadsFk(c)).map(c =>
      ({ c, later: !created.has(c.target) && !D.fkInline, ...take('fk', t.name, fkCols(c).cols.map(c => c.name).join('_')) }));
    names.set(t, { rowid, unique, indexes, pk, multi, fks });
  }
  return names;
}
// The foreign keys added after their tables: [{ t, c, name }]
const laterKeys = (order, D) => [...constraintNames(order, D)].flatMap(([t, n]) => n.fks.filter(k => k.later).map(k => ({ t, ...k })));

// MariaDB needs an index on the column a foreign key points to. True when a key or index already starts with it.
function hasIndex(t, c) {
  return c.unique || t.pkCols[0] === c || t.multiUniques.some(u => u.cols[0] === c) ||
    (t.indexes ?? []).some(ix => ix.cols[0]?.toLowerCase() === c.name.toLowerCase());
}
// Where D.inlineIndexes (MariaDB) the indexes go inside CREATE TABLE: one a foreign key needs must be there
// before the key is made
function inlineIndexes(t, tables, D) {
  // names MariaDB gives the indexes it makes itself: a UNIQUE or FOREIGN KEY one is named after its first column
  const taken = new Set(['primary', ...t.cols.filter(c => c.unique || c.target).map(c => c.name.toLowerCase()),
    ...t.multiUniques.map(u => u.cols[0].name.toLowerCase())]);
  // a key over several columns the arrows of a group point to is that index already
  const pointedTo = new Set(tables.flatMap(o => o.cols.filter(c => c.target === t && !c.fkGroup).map(c => c.targetCol)));
  const needed = t.cols.filter(c => pointedTo.has(c) && !hasIndex(t, c))
    .map(c => ({ name: shortName(indexName(t.name, [c.name]), D.maxName), cols: [c.name] }));
  for (const ix of needed) taken.add(ix.name.toLowerCase());
  return [...namedIndexes(t, taken, D), ...needed].map(ix => `  INDEX ${D.q(ix.name)} (${ix.cols.map(D.q).join(', ')})`);
}

function genSchema(tables, D) {
  const Q = D.q, T = n => tableSQL(D, n);
  const { order, cyclic } = tablesOf(tables);
  const out = ['-- ' + D.name, ...(D.keysAtStart?.(cyclic) ?? []), ''];
  if (!order.length) return out.join('\n');
  const names = constraintNames(order, D);
  if (cyclic && D.keysOff) out.push(D.keysOff);
  // where D.dropKey, the keys added after their tables go first, or the tables they join can't be dropped
  if (D.dropKey) out.push(...laterKeys(order, D).map(({ t, name }) => D.dropKey(T(t.name), Q(name))));
  out.push(...[...order].reverse().map(t => `DROP TABLE IF EXISTS ${T(t.name)}${D.dropTail ? ' ' + D.dropTail : ''};`), '');
  const deferred = [], indexTaken = new Set();
  for (const t of order) {
    const n = names.get(t), w = colWidth(t, Q);
    const defs = t.cols.map(c => {
      const auto = c.autoInc ? D.autoSQL : '', unique = n.unique.get(c);
      const rest = D.autoAlone && c.autoInc ? auto // Oracle: the identity says the rest
        : (D.defaultFirst ? defaultSQL(c, D) + nullSQL(c) : nullSQL(c) + auto + defaultSQL(c, D)) +
          (unique ? ` ${unique.sql}UNIQUE` : '') + (D.enumCheck ? enumCheckSQL(c, Q) : '');
      return column(c, w, Q, D.type ? D.type(c.effType) : typeSQL(c.effType, D), rest);
    });
    if (n.pk) defs.push(`  ${n.pk.sql}PRIMARY KEY (${keyList(t.pkCols, Q)})`);
    for (const ix of n.indexes) { // after the table, with the keys added later
      indexTaken.add(ix.name.toLowerCase());
      deferred.push(`CREATE UNIQUE INDEX ${Q(ix.name)} ON ${T(t.name)} (${keyList(ix.cols, Q)}) WHERE ${ix.cols.map(c => Q(c.name) + ' IS NOT NULL').join(' AND ')};`);
    }
    for (const u of n.multi) defs.push(`  ${u.sql}UNIQUE (${keyList(u.cols, Q)})`);
    if (D.inlineIndexes) defs.push(...inlineIndexes(t, tables, D));
    for (const k of n.fks) {
      if (k.later) deferred.push(`ALTER TABLE ${T(t.name)} ADD ${fkSQL(k.c, D, k.sql)}${D.deferredTail ?? ''};`);
      else defs.push('  ' + fkSQL(k.c, D, k.sql));
    }
    out.push(`CREATE TABLE ${T(t.name)} (\n${defs.join(',\n')}\n);`, '');
  }
  if (deferred.length) out.push(...deferred, '');
  if (!D.inlineIndexes) { // an index name is for the whole schema
    const skip = D.skipIndexes?.(tables) ?? new Set();
    const indexes = order.flatMap(t => createIndexes({ ...t, indexes: (t.indexes ?? []).filter(ix => !skip.has(ix)) }, indexTaken, D));
    if (indexes.length) out.push(...indexes, '');
  }
  if (cyclic && D.keysOn) out.push(D.keysOn, '');
  return out.join('\n');
}

function mariadbProblems(tables) {
  const problems = links(tables).filter(({ c }) => !isKey(c)).map(({ c }) => problem(c.line,
    `${c.target.name}.${c.targetCol.name} is neither the primary key nor unique. The SQL adds an index on it, but normally it should be unique.`, 'warn'));
  return [...problems, ...keyTypeProblems(tables, DIALECTS.mariadb, isLobType)];
}
const isLobType = t => /(text|blob)$|^json$/.test(typeParts(t).base);

// MySQL 8.4 only links to a key, can't make a key of TEXT, and a key is at most 3072 bytes (768 characters)
function mysqlProblems(tables) {
  const problems = [...keyProblems(tables, 'MySQL'), ...lobKeyProblems(tables, t => !keyable(t, DIALECTS.mysql), 'MySQL'), ...keyTypeProblems(tables, DIALECTS.mysql, isLobType)];
  for (const t of tables) {
    for (const c of t.cols) {
      const { base, args } = typeParts(c.effType);
      if (keyedCol(t, c) && /^(vc|varchar|char)$/.test(base) && +(args ?? DEFAULT_VC) > 768) {
        problems.push(problem(c.line, `MySQL keys are at most 768 characters, and ${c.name} can hold ${args}. Use a shorter vc.`));
      }
    }
  }
  return problems;
}

const postgresProblems = tables => [...keyProblems(tables, 'PostgreSQL'), ...lobKeyProblems(tables, t => !keyable(t, DIALECTS.postgres), 'PostgreSQL'),
  ...keyTypeProblems(tables, DIALECTS.postgres)];

function mssqlProblems(tables) {
  const problems = [...keyProblems(tables, 'SQL Server'), ...lobKeyProblems(tables, t => !keyable(t, DIALECTS.mssql), 'SQL Server'),
    ...keyTypeProblems(tables, DIALECTS.mssql, isMax)];
  for (const t of tables) {
    for (const c of t.cols) {
      const n = +(mssqlType(c.effType).match(/^NVARCHAR\((\d+)\)/)?.[1] ?? 0);
      if (n > 850 && (c.isPk || c.unique)) problems.push(problem(c.line, `SQL Server keys are at most 1700 bytes, and ${c.name} can hold ${2 * n}. Use a shorter vc.`, 'warn'));
    }
  }
  // "may cause cycles or multiple cascade paths": what a delete (or key update) starts may reach each table only once
  for (const action of ['onDelete', 'onUpdate']) {
    const children = t => foreignKeys(tables).filter(({ c }) => c.target === t && /^(cascade|set null)$/.test(c[action] ?? ''));
    const bad = new Map(); // column → its table
    for (const start of tables) {
      const seen = new Set([start]), walk = t => {
        for (const { t: child, c } of children(t)) {
          if (seen.has(child)) { bad.set(c, child); continue; }
          seen.add(child);
          walk(child);
        }
      };
      walk(start);
    }
    for (const [c, t] of bad) {
      problems.push(problem(c.line, `SQL Server refuses [${action === 'onDelete' ? 'delete' : 'update'} ${c[action]}] here: ` +
        `it would reach ${t.name} a second time. Leave it out on one of the paths.`));
    }
  }
  return problems;
}

// ─── Oracle ──────────────────────────────────────────────────────────────────
// Oracle Database 23ai: BOOLEAN, multi-row VALUES and DROP TABLE IF EXISTS are new in it.
// Names are left unquoted (Oracle folds them to upper case) unless they are reserved.
// Text is VARCHAR2(n CHAR), so n is characters, not bytes. A date is written DATE '2024-01-31',
// whatever the session's date format is. There is no TIME type: a time of day is text.

const ORACLE_TYPES = { tinyint: 'NUMBER(3)', smallint: 'NUMBER(5)', mediumint: 'NUMBER(7)', int: 'NUMBER(10)',
  integer: 'NUMBER(10)', bigint: 'NUMBER(19)', serial: 'NUMBER(20)', bool: 'BOOLEAN', boolean: 'BOOLEAN', bit: 'BOOLEAN',
  float: 'BINARY_FLOAT', double: 'BINARY_DOUBLE', real: 'BINARY_DOUBLE', tinytext: 'CLOB', text: 'CLOB', mediumtext: 'CLOB',
  longtext: 'CLOB', set: 'VARCHAR2(255 CHAR)', json: 'JSON', tinyblob: 'BLOB', blob: 'BLOB', mediumblob: 'BLOB',
  longblob: 'BLOB', date: 'DATE', datetime: 'TIMESTAMP', timestamp: 'TIMESTAMP', time: 'VARCHAR2(8 CHAR)', year: 'NUMBER(4)',
  uuid: 'VARCHAR2(36 CHAR)', inet4: 'VARCHAR2(15 CHAR)', inet6: 'VARCHAR2(45 CHAR)', geometry: 'CLOB', point: 'CLOB', linestring: 'CLOB',
  polygon: 'CLOB' };
const ORACLE_UNSIGNED = { int: 'NUMBER(10)', integer: 'NUMBER(10)', bigint: 'NUMBER(20)' };
function oracleType(t) {
  const { base, args, unsigned } = typeParts(t);
  const text = n => n > 4000 ? 'CLOB' : `VARCHAR2(${n} CHAR)`;
  if (base === 'vc' || base === 'varchar') return text(+(args ?? DEFAULT_VC));
  if (base === 'char') return +(args ?? 1) > 2000 ? 'CLOB' : `CHAR(${args ?? 1} CHAR)`;
  if (base === 'enum') return text(Math.max(1, ...enumOptions(t).map(v => v.length)));
  if (/^(decimal|dec|numeric|fixed)$/.test(base)) return `NUMBER(${args ?? 10})`;
  if (base === 'binary' || base === 'varbinary') return `RAW(${Math.min(+(args ?? 1), 2000)})`;
  return (unsigned && ORACLE_UNSIGNED[base]) || ORACLE_TYPES[base] || sqlType(t);
}
const isClob = t => /^(CLOB|BLOB|JSON)$/.test(oracleType(t));

// an index on just what a key already covers is refused ("such column list already indexed")
function oracleSkipIndexes(tables) {
  const skip = new Set();
  for (const t of tables) {
    const keyed = [t.pkCols, ...t.multiUniques.map(u => u.cols), ...t.cols.filter(c => c.unique).map(c => [c])]
      .map(cols => cols.map(c => c.name.toLowerCase()).join());
    for (const ix of t.indexes ?? []) if (keyed.includes(ix.cols.map(n => n.toLowerCase()).join())) skip.add(ix);
  }
  return skip;
}

function oracleProblems(tables) {
  const family = t => oracleType(t).replace(/\(.*\)/, ''); // lengths may differ, CHAR and VARCHAR2 may not
  return [...keyProblems(tables, 'Oracle'), ...lobKeyProblems(tables, isClob, 'Oracle'),
    ...linkTypeProblems(tables, isClob, (a, b) => family(a) === family(b), ". Oracle can't link them."),
    ...links(tables).filter(({ c }) => c.onUpdate).map(({ c }) =>
      problem(c.line, `Oracle has no [update ${c.onUpdate}]: a key isn't meant to change there. Leave it out.`))];
}

// ─── The databases ───────────────────────────────────────────────────────────
// dqIdent: "x" is a name, not a string. backslash: \ escapes in strings.
// The script (genSchema): q quotes a name, schema is the default one tables are named in, type(t) or
// types/native/sizeLimits/varchar/signWords give a column's type (typeSQL), unkeyable the types no key is over, names says how constraints are named (constraintNamer),
// autoSQL numbers a column, noActions are the foreign key actions left unsaid. keysAtStart(cyclic), keysOff and
// keysOn turn the foreign key checks off around a cycle; dropKey(table, name) drops a key before its table,
// dropTail ends DROP TABLE. fkInline: keys to tables made later go in the table too. numberingIsKey: the
// numbered column is the primary key in its own clause. nullUniqueIndex: a unique column that may be null is a
// filtered unique index. inlineIndexes: indexes go inside CREATE TABLE. enumCheck: an enum gets a CHECK.
// autoAlone, defaultFirst, deferredTail, skipIndexes: Oracle's, see genSchema.
// Sample rows (sampleInserts): dataStart/dataEnd go around them, dataTable(t) around each table's.
// What a foreign key's types must be (keyTypesFit): keyLengthsMayDiffer, keyTypeKinds, keyTypeWidenings,
// defaultFraction, and keyTypesNeeded to say it.

const sqlStr = s => `'${s.replace(/'/g, "''")}'`;
const upperBool = b => b ? 'TRUE' : 'FALSE';
const givenNames = (max, scope) => ({ name: givenName, own: [], scope: { pk: scope, unique: scope, fk: scope }, max });
// What most of them have in common; each one says what differs
const COMMON = {
  maxName: 64, dqIdent: true, backslash: false, str: sqlStr, bool: upperBool, today: 'CURRENT_DATE',
  noActions: ['no action'], enumCheck: true, dataStart: () => [], dataEnd: () => [],
};
const MARIADB = {
  ...COMMON, name: 'MariaDB', q: quoter(MARIADB_RESERVED, '`'), dqIdent: false, backslash: true,
  types: MARIADB_TYPES, native: MARIADB_NATIVE, sizeLimits: MARIADB_SIZE_LIMITS, varchar: 'VARCHAR', signWords: true,
  keyLengthsMayDiffer: true, keyTypeKinds: MARIADB_KEY_KINDS, keyTypesNeeded: 'of one type and sign, their sizes aside',
  names: { name: mariadbName, own: ['pk', 'unique'], pk: true, scope: { pk: 'table', unique: 'table', fk: 'schema' }, max: 64 },
  autoSQL: ' AUTO_INCREMENT', noActions: ['no action', 'restrict'], inlineIndexes: true, enumCheck: false,
  keysOff: 'SET FOREIGN_KEY_CHECKS = 0;', keysOn: 'SET FOREIGN_KEY_CHECKS = 1;',
  problems: mariadbProblems, str: s => sqlStr(s.replace(/\\/g, '\\\\')),
  dataStart: () => ['SET FOREIGN_KEY_CHECKS = 0;'], dataEnd: () => ['SET FOREIGN_KEY_CHECKS = 1;'],
};
// The foreign keys PostgreSQL checks at COMMIT while the sample rows go in: those to tables made later
const pgDeferred = (order, how) => laterKeys(order, DIALECTS.postgres).map(({ t, name }) =>
  `ALTER TABLE ${tableSQL(DIALECTS.postgres, t.name)} ALTER CONSTRAINT ${DIALECTS.postgres.q(name)} ${how};`);
const DIALECTS = {
  mariadb: MARIADB,
  mysql: {
    ...MARIADB, name: 'MySQL', q: quoter(MYSQL_RESERVED, '`'), problems: mysqlProblems, native: MYSQL_NATIVE, unkeyable: MYSQL_UNKEYABLE,
    // a default other than a plain value, or on TEXT, BLOB or JSON, is an expression in parentheses
    defaultFor: (c, v) => v === 'CURRENT_DATE' || isLobType(c.effType) ? `(${v})` : v,
  },
  sqlite: {
    ...COMMON, name: 'SQLite', q: quoter(SQLITE_KEYWORDS, '"'), types: SQLITE_TYPES, varchar: 'VARCHAR',
    native: SQLITE_NATIVE, names: givenNames(Infinity, 'table'),
    autoSQL: ' PRIMARY KEY AUTOINCREMENT', numberingIsKey: true, fkInline: true, // tables may point to tables made later
    keysAtStart: cyclic => [cyclic ? 'PRAGMA foreign_keys = OFF;' : 'PRAGMA foreign_keys = ON;'], keysOn: 'PRAGMA foreign_keys = ON;',
    problems: tables => keyProblems(tables, 'SQLite'), // SQLite doesn't compare the types
    dataStart: () => ['PRAGMA foreign_keys = OFF;'], dataEnd: () => ['PRAGMA foreign_keys = ON;'],
  },
  postgres: {
    ...COMMON, name: 'PostgreSQL', q: quoter(POSTGRES_RESERVED, '"', '"', true), schema: 'public', maxName: 63,
    types: PG_TYPES, native: PG_NATIVE, varchar: 'VARCHAR', unkeyable: ['json', 'point', 'polygon', 'xml'],
    keyLengthsMayDiffer: true, keyTypeKinds: PG_KEY_KINDS, keyTypeWidenings: PG_KEY_WIDENINGS,
    keyTypesNeeded: "of one kind, or the first of a type it converts to the second's by itself",
    names: { name: postgresName, own: ['pk', 'unique', 'fk'], scope: { pk: 'schema', unique: 'schema', fk: 'schema' }, max: 63, exact: true },
    autoSQL: ' GENERATED BY DEFAULT AS IDENTITY', dropTail: 'CASCADE', problems: postgresProblems,
    bool: (b, c) => c && /^bit\b/.test(c.effType) ? `B'${b ? 1 : 0}'` : upperBool(b),
    // one transaction, with the keys to tables made later checked at COMMIT, so the rows can go in in any order;
    // then numbering goes on after the sample Ids
    dataStart: (order, cyclic) => [...(cyclic ? pgDeferred(order, 'DEFERRABLE INITIALLY DEFERRED') : []), 'BEGIN;'],
    dataEnd: (order, cyclic) => ['COMMIT;', ...(cyclic ? pgDeferred(order, 'NOT DEFERRABLE') : []), ...order.flatMap(t => t.cols.filter(c => c.autoInc).map(c => {
      const T = tableSQL(DIALECTS.postgres, t.name), Q = DIALECTS.postgres.q;
      return `SELECT setval(pg_get_serial_sequence(${sqlStr(T)}, ${sqlStr(c.name)}), COALESCE(MAX(${Q(c.name)}), 0) + 1, false) FROM ${T};`;
    }))],
  },
  mssql: {
    ...COMMON, name: 'SQL Server', q: quoter(MSSQL_RESERVED, '[', ']'), schema: 'dbo', maxName: 128, nPrefix: true,
    types: MSSQL_TYPES, native: ['geometry', 'money', 'xml', 'rowversion'], sizeLimits: MSSQL_SIZE_LIMITS, varchar: 'NVARCHAR',
    unkeyable: [...TEXT_TYPES, 'json', ...BLOB_TYPES, 'xml', 'geometry'], names: givenNames(128, 'schema'),
    defaultFraction: { size: '(7)', types: ['TIME', 'DATETIMEOFFSET', 'DATETIME2'] }, keyTypesNeeded: 'of the same type and size',
    autoSQL: ' IDENTITY(1,1)', noActions: ['no action', 'restrict'], nullUniqueIndex: true, problems: mssqlProblems,
    dropKey: (T, name) => `IF OBJECT_ID(N'${T}', N'U') IS NOT NULL ALTER TABLE ${T} DROP CONSTRAINT IF EXISTS ${name};`,
    str: s => 'N' + sqlStr(s), bool: b => b ? '1' : '0', today: 'CAST(GETDATE() AS DATE)',
    bin: s => `CONVERT(VARBINARY(MAX), ${sqlStr(s)})`, // text doesn't turn into bytes by itself here
    dataStart: (order, cyclic) => cyclic ? order.map(t => `ALTER TABLE ${tableSQL(DIALECTS.mssql, t.name)} NOCHECK CONSTRAINT ALL;`) : [],
    dataEnd: (order, cyclic) => cyclic ? order.map(t => `ALTER TABLE ${tableSQL(DIALECTS.mssql, t.name)} WITH CHECK CHECK CONSTRAINT ALL;`) : [],
    // sample rows give their own Ids
    dataTable: t => t.cols.some(c => c.autoInc) ? [[`SET IDENTITY_INSERT ${tableSQL(DIALECTS.mssql, t.name)} ON;`], [`SET IDENTITY_INSERT ${tableSQL(DIALECTS.mssql, t.name)} OFF;`]] : [[], []],
  },
  oracle: {
    ...COMMON, name: 'Oracle', q: quoter(ORACLE_RESERVED, '"'), maxName: 128,
    type: oracleType, problems: oracleProblems, dropTail: 'CASCADE CONSTRAINTS', defaultFirst: true, skipIndexes: oracleSkipIndexes,
    // the identity says the rest; a key to a table made later is checked at COMMIT, so sample rows can go in in any order
    autoSQL: ' GENERATED BY DEFAULT AS IDENTITY', autoAlone: true, deferredTail: ' DEFERRABLE INITIALLY DEFERRED',
    noActions: ['no action', 'restrict'], // what it does anyway
    today: 'TRUNC(SYSDATE)',
    typed: (c, s) => /^date\b/.test(c.effType) ? `DATE ${sqlStr(s)}` : /^(datetime|timestamp)\b/.test(c.effType) ? `TIMESTAMP ${sqlStr(s)}` : undefined,
    bin: s => `UTL_RAW.CAST_TO_RAW(${sqlStr(s)})`,
    // one transaction, so keys to tables made later are checked at the end; then numbering goes on after the sample Ids
    dataEnd: order => ['COMMIT;', ...order.flatMap(t => t.cols.filter(c => c.autoInc).map(c =>
      `ALTER TABLE ${DIALECTS.oracle.q(t.name)} MODIFY ${DIALECTS.oracle.q(c.name)} GENERATED BY DEFAULT AS IDENTITY (START WITH LIMIT VALUE);`))],
  },
};
const dialectOf = d => DIALECTS[d] ?? DIALECTS.mariadb;

function genSQL(tables, dialect = 'mariadb') { return genSchema(tables, dialectOf(dialect)); }
// What the database refuses (or warns about) in the diagram, and what the script writes otherwise
function dialectProblems(tables, dialect = 'mariadb') {
  const D = dialectOf(dialect);
  return [...D.problems(tables), ...standInNotes(tables, D), ...shapelessNotes(tables)];
}

// A type the database hasn't, written as the one that stands in for it (standIn), or an unsigned number as the
// next size up, said as jaidb's notes say it. A warning: the script is written all the same.
function standInNotes(tables, D) {
  if (D.type) return []; // Oracle's types are its own
  const standsIn = t => { const { base, unsigned } = typeParts(t); return standIn(t, D) || (unsigned && D.types?.[base]?.[1]); };
  return tables.flatMap(t => t.cols.filter(c => c.effType && standsIn(c.effType)).map(c =>
    problem(c.line, `${D.name} has no ${c.effType} type: ${t.name}.${c.name} is ${typeSQL(c.effType, D)}`, 'warn')));
}

// Made-up rows have no map shapes (SPATIAL): such a column is NULL in them, and a table where one can't be gets none
const shapeColumn = t => t.cols.find(c => !c.nullable && SPATIAL.includes(typeParts(c.effType ?? 'vc').base));
const shapelessNotes = tables => tables.filter(t => t.cols.length && shapeColumn(t)).map(t => { const c = shapeColumn(t);
  return problem(c.line, `${t.name} gets no sample rows: ${c.name} is ${c.effType} and can't be null, and made-up rows have no shapes`, 'warn'); });
