// app.js - full script with card-style fixtures, centered probabilities, and scoreline predictions
// - Mode toggle (Fixtures / Standings)
// - League selection from header logos
// - Fixtures rendered as cards with centered probability block and fixed columns
// - Probabilities computed from standings using the user's formula
// - Scoreline prediction computed from GD per match (rounded) and shown in the card
// - Limits fixtures to MAX_FIXTURES (16)
// - Standings render table with crests
// - Simple in-memory caching, search, keyboard accessibility

const API_KEY = "2f926020e5bc4bffbcbb5f703f3d5228"; // replace if needed
const LOCAL_LOGO_ROOT = 'logos';
const PLACEHOLDER_SVG = 'data:image/svg+xml;utf8,' + encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 64 64">' +
  '<rect width="100%" height="100%" fill="#222"/>' +
  '<text x="50%" y="50%" fill="#777" font-size="10" font-family="Arial" text-anchor="middle" alignment-baseline="middle">no logo</text>' +
  '</svg>'
);

// DOM refs
const statusEl = document.getElementById('status');
const tbody = document.querySelector('#leagueTable tbody');
const searchInput = document.getElementById('teamSearch');
const fixturesPanel = document.getElementById('fixturesPanel');
const standingsPanel = document.getElementById('standingsPanel');
const fixturesList = document.getElementById('fixturesList');
const pageTitle = document.getElementById('pageTitle');
const modeButtons = document.querySelectorAll('.mode-btn');
const leagueLogos = document.querySelectorAll('.league-logo');

// state
let currentMode = 'fixtures';
let currentLeague = null;
let cache = {};               // cache[league+'|'+mode] = data
let currentTable = [];        // standings rows
let currentFixtures = [];     // fixtures list

// configuration
const MAX_FIXTURES = 16; // show up to this many unplayed fixtures

// ----------------------------- helpers -------------------------------------

function setStatus(text) {
  if (!statusEl) return;
  statusEl.textContent = text || '';
}

function debounce(fn, wait = 180) {
  let t;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), wait); };
}

function sanitizeFilename(name) {
  return String(name || '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/&/g, 'and')
    .replace(/[^a-z0-9\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-');
}

// create crest element that tries API then local fallbacks
function makeCrestImg(team, size = 72) {
  const img = document.createElement('img');
  img.className = 'crest';
  img.loading = 'lazy';
  img.alt = `${team?.name || team?.shortName || 'team'} crest`;
  img.style.width = size + 'px';
  img.style.height = size + 'px';
  img.style.objectFit = 'contain';
  img.style.flex = '0 0 ' + size + 'px';

  const candidates = [];
  if (team?.crest) {
    let crestUrl = team.crest;
    if (crestUrl.startsWith('http:')) crestUrl = crestUrl.replace(/^http:/, 'https:');
    candidates.push(crestUrl);
  }

  const localName = sanitizeFilename(team?.name || team?.shortName || team?.tla || '');
  if (localName) {
    candidates.push(`${LOCAL_LOGO_ROOT}/${localName}.svg`);
    candidates.push(`${LOCAL_LOGO_ROOT}/${localName}.png`);
    candidates.push(`${LOCAL_LOGO_ROOT}/${localName}.jpg`);
  }

  let idx = 0;
  function tryNext() {
    if (idx >= candidates.length) {
      img.src = PLACEHOLDER_SVG;
      return;
    }
    const src = candidates[idx++];
    img.src = src;
    img.onerror = tryNext;
    img.onload = () => { img.onerror = null; };
  }
  tryNext();
  return img;
}

// find team stats in currentTable by name (case-insensitive)
function findTeamEntryByName(name) {
  if (!name) return null;
  const n = name.trim().toLowerCase();
  return (currentTable || []).find(e => {
    const tname = (e.team?.name || '').toLowerCase();
    const short = (e.team?.shortName || '').toLowerCase();
    const tla = (e.team?.tla || '').toLowerCase();
    return tname === n || short === n || tla === n || tname.includes(n) || n.includes(tname);
  }) || null;
}

// compute probabilities using the user's formula
function computeProbabilities(homeName, awayName) {
  // default zeros
  let homeWins = 0, homeDraws = 0, homeLosses = 0;
  let awayWins = 0, awayDraws = 0, awayLosses = 0;

  const homeEntry = findTeamEntryByName(homeName);
  const awayEntry = findTeamEntryByName(awayName);

  if (homeEntry) {
    homeWins = Number(homeEntry.won || 0);
    homeDraws = Number(homeEntry.draw || 0);
    homeLosses = Number(homeEntry.lost || 0);
  }
  if (awayEntry) {
    awayWins = Number(awayEntry.won || 0);
    awayDraws = Number(awayEntry.draw || 0);
    awayLosses = Number(awayEntry.lost || 0);
  }

  // apply formulas from user
  const homeVal = homeWins + awayLosses;
  const drawVal = homeDraws + awayDraws;
  const awayVal = awayWins + homeDraws; // user specified away = awayWins + homeDraws

  const total = homeVal + drawVal + awayVal;

  if (total <= 0) {
    // fallback: reasonable default distribution
    return { homePct: 50, drawPct: 30, awayPct: 20, raw: { homeVal, drawVal, awayVal } };
  }

  const homePct = Math.round((homeVal / total) * 100);
  const drawPct = Math.round((drawVal / total) * 100);
  const awayPct = 100 - homePct - drawPct;

  return { homePct, drawPct, awayPct, raw: { homeVal, drawVal, awayVal } };
}

// ----------------------------- scoreline prediction ------------------------
// Using GD per match for each team to derive a simple predicted scoreline.
// Steps:
// 1. gdPerMatchHome = home.goalDifference / home.playedGames
// 2. gdPerMatchAway = away.goalDifference / away.playedGames
// 3. rawHome = gdPerMatchHome - gdPerMatchAway
//    rawAway = gdPerMatchAway - gdPerMatchHome
// 4. shift both by a baseline (1.0 for home, 0.8 for away) to avoid zeros
// 5. round to nearest integer and clamp >= 0
// This yields a simple, deterministic prediction based on relative GD per match.
function computeScoreline(homeName, awayName) {
  const homeEntry = findTeamEntryByName(homeName);
  const awayEntry = findTeamEntryByName(awayName);

  // defaults
  let homePlayed = Number(homeEntry?.playedGames || 0);
  let awayPlayed = Number(awayEntry?.playedGames || 0);
  let homeGD = Number(homeEntry?.goalDifference || 0);
  let awayGD = Number(awayEntry?.goalDifference || 0);

  // compute gd per match safely
  const homeGDpm = homePlayed > 0 ? homeGD / homePlayed : 0;
  const awayGDpm = awayPlayed > 0 ? awayGD / awayPlayed : 0;

  // raw differences
  const rawHome = homeGDpm - awayGDpm;
  const rawAway = awayGDpm - homeGDpm;

  // baseline offsets (keeps typical football scores > 0)
  const baselineHome = 1.0;
  const baselineAway = 0.8;

  // predicted goals before rounding
  let predHome = rawHome + baselineHome;
  let predAway = rawAway + baselineAway;

  // ensure non-negative
  predHome = Math.max(0, predHome);
  predAway = Math.max(0, predAway);

  // round to whole numbers
  let homeGoals = Math.round(predHome);
  let awayGoals = Math.round(predAway);

  // final clamp
  homeGoals = Math.max(0, homeGoals);
  awayGoals = Math.max(0, awayGoals);

  // if both zero (rare), set 1-1 as neutral fallback
  if (homeGoals === 0 && awayGoals === 0) {
    homeGoals = 1;
    awayGoals = 1;
  }

  return { homeGoals, awayGoals, details: { homeGDpm, awayGDpm, rawHome, rawAway } };
}

// ----------------------------- rendering -----------------------------------

// render standings table
function renderTable() {
  const q = searchInput.value.trim().toLowerCase();
  tbody.innerHTML = '';

  const rows = (currentTable || []).slice().sort((a, b) => (a.position || 0) - (b.position || 0));

  rows.forEach(entry => {
    const name = entry.team?.name || '';
    if (q && !name.toLowerCase().includes(q)) return;

    const tr = document.createElement('tr');

    // position
    const posTd = document.createElement('td');
    posTd.className = 'pos';
    posTd.textContent = entry.position ?? '';
    tr.appendChild(posTd);

    // team cell
    const teamTd = document.createElement('td');
    teamTd.className = 'team';
    const crest = makeCrestImg(entry.team || {}, 36);
    const textWrap = document.createElement('div');
    textWrap.className = 'teamText';
    const nameEl = document.createElement('div');
    nameEl.className = 'teamName';
    nameEl.textContent = name;
    const metaEl = document.createElement('div');
    metaEl.className = 'teamMeta';
    metaEl.textContent = entry.team?.tla || entry.team?.shortName || '';
    textWrap.appendChild(nameEl);
    textWrap.appendChild(metaEl);
    teamTd.appendChild(crest);
    teamTd.appendChild(textWrap);
    tr.appendChild(teamTd);

    // stats
    const cells = [
      entry.playedGames,
      entry.won,
      entry.draw,
      entry.lost,
      entry.points,
      entry.goalsFor,
      entry.goalsAgainst,
      entry.goalDifference
    ];
    cells.forEach(val => {
      const td = document.createElement('td');
      td.textContent = val ?? 0;
      tr.appendChild(td);
    });

    tbody.appendChild(tr);
  });

  if (!tbody.children.length) {
    const tr = document.createElement('tr');
    const td = document.createElement('td');
    td.colSpan = 10;
    td.style.textAlign = 'center';
    td.style.padding = '18px';
    td.style.color = '#9aa3ad';
    td.textContent = 'No teams match your search.';
    tr.appendChild(td);
    tbody.appendChild(tr);
  }
}

// render fixtures as cards (uses CSS classes for stable layout)
function renderFixtures() {
  const q = searchInput.value.trim().toLowerCase();
  fixturesList.innerHTML = '';

  const items = (currentFixtures || []).slice().sort((a,b) => new Date(a.utcDate) - new Date(b.utcDate));

  items.forEach(f => {
    const homeName = f.homeTeam?.name || '';
    const awayName = f.awayTeam?.name || '';
    if (q && !(homeName.toLowerCase().includes(q) || awayName.toLowerCase().includes(q))) return;

    // compute probabilities using standings data
    const probs = computeProbabilities(homeName, awayName);

    // compute scoreline prediction using GD per match
    const score = computeScoreline(homeName, awayName);

    // card container
    const card = document.createElement('li');
    card.className = 'fixture-card';

    // top row: date/time and competition
    const topRow = document.createElement('div');
    topRow.className = 'card-top';
    topRow.style.display = 'flex';
    topRow.style.justifyContent = 'space-between';
    topRow.style.alignItems = 'center';

    const time = document.createElement('time');
    time.dateTime = f.utcDate;
    const d = new Date(f.utcDate);
    time.textContent = d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
    time.className = 'card-time';
    topRow.appendChild(time);

    const comp = document.createElement('div');
    comp.className = 'card-comp';
    comp.textContent = f.competition?.name || '';
    topRow.appendChild(comp);

    card.appendChild(topRow);

    // middle row: teams and logos (use fixed columns via CSS)
    const middle = document.createElement('div');
    middle.className = 'middle';

    // home block
    const homeBlock = document.createElement('div');
    homeBlock.className = 'team-block';
    const homeCrest = makeCrestImg({ name: homeName, crest: f.homeTeam?.crest }, 72);
    const homeLabel = document.createElement('div');
    homeLabel.className = 'teamName';
    homeLabel.textContent = homeName;
    homeBlock.appendChild(homeCrest);
    homeBlock.appendChild(homeLabel);

    // vs block with percentages and scoreline
    const vsBlock = document.createElement('div');
    vsBlock.className = 'vs-block';

    const vsText = document.createElement('div');
    vsText.className = 'vs-text';
    vsText.textContent = 'vs';
    vsBlock.appendChild(vsText);

    // scoreline display (predicted)
    const scoreEl = document.createElement('div');
    scoreEl.className = 'pred-score';
    scoreEl.style.fontWeight = '800';
    scoreEl.style.fontSize = '20px';
    scoreEl.style.color = '#ffffff';
    scoreEl.style.marginTop = '6px';
    scoreEl.textContent = `${score.homeGoals} - ${score.awayGoals}`;
    vsBlock.appendChild(scoreEl);

    // percentages row
    const pctRow = document.createElement('div');
    pctRow.className = 'pct-row';

    const homePctEl = document.createElement('div');
    homePctEl.className = 'pct-item';
    homePctEl.innerHTML = `<div class="pct-value" style="font-weight:800;color:#dff7e6">${probs.homePct}%</div><div class="pct-label" style="font-size:12px;color:#9aa3ad">Home</div>`;

    const drawPctEl = document.createElement('div');
    drawPctEl.className = 'pct-item';
    drawPctEl.innerHTML = `<div class="pct-value" style="font-weight:800;color:#fff3d6">${probs.drawPct}%</div><div class="pct-label" style="font-size:12px;color:#9aa3ad">Draw</div>`;

    const awayPctEl = document.createElement('div');
    awayPctEl.className = 'pct-item';
    awayPctEl.innerHTML = `<div class="pct-value" style="font-weight:800;color:#ffd6d6">${probs.awayPct}%</div><div class="pct-label" style="font-size:12px;color:#9aa3ad">Away</div>`;

    pctRow.appendChild(homePctEl);
    pctRow.appendChild(drawPctEl);
    pctRow.appendChild(awayPctEl);
    vsBlock.appendChild(pctRow);

    // probability bar
    const barWrap = document.createElement('div');
    barWrap.className = 'prob-bar';
    const segHome = document.createElement('div');
    segHome.style.width = `${probs.homePct}%`;
    segHome.style.background = 'linear-gradient(90deg,#2fb86f,#1db954)';
    segHome.style.height = '100%';
    const segDraw = document.createElement('div');
    segDraw.style.width = `${probs.drawPct}%`;
    segDraw.style.background = 'linear-gradient(90deg,#f6c85f,#f0a500)';
    segDraw.style.height = '100%';
    const segAway = document.createElement('div');
    segAway.style.width = `${probs.awayPct}%`;
    segAway.style.background = 'linear-gradient(90deg,#ff7b7b,#ff4b4b)';
    segAway.style.height = '100%';
    barWrap.appendChild(segHome);
    barWrap.appendChild(segDraw);
    barWrap.appendChild(segAway);
    vsBlock.appendChild(barWrap);

    // away block
    const awayBlock = document.createElement('div');
    awayBlock.className = 'team-block';
    const awayCrest = makeCrestImg({ name: awayName, crest: f.awayTeam?.crest }, 72);
    const awayLabel = document.createElement('div');
    awayLabel.className = 'teamName';
    awayLabel.textContent = awayName;
    awayBlock.appendChild(awayCrest);
    awayBlock.appendChild(awayLabel);

    // assemble middle
    middle.appendChild(homeBlock);
    middle.appendChild(vsBlock);
    middle.appendChild(awayBlock);
    card.appendChild(middle);

    // bottom row: venue and status
    const bottom = document.createElement('div');
    bottom.className = 'card-bottom';
    bottom.style.display = 'flex';
    bottom.style.justifyContent = 'space-between';
    bottom.style.alignItems = 'center';
    bottom.style.color = '#9aa3ad';
    bottom.style.fontSize = '13px';

    const venue = document.createElement('div');
    venue.className = 'card-venue';
    venue.textContent = f.venue || '';
    bottom.appendChild(venue);

    const status = document.createElement('div');
    status.className = 'card-status';
    status.textContent = f.status === 'TIMED' ? 'Timed' : 'Scheduled';
    bottom.appendChild(status);

    card.appendChild(bottom);

    fixturesList.appendChild(card);
  });

  if (!fixturesList.children.length) {
    const li = document.createElement('li');
    li.className = 'placeholder';
    li.style.padding = '18px';
    li.style.textAlign = 'center';
    li.style.color = '#9aa3ad';
    li.textContent = 'No upcoming (unplayed) fixtures match your search.';
    fixturesList.appendChild(li);
  }
}

// ----------------------------- API calls ----------------------------------

// simple cache wrapper
async function cachedFetch(key, url, options = {}) {
  if (cache[key]) return cache[key];
  const res = await fetch(url, options);
  if (!res.ok) throw new Error(`API ${res.status}`);
  const data = await res.json();
  cache[key] = data;
  return data;
}

// fetch standings and populate currentTable (used by both panels)
async function fetchStandings(league) {
  setStatus('Loading standings…');
  tbody.innerHTML = '';
  currentTable = [];
  try {
    const key = `${league}|standings`;
    const data = await cachedFetch(key, `https://api.football-data.org/v4/competitions/${league}/standings`, {
      headers: { "X-Auth-Token": API_KEY }
    });
    const block = (data.standings || []).find(s => s.type === 'TOTAL') || data.standings?.[0];
    if (!block || !block.table) throw new Error('No standings available');
    currentTable = block.table;
    setStatus(`${data.competition?.name || league} · Season ${data.season?.startDate || ''}`);
    renderTable();
  } catch (err) {
    setStatus('');
    tbody.innerHTML = `<tr><td colspan="10" style="text-align:center;color:#ff6b6b;padding:18px">Failed to load standings. Check API key or network.</td></tr>`;
    console.error(err);
  }
}

// fetch fixtures (only unplayed: SCHEDULED or TIMED) and limit to MAX_FIXTURES
async function fetchFixtures(league) {
  setStatus('Loading fixtures…');
  fixturesList.innerHTML = '';
  currentFixtures = [];
  try {
    // ensure we have standings data to compute probabilities and scorelines
    try {
      const standingsData = await cachedFetch(`${league}|standings`, `https://api.football-data.org/v4/competitions/${league}/standings`, {
        headers: { "X-Auth-Token": API_KEY }
      });
      const block = (standingsData.standings || []).find(s => s.type === 'TOTAL') || standingsData.standings?.[0];
      currentTable = block?.table || [];
    } catch (e) {
      currentTable = [];
    }

    const key = `${league}|fixtures`;
    const data = await cachedFetch(key, `https://api.football-data.org/v4/competitions/${league}/matches?limit=50`, {
      headers: { "X-Auth-Token": API_KEY }
    });
    const allMatches = data.matches || [];
    // filter unplayed and then take up to MAX_FIXTURES
    const unplayed = allMatches.filter(m => m.status === 'SCHEDULED' || m.status === 'TIMED' || m.status === 'POSTPONED');
    currentFixtures = unplayed.slice(0, MAX_FIXTURES);
    setStatus(`${data.competition?.name || league} · ${currentFixtures.length} upcoming fixtures`);
    renderFixtures();
  } catch (err) {
    setStatus('');
    fixturesList.innerHTML = `<li style="text-align:center;color:#ff6b6b;padding:18px">Failed to load fixtures. Check API key or network.</li>`;
    console.error(err);
  }
}

// ----------------------------- UI wiring -----------------------------------

// switch mode and update UI
function switchMode(mode) {
  if (mode === currentMode) return;
  currentMode = mode;
  modeButtons.forEach(b => {
    const isActive = b.getAttribute('data-mode') === mode;
    b.classList.toggle('active', isActive);
    b.setAttribute('aria-selected', isActive ? 'true' : 'false');
  });

  if (mode === 'fixtures') {
    fixturesPanel.classList.remove('hidden');
    fixturesPanel.setAttribute('aria-hidden', 'false');
    standingsPanel.classList.add('hidden');
    standingsPanel.setAttribute('aria-hidden', 'true');
    pageTitle.textContent = 'Football — Fixtures';
    if (currentLeague) fetchFixtures(currentLeague);
    fixturesPanel.scrollIntoView({ behavior: 'smooth', block: 'start' });
    fixturesPanel.setAttribute('tabindex', '-1');
    fixturesPanel.focus();
  } else {
    standingsPanel.classList.remove('hidden');
    standingsPanel.setAttribute('aria-hidden', 'false');
    fixturesPanel.classList.add('hidden');
    fixturesPanel.setAttribute('aria-hidden', 'true');
    pageTitle.textContent = 'Football — Standings';
    if (currentLeague) fetchStandings(currentLeague);
    standingsPanel.scrollIntoView({ behavior: 'smooth', block: 'start' });
    standingsPanel.setAttribute('tabindex', '-1');
    standingsPanel.focus();
  }
}

// select league and load data
function selectLeague(league, logoEl) {
  currentLeague = league;
  leagueLogos.forEach(i => i.classList.remove('active'));
  if (logoEl) logoEl.classList.add('active');

  if (currentMode === 'fixtures') fetchFixtures(league);
  else fetchStandings(league);
}

// wire mode buttons
modeButtons.forEach(b => {
  b.addEventListener('click', () => switchMode(b.getAttribute('data-mode')));
  b.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      const next = e.key === 'ArrowRight' ? b.nextElementSibling : b.previousElementSibling;
      if (next && next.classList.contains('mode-btn')) next.focus();
    }
  });
});

// wire league logos (click + keyboard)
leagueLogos.forEach(img => {
  img.tabIndex = 0;
  img.addEventListener('click', () => selectLeague(img.dataset.league, img));
  img.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); selectLeague(img.dataset.league, img); }
  });
});

// search input: apply to both fixtures and standings
searchInput.addEventListener('input', debounce(() => {
  if (currentMode === 'fixtures') renderFixtures();
  else renderTable();
}, 120));

// initial setup
(function init() {
  const active = document.querySelector('.league-logo.active') || document.querySelector('.league-logo');
  if (active) {
    const league = active.dataset.league;
    selectLeague(league, active);
  } else {
    setStatus('No league selected');
  }
  switchMode(currentMode);
})();

// expose for debugging
window.__app = {
  switchMode,
  selectLeague,
  fetchFixtures,
  fetchStandings,
  cache,
  computeScoreline
};