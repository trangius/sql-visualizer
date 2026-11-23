'use strict';

// Checks the generated SQL: every example and the schemas below are turned into a script for
// each database, with sample data, and run where a client is found (a database named
// sqlviz_check is made and dropped for each script):
//   MariaDB     MYSQL=path/to/mysql, otherwise mysql or mariadb on the PATH, or XAMPP's; MYSQL_USER (root)
//   MySQL       MYSQL8=path/to/its mysql and MYSQL8_SOCKET, as root without a password
//   SQLite      sqlite3, in memory
//   PostgreSQL  psql, as the current user
//   SQL Server  sqlcmd (or /opt/mssql-tools18/bin/sqlcmd) as sa, with the password in SQLCMDPASSWORD
//   Oracle      SQLPLUS=path/to/sqlplus, as SYSTEM with the password in ORACLE_PWD, on //localhost/FREEPDB1;
//               each script runs as a new user, sqlviz_check
// What a database would refuse must be reported as a problem instead. Reading a generated
// script back and writing it again must give the same script, and for MariaDB and SQLite
// the same Simple text. test/linux-setup.sh installs five of them on Ubuntu, test/oracle-setup.sh
// Oracle on Oracle Linux.
// Run: node test/sql-check.js

const fs = require('fs'), path = require('path'), vm = require('vm'), { spawnSync } = require('child_process');

// Simple syntax or SQL (MariaDB's unless a third item says which), and the problem it must
// report, if any: the same for every database, or { mariadb, sqlite, postgres, mssql }
const CASES = {
  'indexes': [`Order
  Id
  CustomerId int index
  Created datetime
  Total int
  index (CustomerId, Created, Total)
  index (Total)  # also the index line over one column
`],
  // a foreign key may point at a column that is no key where an index begins with it: on MariaDB (and MySQL before 8.4)
  'fk to an indexed column': [`Owner
  Id
  Email vc(100) index
  Name
  Phone vc(20)
  index (Name, Phone)
Pet
  Id
  OwnerEmail vc(100) -> Owner.Email [delete cascade]
  OwnerName -> Owner.Name
`, Object.fromEntries(['mysql', 'sqlite', 'postgres', 'mssql', 'oracle'].map(d => [d, 'points no foreign key at Owner.Email, which is no key: make it the primary key or unique']))],
  'fk to a column without an index': [`Owner
  Id
  Email
Pet
  Id
  OwnerEmail -> Owner.Email
`, 'A foreign key needs Owner.Email to be the primary key or unique'],
  'index over a text column': [`Note
  Id
  Body text index
`, { mariadb: "MariaDB can't make an index over Body (text). Use varchar(n) instead", mysql: "MySQL can't make an index over Body (text). Use varchar(n) instead",
    mssql: "SQL Server can't make an index over Body (text). Use varchar(n) instead", oracle: "Oracle can't make an index over Body (text). Use varchar(n) instead" }],
  'index over a long vc': [`Note
  Id
  Title vc(1000)
  index (Title, Id)
`, { mariadb: "MariaDB can't make an index over Title (vc(1000)). Use a shorter varchar(n)", mysql: "MySQL can't make an index over Title (vc(1000)). Use a shorter varchar(n)" }],
  // names cut to the database's length are numbered where they meet: each database keeps them apart
  'long index names': [`AVeryLongTableNameThatGoesOnAndOnAndOnForeverAndEver
  Id
  AnotherExtremelyLongColumnNameNumberOne int index
  AnotherExtremelyLongColumnNameNumberTwo int index
  index (AnotherExtremelyLongColumnNameNumberTwo, AnotherExtremelyLongColumnNameNumberOne)
`],
  'fk to the second column of a key': [`OrderLine
  OrderNo int
  LineNo int
  pk (OrderNo, LineNo)
Shipment
  Id
  LineNo -> OrderLine.LineNo
`, 'A foreign key needs OrderLine.LineNo to be the primary key or unique'],
  // arrows to every column of a key over several columns are one foreign key: Return's is added after the
  // tables (they point at each other), Refund's is to a unique (…)
  'fk over keys of several columns': [`Return
  Id
  OrderId -> ProductToOrder.OrderId [delete cascade]
  VariantId -> ProductToOrder.VariantId [delete cascade]
  Code vc(10)
  Batch int
  unique (Code, Batch)
ProductToOrder
  OrderId int
  VariantId int
  Quantity int
  LastReturnId null -> Return
  pk (OrderId, VariantId)
Refund
  Id
  ReturnBatch int null -> Return.Batch
  ReturnCode vc(10) null -> Return.Code
`],
  'fk to some columns of a key': [`Shelf
  Aisle int
  Bay int
  Level int
  pk (Aisle, Bay, Level)
Box
  Id
  Aisle -> Shelf.Aisle
  Bay -> Shelf.Bay
`, { mariadb: 'A foreign key needs Shelf.Bay', mysql: 'MySQL points no foreign key at Shelf.Aisle', sqlite: 'SQLite points no foreign key at Shelf.Aisle',
    postgres: 'PostgreSQL points no foreign key at Shelf.Aisle', mssql: 'SQL Server points no foreign key at Shelf.Aisle', oracle: 'Oracle points no foreign key at Shelf.Aisle' }],
  // Room and Number are one foreign key; Spare, left over, is one of its own
  'fk to a key column once more': [`Seat
  Room int
  Number int
  pk (Room, Number)
Ticket
  Id
  Room -> Seat.Room
  Number -> Seat.Number
  Spare -> Seat.Number
`, 'A foreign key needs Seat.Number to be the primary key or unique'],
  // two foreign keys to one key: the first arrow to each of its columns, then the next
  'two fks to one key': [`City
  Name vc(40)
  Country char(2)
  Population int
  pk (Name, Country)
Route
  Id
  FromName -> City.Name [delete cascade]
  FromCountry -> City.Country [delete cascade]
  ToName null -> City.Name
  ToCountry null -> City.Country
  Km int
`],
  'two fks to one key, interleaved': [`City
  Name vc(40)
  Country char(2)
  Population int
  pk (Name, Country)
Route
  Id
  FromName -> City.Name [delete cascade]
  ToName null -> City.Name
  FromCountry -> City.Country [delete cascade]
  ToCountry null -> City.Country
  Km int
`],
  // a delete in City reaches Route by both
  'two cascading fks to one key': [`City
  Name vc(40)
  Country char(2)
  pk (Name, Country)
Route
  Id
  FromName -> City.Name [delete cascade]
  FromCountry -> City.Country [delete cascade]
  ToName -> City.Name [delete cascade]
  ToCountry -> City.Country [delete cascade]
`, { mssql: 'SQL Server refuses [delete cascade] here: it would reach Route a second time' }],
  'fk over a key with other actions': [`Line
  OrderNo int
  LineNo int
  pk (OrderNo, LineNo)
Note
  Id
  OrderNo -> Line.OrderNo [delete cascade]
  LineNo -> Line.LineNo [update cascade]
`, 'OrderNo and LineNo point at Line (OrderNo, LineNo) together, as one foreign key: write the same [delete …] and [update …] on both'],
  'fk over a key of another type': [`Line
  OrderNo int
  LineNo smallint
  pk (OrderNo, LineNo)
Note
  Id
  OrderNo -> Line.OrderNo
  LineNo int -> Line.LineNo
`, { mariadb: 'LineNo is int but Line.LineNo is smallint', mysql: 'LineNo is int but Line.LineNo is smallint', mssql: "SQL Server needs a foreign key's columns of the same type and size" }],
  'fk of another integer type': [`Owner
  Id
Pet
  Id
  OwnerId bigint -> Owner
`, { mariadb: 'OwnerId is bigint but Owner.Id is int', mysql: 'OwnerId is bigint but Owner.Id is int', mssql: "SQL Server needs a foreign key's columns of the same type and size" }],
  'fk of another sign': [`Owner
  Code int unsigned pk
Pet
  Id
  OwnerCode int -> Owner
`, { mariadb: 'OwnerCode is int but Owner.Code is int unsigned', mysql: 'OwnerCode is int but Owner.Code is int unsigned', mssql: "SQL Server needs a foreign key's columns of the same type and size" }],
  'fk to a text column': [`Tag
  Id
  Body text unique
Note
  Id
  TagBody -> Tag.Body
`, { mariadb: "Tag.Body is text, which can't be part of a foreign key", mysql: "MySQL can't make a unique key over Body (text). Use varchar(n) instead",
    oracle: "Oracle can't make a unique key over Body (text)", mssql: "SQL Server can't make a unique key over Body (text)" }],
  'fk between strings of different lengths': [`Country
  Code char(2) pk
City
  Id
  Country vc(2) -> Country
`, { mssql: "SQL Server needs a foreign key's columns of the same type and size", oracle: "Oracle can't link them" }],
  // as jaidb's key_types_fit says, which the servers bore out: MariaDB and MySQL join decimals of any size and a
  // DATETIME to a TIMESTAMP; PostgreSQL a number to a wider kind of number and a date to a timestamp, not the other way
  'fk between decimals of two precisions': [`Item
  Id
  Price decimal(10,2) unique
Offer
  Id
  Price decimal(8,2) -> Item.Price
`, { mssql: "Price is decimal(8,2) but Item.Price is decimal(10,2): SQL Server needs a foreign key's columns of the same type and size" }],
  'fk from a datetime to a timestamp': [`Event
  Id
  At timestamp unique
Reminder
  Id
  EventAt datetime -> Event.At
`],
  'fk to a wider kind of number': [`Measure
  Id
  Whole decimal(10,2) unique
  Exact double unique
  Single double unique
Reading
  Id
  Whole int -> Measure.Whole
  Exact int -> Measure.Exact
  Single real -> Measure.Single
`, { mariadb: "Whole is int but Measure.Whole is decimal(10,2): MariaDB needs a foreign key's columns of one type and sign, their sizes aside", mysql: "Whole is int but Measure.Whole is decimal(10,2): MySQL needs a foreign key's columns of one type and sign, their sizes aside",
    mssql: "Single is real but Measure.Single is double: SQL Server needs a foreign key's columns of the same type and size", oracle: "Exact is int but Measure.Exact is double. Oracle can't link them" }],
  'fk from a date to a timestamp': [`Event
  Id
  At timestamp unique
Reminder
  Id
  EventDay date -> Event.At
`, { mariadb: "EventDay is date but Event.At is timestamp: MariaDB needs a foreign key's columns of one type and sign, their sizes aside", mysql: "EventDay is date but Event.At is timestamp: MySQL needs a foreign key's columns of one type and sign, their sizes aside",
    mssql: "EventDay is date but Event.At is timestamp: SQL Server needs a foreign key's columns of the same type and size", oracle: "EventDay is date but Event.At is timestamp. Oracle can't link them" }],
  'fk from a decimal to an int': [`Owner
  Id
Pet
  Id
  OwnerId decimal(10,2) -> Owner
`, { mariadb: "OwnerId is decimal(10,2) but Owner.Id is int: MariaDB needs a foreign key's columns of one type and sign, their sizes aside", mysql: "OwnerId is decimal(10,2) but Owner.Id is int: MySQL needs a foreign key's columns of one type and sign, their sizes aside",
    postgres: "OwnerId is decimal(10,2) but Owner.Id is int: PostgreSQL needs a foreign key's columns of one kind, or the first of a type it converts to the second's by itself", mssql: "OwnerId is decimal(10,2) but Owner.Id is int: SQL Server needs a foreign key's columns of the same type and size" }],
  'fk from a double to a decimal': [`Item
  Id
  Price decimal(10,2) unique
Offer
  Id
  Price double -> Item.Price
`, { mariadb: "Price is double but Item.Price is decimal(10,2): MariaDB needs a foreign key's columns of one type and sign, their sizes aside", mysql: "Price is double but Item.Price is decimal(10,2): MySQL needs a foreign key's columns of one type and sign, their sizes aside",
    postgres: "Price is double but Item.Price is decimal(10,2): PostgreSQL needs a foreign key's columns of one kind, or the first of a type it converts to the second's by itself", mssql: "Price is double but Item.Price is decimal(10,2): SQL Server needs a foreign key's columns of the same type and size", oracle: "Oracle can't link them" }],
  'delete, update and default': [`Owner
  Id
  Name vc(50) [default 'Anna ''Ann'' #1']  # comment
  Code char(2) unique
Pet
  Id
  OwnerId -> Owner [delete cascade]
  OwnerCode null -> Owner.Code [delete set null, update cascade]
  Born date [default now]
  Added datetime [default now]
  Weight decimal(5,2) [default -1.50]
  Alive bool [default true]
  Tag vc(20) null [default null]
`, { mssql: 'SQL Server refuses [delete set null] here', oracle: 'Oracle has no [update cascade]' }],
  'cascades': [`Owner
  Id
  Name
Pet
  Id
  OwnerId -> Owner [delete cascade, update cascade]
  Born date [default now]
Visit
  Id
  PetId -> Pet [delete cascade]
  At datetime [default now]
  Paid bool [default false]
  Fee decimal(6,2) [default 0]
`, { oracle: 'Oracle has no [update cascade]' }],
  'cascade to itself': [`Person
  Id
  ParentId null -> Person [delete set null]
`, { mssql: 'SQL Server refuses [delete set null] here' }],
  'every type': [`Thing
  Id
  A tinyint
  B smallint
  C mediumint
  D bigint
  E int unsigned
  F decimal(8,2)
  G float
  H double
  I bool
  J char(3)
  K vc(40)
  L text
  M date
  N datetime
  O timestamp
  P time
  Q year
  R enum('x','y')
  S json null
  T uuid null
  U blob null
  V bit
  W vc(5000) null
`],
  'unique columns that may be null': [`Person
  Id
  Email vc(60) null unique
  Code vc(5) null
  Nick vc(20) null
  unique (Code, Nick)
`],
  'set null on a column that is not null': [`Owner
  Id
Pet
  Id
  OwnerId -> Owner [delete set null]
`, 'delete set null needs OwnerId to be null'],
  'default text without quotes': [`Pet
  Id
  Kind vc [default dog]  # 'a' comment
`, "Write text in quotes: [default 'dog']"],
  'delete without a foreign key': [`Pet
  Id
  Name [delete cascade]
`, 'is for a foreign key'],
  'enum keeps its case': [`Shirt
  Id
  Size enum('Small','Large')
`],
  'stand-in types and shapes': [`Place
  Id
  Name
  Kind enum('Shop','Cafe','Museum')
  Spot point null
Route
  Id
  Path linestring
  PlaceId null -> Place
`],
  'long names': [`AVeryLongTableNameThatGoesOnAndOnAndOnForever
  Id
  AnotherExtremelyLongColumnNameNumberOne int
  AnotherExtremelyLongColumnNameNumberTwo int
  unique (AnotherExtremelyLongColumnNameNumberOne, AnotherExtremelyLongColumnNameNumberTwo)
Other
  Id
  Ref int -> AVeryLongTableNameThatGoesOnAndOnAndOnForever.AnotherExtremelyLongColumnNameNumberTwo
`, 'A foreign key needs AVeryLongTableNameThatGoesOnAndOnAndOnForever.AnotherExtremelyLongColumnNameNumberTwo to be the primary key or unique'],
  'keywords as names': [`Order
  Id
  Group vc(20) unique
  Select int
  Values text null
Index
  Id
  OrderGroup vc(20) -> Order.Group
`],
  'cycle': [`Person
  Id
  BestFriendId null -> Person
  HomeId null -> House
House
  Id
  OwnerId -> Person
`],
  'indexes named like keys': [`CREATE TABLE P (Id INT PRIMARY KEY);
CREATE TABLE Q (Id INT PRIMARY KEY, Email VARCHAR(50) UNIQUE, Name VARCHAR(50), PId INT,
  FOREIGN KEY (PId) REFERENCES P(Id), KEY Email (Email, Name), KEY PId (Name),
  INDEX (Name, Email));
CREATE INDEX AVeryLongIndexNameThatGoesOnAndOnAndOnForeverAndEverAndEverAndEver ON Q (Name, PId);`],
  'phpMyAdmin dump': [`CREATE TABLE Teacher (Id int(11) NOT NULL, Name varchar(100) NOT NULL) ENGINE=InnoDB;
CREATE TABLE Course (Id int(11) NOT NULL, Name varchar(100) NOT NULL, TeacherId int(11) NOT NULL) ENGINE=InnoDB;
ALTER TABLE Teacher ADD PRIMARY KEY (Id);
ALTER TABLE Course ADD PRIMARY KEY (Id), ADD KEY TeacherId (TeacherId);
ALTER TABLE Course ADD CONSTRAINT course_ibfk_1 FOREIGN KEY (TeacherId) REFERENCES Teacher (Id);`],
  'SQLite script': [`PRAGMA foreign_keys = ON;
CREATE TABLE IF NOT EXISTS "Author" ("Id" INTEGER PRIMARY KEY AUTOINCREMENT, [Name] TEXT NOT NULL, "Note", Born DATE DEFAULT CURRENT_DATE);
CREATE TABLE "Order" (Id INTEGER PRIMARY KEY, "Group" TEXT NOT NULL CHECK ("Group" IN ('a', 'b''c')), AuthorId INTEGER REFERENCES Author(Id) ON DELETE CASCADE) WITHOUT ROWID;
CREATE INDEX ix_name ON Author (Name);
CREATE INDEX ix_name2 ON "Order" (AuthorId);`, { mariadb: "MariaDB can't make an index over Name (text)", oracle: "Oracle can't make an index over Name (text)",
    mysql: "MySQL can't make an index over Name (text)", mssql: "SQL Server can't make an index over Name (text)" }, 'sqlite'],
  'PostgreSQL script': [`SET statement_timeout = 0;
SELECT pg_catalog.set_config('search_path', '', false);
CREATE TABLE public.author (
    id integer NOT NULL GENERATED BY DEFAULT AS IDENTITY,
    name character varying(100) NOT NULL,
    bio text,
    born date DEFAULT CURRENT_DATE,
    active boolean DEFAULT true NOT NULL,
    data jsonb
);
ALTER TABLE public.author OWNER TO postgres;
ALTER TABLE ONLY public.author ADD CONSTRAINT author_pkey PRIMARY KEY (id);
CREATE TABLE public.book (
    id serial PRIMARY KEY,
    title character varying(200) NOT NULL,
    author_id integer REFERENCES public.author(id) ON DELETE CASCADE,
    price numeric(8,2) DEFAULT 0.00,
    added timestamp with time zone DEFAULT now(),
    weight double precision
);
CREATE INDEX book_title_idx ON public.book USING btree (title);`, null, 'postgres'],
  'SQL Server script': [`SET ANSI_NULLS ON
GO
CREATE TABLE [dbo].[Customer](
	[Id] [int] IDENTITY(1,1) NOT NULL,
	[Name] [nvarchar](100) NOT NULL,
	[Email] [nvarchar](200) NULL,
	[Created] [datetime2](7) NOT NULL,
	[Vip] [bit] NOT NULL,
 CONSTRAINT [PK_Customer] PRIMARY KEY CLUSTERED ([Id] ASC) WITH (PAD_INDEX = OFF) ON [PRIMARY]
) ON [PRIMARY]
GO
CREATE TABLE [dbo].[Order](
	[Id] [int] IDENTITY(1,1) NOT NULL,
	[CustomerId] [int] NOT NULL,
	[Note] [nvarchar](max) NULL,
	[Total] [money] NOT NULL,
 CONSTRAINT [PK_Order] PRIMARY KEY CLUSTERED ([Id] ASC)
) ON [PRIMARY] TEXTIMAGE_ON [PRIMARY]
GO
ALTER TABLE [dbo].[Customer] ADD  CONSTRAINT [DF_Customer_Created]  DEFAULT (getdate()) FOR [Created]
GO
ALTER TABLE [dbo].[Customer] ADD  DEFAULT ((0)) FOR [Vip]
GO
ALTER TABLE [dbo].[Order]  WITH CHECK ADD  CONSTRAINT [FK_Order_Customer] FOREIGN KEY([CustomerId])
REFERENCES [dbo].[Customer] ([Id])
ON DELETE CASCADE
GO
ALTER TABLE [dbo].[Order] CHECK CONSTRAINT [FK_Order_Customer]
GO`, null, 'mssql'],
};

function findClient() {
  for (const c of [process.env.MYSQL, 'mysql', 'mariadb', '/Applications/XAMPP/xamppfiles/bin/mysql'].filter(Boolean)) {
    if (!spawnSync(c, ['--version']).error) return c;
  }
  return null;
}
const has = c => !spawnSync(c, ['-?']).error;
const sqlcmd = ['sqlcmd', '/opt/mssql-tools18/bin/sqlcmd'].find(has);
const client = findClient(), sqlite = has('sqlite3'), psql = has('psql'), user = process.env.MYSQL_USER ?? 'root';
const db = sql => spawnSync(client, ['-u' + user, '--batch'], { input: sql, encoding: 'utf8' }); // a password goes in MYSQL_PWD

const ctx = require('./load')();
const DIALECTS = vm.runInContext('DIALECTS', ctx), DBS = Object.keys(DIALECTS), NAME = d => DIALECTS[d].name;
// The foreign keys over several columns of some CASES: [table, its columns, the table they point at, its columns,
// added after the tables]
const ROUTE = [['Route', ['FromName', 'FromCountry'], 'City', ['Name', 'Country'], false], ['Route', ['ToName', 'ToCountry'], 'City', ['Name', 'Country'], false]];
const COMBINED = {
  'fk over keys of several columns': [['Return', ['OrderId', 'VariantId'], 'ProductToOrder', ['OrderId', 'VariantId'], true],
    ['Refund', ['ReturnCode', 'ReturnBatch'], 'Return', ['Code', 'Batch'], false]],
  'two fks to one key': ROUTE, 'two fks to one key, interleaved': ROUTE,
};
// The indexes of some CASES: [table, its columns]. Each is named IX_Table_Columns, in its CREATE TABLE where the
// database makes it there (MariaDB's and MySQL's), else made right after its table.
const INDEXED = { 'indexes': [['Order', ['CustomerId']], ['Order', ['CustomerId', 'Created', 'Total']], ['Order', ['Total']]],
  'fk to an indexed column': [['Owner', ['Email']], ['Owner', ['Name', 'Phone']]] };
// Types written another way, read back as others: uuid is CHAR(36) in MariaDB, every integer INTEGER in SQLite
const LOSSY = { 'every type': DBS, 'fk of another integer type': ['sqlite'], 'fk of another sign': ['sqlite'], 'fk over a key of another type': ['sqlite'] };
const parse = vm.runInContext(`(src, sql, dialect) => {
  const r = sql ? parseSQL(src, dialect) : parseText(src);
  r.problems.push(...resolve(r.tables), ...dialectProblems(r.tables, dialect));
  return r;
}`, ctx);
const toText = vm.runInContext('(sql, dialect) => sqlToText(sql, false, dialect)', ctx);
const regen = vm.runInContext('(sql, dialect) => { const r = parseSQL(sql, dialect); resolve(r.tables); return genSQL(r.tables, dialect); }', ctx);
const textOf = vm.runInContext('(src) => { const r = parseText(src); resolve(r.tables); return genText(r.tables, []); }', ctx);
const strip = t => t.replace(/#.*$/gm, '').replace(/[ \t]+$/gm, '').trim().split(/\n\n+/).sort().join('\n\n'); // the SQL orders tables by their keys

// Runs a script in a fresh database; { status, out } with what went wrong
const tmp = path.join(require('os').tmpdir(), 'sqlviz_check.sql');
const RUN = {
  mariadb: script => db(`DROP DATABASE IF EXISTS sqlviz_check; CREATE DATABASE sqlviz_check; USE sqlviz_check;\n${script}\nDROP DATABASE sqlviz_check;`),
  mysql: script => spawnSync(process.env.MYSQL8, ['-uroot', '--socket=' + process.env.MYSQL8_SOCKET, '--batch'], { input:
    `DROP DATABASE IF EXISTS sqlviz_check; CREATE DATABASE sqlviz_check; USE sqlviz_check;\n${script}\nDROP DATABASE sqlviz_check;`, encoding: 'utf8' }),
  sqlite: script => spawnSync('sqlite3', ['-bail', ':memory:'], { input: script + '\nPRAGMA foreign_key_check;\n', encoding: 'utf8' }),
  postgres: script => {
    const env = { ...process.env, PGOPTIONS: '-c client_min_messages=warning' }; // not the NOTICEs of DROP TABLE IF EXISTS
    const ps = (d, input) => spawnSync('psql', ['-X', '-q', '-v', 'ON_ERROR_STOP=1', '-d', d], { input, encoding: 'utf8', env });
    const made = ps('postgres', 'DROP DATABASE IF EXISTS sqlviz_check;\nCREATE DATABASE sqlviz_check;\n');
    return made.status ? made : ps('sqlviz_check', script);
  },
  mssql: script => {
    const sc = args => spawnSync(sqlcmd, ['-S', 'localhost', '-U', 'sa', '-C', '-b', '-I', '-l', '60', '-f', '65001', ...args], { encoding: 'utf8' });
    const made = sc(['-Q', "IF DB_ID('sqlviz_check') IS NOT NULL DROP DATABASE sqlviz_check; CREATE DATABASE sqlviz_check;"]);
    if (made.status) return made;
    fs.writeFileSync(tmp, script);
    const res = sc(['-d', 'sqlviz_check', '-i', tmp]);
    return { status: res.status, stderr: res.status ? res.stdout + res.stderr : '' }; // sqlcmd writes its errors to stdout
  },
  oracle: script => {
    const at = '@//localhost:1521/FREEPDB1', pw = process.env.ORACLE_PWD;
    // DEFINE OFF: & in the sample data is text, not a variable to ask for
    const sp = (login, input) => spawnSync(process.env.SQLPLUS, ['-S', '-L', login], { encoding: 'utf8',
      input: `SET DEFINE OFF\nWHENEVER SQLERROR EXIT FAILURE\n${input}\nEXIT\n`, env: { ...process.env, NLS_LANG: '.AL32UTF8' } });
    const made = sp(`system/${pw}${at}`, `DROP USER IF EXISTS sqlviz_check CASCADE;\nCREATE USER sqlviz_check IDENTIFIED BY "${pw}" QUOTA UNLIMITED ON USERS;\nGRANT CREATE SESSION, CREATE TABLE, CREATE SEQUENCE TO sqlviz_check;`);
    const res = made.status ? made : sp(`sqlviz_check/"${pw}"${at}`, script);
    return { status: res.status, stderr: res.status ? res.stdout + res.stderr : '' }; // sqlplus writes its errors to stdout
  },
};

(async () => {
  let failures = 0;
  const fail = (where, msg) => { failures++; console.log('FAIL', where + ':', msg); };
  const ping = client && db('SELECT 1');
  const run = { mariadb: ping && !ping.status, mysql: !!process.env.MYSQL8 && has(process.env.MYSQL8), sqlite, postgres: psql, mssql: !!sqlcmd && !!process.env.SQLCMDPASSWORD,
    oracle: !!process.env.SQLPLUS && !!process.env.ORACLE_PWD };
  for (const d of DBS) if (!run[d]) console.log(`${NAME(d)}: no server or client found, its scripts are only generated, not run.`);
  const only = process.argv[2]; // a part of a schema's name, to check just those
  const all = Object.fromEntries(Object.entries({ ...Object.fromEntries(Object.entries(vm.runInContext('EXAMPLES', ctx)).map(([k, v]) => [k, [v]])), ...CASES })
    .filter(([k]) => !only || k.includes(only)));
  for (const [name, [src, expects, from = 'mariadb']] of Object.entries(all)) {
    const sql = /^\s*(CREATE|PRAGMA|SET)\b/i.test(src);
    for (const dialect of DBS) {
      const where = `${name} (${NAME(dialect)})`, expect = typeof expects === 'string' ? expects : expects?.[dialect];
      // SQL is read as written, then written for each database
      const r = parse(src, sql, sql ? from : dialect);
      if (sql && from !== dialect) r.problems.push(...vm.runInContext('dialectProblems', ctx)(r.tables, dialect));
      const errors = r.problems.filter(p => p.level === 'error').map(p => p.msg);
      if (expect) {
        if (!errors.some(m => m.includes(expect))) fail(where, `expected the problem "${expect}", got ${JSON.stringify(errors)}`);
        continue;
      }
      if (errors.length) { fail(where, 'unexpected problems ' + JSON.stringify(errors)); continue; }
      const schema = ctx.genSQL(r.tables, dialect), script = schema + '\n' + await ctx.sampleInserts(r.tables, dialect);
      if (regen(schema, dialect) !== schema) fail(where, 'reading the script and writing it again changed it:\n' + regen(schema, dialect));
      if (!sql && ['mariadb', 'mysql', 'sqlite'].includes(dialect) && !LOSSY[name]?.includes(dialect) && strip(toText(schema, dialect)) !== strip(textOf(src))) {
        fail(where, 'SQL and back changed it:\n' + toText(schema, dialect));
      }
      if (name === 'enum keeps its case' && !/'Small','Large'/.test(script)) fail(where, 'enum values changed case');
      if (COMBINED[name]) {
        // one FOREIGN KEY for each key's arrows, in the key's order, named after all its columns where the script
        // names it; added after the tables where its table is made first (SQLite's in the table all the same); no
        // warning about them, and no index of MariaDB's on the columns they point at
        const D = DIALECTS[dialect], T = n => (D.schema ? D.q(D.schema) + '.' : '') + D.q(n), list = cols => cols.map(D.q).join(', ');
        const said = r.problems.map(p => p.msg);
        if (said.length) fail(where, 'problems ' + JSON.stringify(said));
        for (const [from, cols, to, tcols, later] of COMBINED[name]) {
          const named = D.names && !D.names.own.includes('fk') ? `CONSTRAINT ${D.q(`FK_${from}_${cols.join('_')}`)} ` : '';
          const fk = `${named}FOREIGN KEY (${list(cols)}) REFERENCES ${T(to)}(${list(tcols)})`, line = schema.split('\n').find(l => l.includes(fk));
          if (!line) fail(where, `no ${fk}`);
          else if ((later && !D.fkInline) !== line.startsWith(`ALTER TABLE ${T(from)} ADD `)) fail(where, `${from}'s key ${later ? 'not ' : ''}added after the tables: ${line}`);
        }
        if (/\bINDEX\b/.test(schema)) fail(where, 'an index for a key over several columns');
      }
      if (INDEXED[name]) {
        const D = DIALECTS[dialect], T = n => (D.schema ? D.q(D.schema) + '.' : '') + D.q(n), list = cols => cols.map(D.q).join(', ');
        const lines = schema.split('\n');
        for (const [table, cols] of INDEXED[name]) {
          const ix = D.q(`IX_${table}_${cols.join('_')}`), start = lines.indexOf(`CREATE TABLE ${T(table)} (`), end = lines.indexOf(');', start);
          let after = end + 1;
          while (lines[after]?.startsWith('CREATE INDEX ')) after++;
          const ok = D.inlineIndexes ? lines.slice(start, end).some(l => l.replace(/,$/, '') === `  INDEX ${ix} (${list(cols)})`)
            : lines.slice(end + 1, after).includes(`CREATE INDEX ${ix} ON ${T(table)} (${list(cols)});`);
          if (start < 0 || !ok) fail(where, `no index ${ix} over (${cols.join(', ')}) ${D.inlineIndexes ? 'in' : 'right after'} the CREATE TABLE of ${table}`);
        }
        if ((schema.match(/\bINDEX\b/g) ?? []).length !== INDEXED[name].length) fail(where, 'an index nobody asked for');
        // MariaDB points a foreign key at a column an index begins with, which is said
        if (name === 'fk to an indexed column' && r.problems.filter(p => / only begins an index: few engines can point a foreign key at it/.test(p.msg)).length !== 2) {
          fail(where, 'no warning about the foreign keys to indexes: ' + JSON.stringify(r.problems.map(p => p.msg)));
        }
      }
      if (name === 'long index names') { // cut to the length a name may have, they are numbered apart
        const names = [...schema.matchAll(/\bINDEX (\S+)/g)].map(m => m[1].toLowerCase());
        if (names.length !== 3 || new Set(names).size !== 3) fail(where, 'index names alike: ' + names.join(', '));
      }
      if (name === 'stand-in types and shapes') {
        // a type the database hasn't is said, as the one that stands in for it; a shape is NULL in the sample rows,
        // and a table where one can't be gets none
        const warns = r.problems.map(p => p.msg), standIn = { postgres: 'is VARCHAR(6)', mssql: 'is NVARCHAR(6)', sqlite: 'is VARCHAR(6)' }[dialect];
        if (standIn && !warns.some(m => m.includes("has no enum('Shop','Cafe','Museum') type: Place.Kind " + standIn))) fail(where, 'no note on the enum: ' + JSON.stringify(warns));
        if (!warns.some(m => m.startsWith('Route gets no sample rows'))) fail(where, 'no note on Route: ' + JSON.stringify(warns));
        if (/INSERT INTO \S*Route/.test(script)) fail(where, 'sample rows for Route');
        if (!/INSERT INTO \S*Place/.test(script) || /POINT\(|'\w+ \w+'\)/.test(script.split('-- Sample data')[1].replace(/'[^']*'/g, ''))) fail(where, 'Place has no rows, or a made-up shape');
      }
      const max = vm.runInContext(`dialectOf('${dialect}').maxName`, ctx);
      if (isFinite(max) && new RegExp(`\\b\\w{${max + 1},}\\b`).test(script.replace(/'[^']*'/g, ''))) fail(where, `a name longer than ${max} characters`);
      if (!run[dialect]) continue;
      const res = RUN[dialect](script);
      if (res.status || res.stderr?.trim()) fail(where, res.stderr.trim() + '\n' + script);
      else if (dialect === 'sqlite' && res.stdout.trim()) fail(where, 'sample data breaks a foreign key: ' + res.stdout.trim());
    }
  }
  const ran = DBS.filter(d => run[d]).map(NAME);
  console.log(failures ? failures + ' problems' : `sql ok: ${Object.keys(all).length} schemas${ran.length ? ', run on ' + ran.join(', ') : ''}`);
  process.exitCode = failures ? 1 : 0;
})();
