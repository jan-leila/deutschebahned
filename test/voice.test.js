const test = require('node:test');
const assert = require('node:assert/strict');
const voice = require('../src/common/voice');
const catalog = require('../src/common/catalog');
const geo = require('../src/common/geo');

const HOME = { lat: 44.97, lon: -93.26 };
const at = (m, bearing) => geo.offset(HOME, m, bearing);
const stop = (id, name, m, bearing) => Object.assign({ id, name }, at(m, bearing));

// r44 passes 300 m away, r6 1.5 km away, r9 is across town; r7 failed to load
const data = { stops: [], routes: {
  'a/44': { shortName: '44', longName: 'Ballard - University', stops: { 'a/s1': stop('a/s1', 'Market St', 300, 90), 'a/s2': stop('a/s2', 'Leary Way', 900, 90) } },
  'a/6': { shortName: '6', longName: 'Aurora Avenue', stops: { 'a/s3': stop('a/s3', 'Aurora & 45th', 1500, 0) } },
  'a/9': { shortName: '9', longName: 'Rainier', stops: { 'a/s4': stop('a/s4', 'Rainier Beach', 9000, 180) } } } };
const cfg = {
  voiceRadius: 2000,
  routes: [{ id: 'a/44', sourceId: '44', name: '44', color: 'FF0000' }, { id: 'a/6', sourceId: '6', name: 'Aurora', color: '' },
           { id: 'a/9', sourceId: '9', name: 'Rainier', color: '' }, { id: 'a/7', sourceId: '7', name: 'Seven', color: '' }],
  stops: [Object.assign({ id: 'a/s1', name: 'Market Street' }, at(300, 90)), Object.assign({ id: 'a/s5', name: 'Market Hall' }, at(1200, 270)),
          Object.assign({ id: 'a/s4', name: 'Rainier Beach' }, at(9000, 180)), { id: 'a/s6', name: 'Nowhere', lat: null, lon: null }],
  places: [Object.assign({ id: 'home', name: 'Home', address: '12 Elm Street' }, at(50, 0)),
           Object.assign({ id: 'place2', name: 'Grandma', address: 'Portland' }, at(250000, 180))] };
const pickup44 = { kind: 'pickup', routeId: 'a/44', stopId: 'a/s2', badge: '44', title: 'Leary Way', color: 'FF0000', times: [100],
  lanes: [{ stopId: 'a/s2' }, { stopId: 'a/s1' }] };
const list = over => Object.assign({ items: [], pos: HOME, cfg, data }, over);
const names = cands => cands.map(c => c.entry.name);

test('catalog.score: one text against a query, 0 when nothing matches', () => {
  assert.ok(catalog.score('Market', 'Market Street') > catalog.score('Markit', 'Market Street'));
  assert.ok(catalog.score('Markit', 'Market Street') > 0, 'a typo still matches');
  assert.equal(catalog.score('Rainier', 'Market Street'), 0);
  assert.equal(catalog.score('  ', 'Market Street'), 0);
});

test('routers: what the app declares stays within the phone app\'s limits', () => {
  assert.deepEqual(voice.ROUTERS.map(r => r.id), ['open', 'route', 'stop', 'location']);
  for (const r of voice.ROUTERS) {
    assert.match(r.id, /^[a-z0-9-]{1,32}$/);
    assert.ok(r.name.length <= 64 && r.description.length <= 200);
    for (const p of r.params || []) assert.match(p, /^[a-z][a-z0-9_]{0,31}$/);
  }
});

test('query: the mapped field, else the unmatched text, else the whole text', () => {
  assert.equal(voice.query({ text: 'navigate to stop market', unmatched_text: 'market', fields: { query: ' Market St ' } }), 'Market St');
  assert.equal(voice.query({ text: 'navigate to stop market', unmatched_text: ' market ', fields: {} }), 'market');
  assert.equal(voice.query({ text: 'market', unmatched_text: '' }), 'market');
  assert.equal(voice.query(JSON.stringify({ text: 'x', fields: { query: 'home' } })), 'home', 'a JSON string is read');
  assert.equal(voice.query(' home '), 'home', 'a plain string is the query');
  for (const bad of [null, undefined, 5, {}, { text: '  ' }]) assert.equal(voice.query(bad), '');
});

test('candidates: routes and stops only within voiceRadius, locations at any distance', () => {
  assert.deepEqual(names(voice.candidates('route', cfg, data, HOME)), ['44', 'Aurora'], 'far and unloaded routes are left out');
  assert.equal(voice.candidates('route', cfg, data, HOME)[0].near.id, 'a/s1', 'a route is as far as its nearest stop');
  assert.deepEqual(names(voice.candidates('stop', cfg, data, HOME)), ['Market Street', 'Market Hall'], 'far stops and ones without a position are left out');
  assert.deepEqual(names(voice.candidates('location', cfg, data, HOME)), ['Home', 'Grandma']);
  const tight = Object.assign({}, cfg, { voiceRadius: 500 });
  assert.deepEqual(names(voice.candidates('route', tight, data, HOME)), ['44']);
  assert.deepEqual(names(voice.candidates('stop', tight, data, HOME)), ['Market Street']);
  assert.deepEqual(voice.candidates('route', cfg, data, null), [], 'no position: nothing is known to be near');
  assert.deepEqual(voice.candidates('stop', cfg, data, null), []);
  assert.deepEqual(names(voice.candidates('location', cfg, data, null)), ['Home', 'Grandma']);
  assert.deepEqual(voice.candidates('route', null, null, HOME), []);
});

test('match: the closest name, filler words ignored, the nearer one on a tie, null for no match', () => {
  const routes = voice.candidates('route', cfg, data, HOME), stops = voice.candidates('stop', cfg, data, HOME);
  const places = voice.candidates('location', cfg, data, HOME);
  assert.equal(voice.match('the 44 bus', routes).entry.id, 'a/44');
  assert.equal(voice.match('Aurora line', routes).entry.id, 'a/6');
  assert.equal(voice.match('ballard', routes).entry.id, 'a/44', 'the long name counts');
  assert.equal(voice.match('Rainier', routes), null, 'a route out of range is not found');
  assert.equal(voice.match('market hall', stops).entry.id, 'a/s5');
  assert.equal(voice.match('market', stops).entry.id, 'a/s5', 'the name the query covers more of');
  const twins = [{ entry: { id: 'far' }, names: ['Main St'], distance: 500 }, { entry: { id: 'near' }, names: ['Main St'], distance: 100 }];
  assert.equal(voice.match('main', twins).entry.id, 'near', 'equal scores: the nearer one');
  assert.equal(voice.match('markit street', stops).entry.id, 'a/s1', 'typos');
  assert.equal(voice.match('my home', places).entry.id, 'home');
  assert.equal(voice.match('elm street', places).entry.id, 'home', 'the address counts');
  assert.equal(voice.match('grandma', places).entry.id, 'place2');
  assert.equal(voice.match('xyzzy', places), null);
  assert.equal(voice.match('the', places), null, 'only filler: matched as said');
});

test('target: the pickup tile when the list has one, else the nearest stop / a walk', () => {
  const routes = voice.candidates('route', cfg, data, HOME), stops = voice.candidates('stop', cfg, data, HOME);
  const r44 = voice.match('44', routes), market = voice.match('market street', stops), hall = voice.match('market hall', stops);
  assert.equal(voice.target(r44, [pickup44]), pickup44);
  assert.deepEqual(voice.target(r44, []), { kind: 'pickup', routeId: 'a/44', stopId: 'a/s1', badge: '44', title: 'Market St', color: 'FF0000', times: [] });
  assert.equal(voice.target(market, [pickup44]), pickup44, 'a stop that is a lane of a tile');
  const walk = voice.target(hall, [pickup44]);
  assert.deepEqual([walk.kind, walk.title], ['place', 'Market Hall']);
  assert.deepEqual(geo.distance(walk, at(1200, 270)) < 1, true);
  const home = voice.target(voice.match('home', voice.candidates('location', cfg, data, HOME)), [pickup44]);
  assert.deepEqual([home.kind, home.title], ['place', 'Home']);
});

function harness(first) {
  let current = first;
  const started = [], statuses = [];
  const v = voice.createVoice({ getList: () => current, startNav: (item, d) => started.push([item, d]), status: s => statuses.push(s) });
  return { v, started, statuses, setList: l => { current = l; } };
}

test('handle: open does nothing more; a query starts navigation; no match says so', () => {
  const h = harness(list({ items: [pickup44] }));
  assert.equal(h.v.handle('open', { text: 'open my transit app' }), 'open');
  assert.deepEqual([h.started, h.statuses], [[], []]);
  assert.equal(h.v.handle('route', { text: 'x', fields: { query: 'the 44' } }), 'started');
  assert.deepEqual(h.started.pop(), [pickup44, data]);
  assert.equal(h.v.handle('location', { text: 'home', unmatched_text: 'home' }), 'started');
  assert.equal(h.started.pop()[0].title, 'Home');
  assert.equal(h.v.handle('stop', { text: 'rainier beach' }), 'none');
  assert.equal(h.v.handle('location', { text: '' }), 'none');
  assert.equal(h.v.handle('bogus', { text: 'home' }), 'unknown');
  assert.deepEqual(h.statuses, ['No stop like "rainier beach"', 'Which saved location?']);
  assert.equal(h.started.length, 0);
});

test('handle before the first list: the command waits for the refresh that is running', () => {
  const h = harness(null);
  assert.equal(h.v.handle('stop', { text: 'market hall' }), 'waiting');
  assert.equal(h.started.length, 0);
  h.setList(list());
  assert.equal(h.v.flush(), true);
  assert.equal(h.started[0][0].title, 'Market Hall');
  assert.equal(h.v.flush(), false, 'it ran once');
  assert.equal(h.started.length, 1);
});

test('a refresh that fails drops the waiting command', () => {
  const h = harness(null);
  h.v.handle('stop', { text: 'market hall' });
  assert.equal(h.v.flush(), false);
  h.setList(list());
  assert.equal(h.v.flush(), false);
  assert.equal(h.started.length, 0);
});
