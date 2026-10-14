// Builds the branded stat cards in assets/generated/ and refreshes the
// auto-updated README sections (recent releases, latest blog posts).
// Runs in GitHub Actions with the default GITHUB_TOKEN; no dependencies.
import { readFile, writeFile, mkdir } from 'node:fs/promises';

const USER = 'fadymondy';
const OWNERS = ['fadymondy', 'togo-framework', 'tomatophp', 'laravilt', 'circlexo', 'orchestra-mcp', 'accelade'];
const FEED = 'https://fadymondy.com/feed.xml';
const OUT = 'assets/generated';
const TOKEN = process.env.GITHUB_TOKEN;
if (!TOKEN) throw new Error('GITHUB_TOKEN is required');

const THEMES = {
  dark: { bg: '#0B1429', border: '#1E2A47', text: '#F0EBE1', muted: '#8E98AE', track: '#16213D', gold: '#C9A227' },
  light: { bg: '#F0EBE1', border: '#D9D0BE', text: '#0B1429', muted: '#5B6478', track: '#E3DCCD', gold: '#8F7310' },
};
const ORANGE = '#E2661C';
const GOLD = '#C9A227';
const RAMP = [ORANGE, GOLD, '#F29D64', '#8FA3C7', '#B84E12', '#E6CB72', '#5E7299', '#D98A4E'];
const FONT = "Inter, 'IBM Plex Sans Arabic', 'Segoe UI', system-ui, -apple-system, sans-serif";
const IGNORED_LANGS = new Set(['HTML', 'CSS', 'SCSS', 'Less', 'Blade', 'Makefile', 'Dockerfile', 'Procfile', 'Batchfile', 'Shell', 'PowerShell', 'MDX']);

async function gql(query, variables = {}) {
  for (let attempt = 1; ; attempt++) {
    const res = await fetch('https://api.github.com/graphql', {
      method: 'POST',
      headers: { Authorization: `bearer ${TOKEN}`, 'Content-Type': 'application/json', 'User-Agent': 'fadymondy-profile' },
      body: JSON.stringify({ query, variables }),
    });
    const json = await res.json().catch(() => ({}));
    if (res.ok && !json.errors) return json.data;
    if (attempt >= 3) throw new Error(`GraphQL ${res.status}: ${JSON.stringify(json.errors ?? json)}`);
    await new Promise((r) => setTimeout(r, 2000 * attempt));
  }
}

const REPOS_QUERY = `query($login: String!, $after: String) {
  repositoryOwner(login: $login) {
    repositories(first: 100, after: $after, privacy: PUBLIC, isFork: false, ownerAffiliations: OWNER) {
      pageInfo { hasNextPage endCursor }
      nodes {
        name nameWithOwner stargazerCount isArchived
        languages(first: 10, orderBy: { field: SIZE, direction: DESC }) { edges { size node { name } } }
        latestRelease { tagName publishedAt url isPrerelease }
      }
    }
  }
}`;

async function ownerRepos(login) {
  const repos = [];
  let after = null;
  do {
    const data = await gql(REPOS_QUERY, { login, after });
    const page = data.repositoryOwner?.repositories;
    if (!page) break;
    repos.push(...page.nodes);
    after = page.pageInfo.hasNextPage ? page.pageInfo.endCursor : null;
  } while (after);
  return repos;
}

async function contributionDays(createdAt) {
  const days = new Map();
  const now = new Date();
  for (let y = new Date(createdAt).getUTCFullYear(); y <= now.getUTCFullYear(); y++) {
    const from = `${y}-01-01T00:00:00Z`;
    const to = y === now.getUTCFullYear() ? now.toISOString() : `${y}-12-31T23:59:59Z`;
    const data = await gql(
      `query($login: String!, $from: DateTime!, $to: DateTime!) { user(login: $login) { contributionsCollection(from: $from, to: $to) {
        contributionCalendar { weeks { contributionDays { date contributionCount } } } } } }`,
      { login: USER, from, to },
    );
    for (const w of data.user.contributionsCollection.contributionCalendar.weeks)
      for (const d of w.contributionDays) days.set(d.date, d.contributionCount);
  }
  return [...days.entries()].sort(([a], [b]) => a.localeCompare(b));
}

function streaks(days) {
  const today = new Date().toISOString().slice(0, 10);
  let longest = { len: 0 }, run = { len: 0 };
  for (const [date, count] of days) {
    if (count > 0) {
      run = run.len ? { ...run, len: run.len + 1, end: date } : { len: 1, start: date, end: date };
      if (run.len > longest.len) longest = run;
    } else if (date !== today) run = { len: 0 };
  }
  // A streak stays "current" through today even before today's first contribution.
  const yesterday = new Date(Date.now() - 864e5).toISOString().slice(0, 10);
  const current = run.len && (run.end === today || run.end === yesterday) ? run : { len: 0 };
  return { current, longest, total: days.reduce((s, [, c]) => s + c, 0), since: days[0]?.[0] };
}

// ---------- SVG helpers ----------
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const fmt = (n) => (n >= 10000 ? `${(n / 1000).toFixed(n >= 100000 ? 0 : 1)}k` : n.toLocaleString('en-US'));
const fmtDate = (d) => (d ? new Date(d + (d.length === 10 ? 'T00:00:00Z' : '')).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }) : '');
const W = 480, H = 230;

function card(t, title, body, h = H) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${h}" viewBox="0 0 ${W} ${h}" role="img" aria-label="${esc(title)}">
<style>text{font-family:${FONT}}</style>
<rect x="0.5" y="0.5" width="${W - 1}" height="${h - 1}" rx="14" fill="${t.bg}" stroke="${t.border}"/>
<rect x="24" y="24" width="4" height="18" rx="2" fill="${ORANGE}"/>
<text x="38" y="39" font-size="16" font-weight="700" fill="${t.text}">${esc(title)}</text>
${body}
</svg>\n`;
}

function statsCard(t, s) {
  const items = [
    ['Stars earned', fmt(s.stars), ORANGE],
    ['Contributions · last year', fmt(s.lastYear), t.text],
    [`Commits · ${s.year}`, fmt(s.commits), t.text],
    [`Pull requests · ${s.year}`, fmt(s.prs), t.text],
    [`Public repos · ${s.accounts} accounts`, fmt(s.repos), t.text],
    ['Followers', fmt(s.followers), t.gold],
  ];
  const body = items.map(([label, value, color], i) => {
    const x = 24 + (i % 2) * 228, y = 82 + Math.floor(i / 2) * 50;
    return `<text x="${x}" y="${y}" font-size="12" fill="${t.muted}">${esc(label)}</text>
<text x="${x}" y="${y + 24}" font-size="22" font-weight="700" fill="${color}">${esc(value)}</text>`;
  }).join('\n');
  return card(t, 'GitHub at a glance', body);
}

function langCard(t, langs) {
  const total = langs.reduce((s, l) => s + l.size, 0) || 1;
  let x = 24;
  const bw = W - 48;
  const bar = langs.map((l, i) => {
    const w = (l.size / total) * bw;
    const r = `<rect x="${x.toFixed(2)}" y="60" width="${w.toFixed(2)}" height="10" fill="${RAMP[i % RAMP.length]}"/>`;
    x += w;
    return r;
  }).join('');
  const legend = langs.map((l, i) => {
    const lx = 24 + (i % 2) * 228, ly = 100 + Math.floor(i / 2) * 32;
    return `<circle cx="${lx + 5}" cy="${ly - 4}" r="5" fill="${RAMP[i % RAMP.length]}"/>
<text x="${lx + 18}" y="${ly}" font-size="13" fill="${t.text}">${esc(l.name)}</text>
<text x="${lx + 200}" y="${ly}" font-size="13" text-anchor="end" fill="${t.muted}">${((l.size / total) * 100).toFixed(1)}%</text>`;
  }).join('\n');
  return card(t, 'Top languages', `<clipPath id="bar"><rect x="24" y="60" width="${bw}" height="10" rx="5"/></clipPath>
<rect x="24" y="60" width="${bw}" height="10" rx="5" fill="${t.track}"/><g clip-path="url(#bar)">${bar}</g>
${legend}`);
}

function streakCard(t, s) {
  const col = (cx, value, label, sub, color, big) => `<text x="${cx}" y="${big ? 116 : 114}" font-size="${big ? 30 : 26}" font-weight="700" text-anchor="middle" fill="${color}">${esc(value)}</text>
<text x="${cx}" y="168" font-size="13" font-weight="600" text-anchor="middle" fill="${t.text}">${esc(label)}</text>
<text x="${cx}" y="188" font-size="11" text-anchor="middle" fill="${t.muted}">${esc(sub)}</text>`;
  const range = (r) => (r.len ? `${fmtDate(r.start)} – ${fmtDate(r.end)}` : '—');
  const body = `<line x1="173" y1="72" x2="173" y2="190" stroke="${t.border}"/><line x1="307" y1="72" x2="307" y2="190" stroke="${t.border}"/>
<circle cx="240" cy="105" r="34" fill="none" stroke="${ORANGE}" stroke-width="4" opacity="0.9"/>
${col(98, fmt(s.total), 'Total contributions', `since ${fmtDate(s.since)}`, t.gold)}
${col(240, `${s.current.len}`, 'Current streak', s.current.len ? range(s.current) : 'starts with the next commit', ORANGE, true)}
${col(382, `${s.longest.len}`, 'Longest streak', range(s.longest), t.gold)}`;
  return card(t, 'Contribution streak', body);
}

function starsCard(t, owners, total) {
  const max = Math.max(1, ...owners.map((o) => o.stars));
  const rows = owners.map((o, i) => {
    const y = 96 + i * 19;
    const w = Math.max(3, (o.stars / max) * 230);
    return `<text x="24" y="${y}" font-size="12" fill="${t.text}">${esc(o.login)}</text>
<rect x="150" y="${y - 9}" width="230" height="8" rx="4" fill="${t.track}"/><rect x="150" y="${y - 9}" width="${w.toFixed(1)}" height="8" rx="4" fill="${i === 0 ? ORANGE : t.gold}"/>
<text x="${W - 24}" y="${y}" font-size="12" font-weight="600" text-anchor="end" fill="${t.muted}">${fmt(o.stars)}</text>`;
  }).join('\n');
  return card(t, 'Stars across the ecosystem', `<text x="${W - 24}" y="40" font-size="22" font-weight="700" text-anchor="end" fill="${ORANGE}">★ ${fmt(total)}</text>
<text x="24" y="66" font-size="11" fill="${t.muted}">Public, non-fork repositories in ${owners.length} accounts</text>
${rows}`);
}

// ---------- README sections ----------
function replaceSection(readme, key, content) {
  const re = new RegExp(`(<!-- ${key}:START -->)[\\s\\S]*?(<!-- ${key}:END -->)`);
  return readme.replace(re, `$1\n${content}\n$2`);
}

function releasesSection(repos) {
  const perOwner = new Map();
  return repos
    .filter((r) => r.latestRelease && !r.latestRelease.isPrerelease && !r.isArchived)
    .sort((a, b) => b.latestRelease.publishedAt.localeCompare(a.latestRelease.publishedAt))
    .filter((r) => {
      const owner = r.nameWithOwner.split('/')[0];
      const n = perOwner.get(owner) ?? 0;
      perOwner.set(owner, n + 1);
      return n < 2;
    })
    .slice(0, 6)
    .map((r) => {
      const [owner, name] = r.nameWithOwner.split('/');
      return `- [**${esc(name)}** ${esc(r.latestRelease.tagName.replace(/^.*@(?=\d)/, 'v'))}](${r.latestRelease.url}) · <sub>${esc(owner)} · ${fmtDate(r.latestRelease.publishedAt)}</sub>`;
    })
    .join('\n');
}

async function blogSection() {
  const res = await fetch(FEED, { headers: { 'User-Agent': 'fadymondy-profile' } });
  if (!res.ok) throw new Error(`feed ${res.status}`);
  const xml = await res.text();
  const tag = (s, name) => (s.match(new RegExp(`<${name}>(?:<!\\[CDATA\\[)?([\\s\\S]*?)(?:\\]\\]>)?</${name}>`)) || [])[1]?.trim() ?? '';
  const decode = (s) => s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'");
  const items = [...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)].slice(0, 5).map(([, it]) => ({
    title: decode(tag(it, 'title')), link: tag(it, 'link'), date: tag(it, 'pubDate'),
  }));
  if (!items.length) throw new Error('feed has no items');
  return items.map((i) => `- [${i.title.replace(/[[\]]/g, '')}](${i.link}) · <sub>${fmtDate(new Date(i.date).toISOString())}</sub>`).join('\n');
}

// ---------- main ----------
const year = new Date().getUTCFullYear();
const userData = await gql(
  `query($login: String!, $from: DateTime!) { user(login: $login) {
    createdAt followers { totalCount }
    repositories(privacy: PUBLIC, ownerAffiliations: OWNER, isFork: false) { totalCount }
    lastYear: contributionsCollection { contributionCalendar { totalContributions } }
    thisYear: contributionsCollection(from: $from) { totalCommitContributions restrictedContributionsCount totalPullRequestContributions }
  } }`,
  { login: USER, from: `${year}-01-01T00:00:00Z` },
);
const u = userData.user;

const owners = [];
const allRepos = [];
for (const login of OWNERS) {
  const repos = await ownerRepos(login);
  allRepos.push(...repos);
  owners.push({ login, stars: repos.reduce((s, r) => s + r.stargazerCount, 0), repos: repos.length });
}
owners.sort((a, b) => b.stars - a.stars);
const totalStars = owners.reduce((s, o) => s + o.stars, 0);

const langTotals = new Map();
for (const r of allRepos.filter((r) => !r.isArchived))
  for (const e of r.languages.edges)
    if (!IGNORED_LANGS.has(e.node.name)) langTotals.set(e.node.name, (langTotals.get(e.node.name) ?? 0) + e.size);
const langs = [...langTotals.entries()].map(([name, size]) => ({ name, size })).sort((a, b) => b.size - a.size).slice(0, 8);

const streak = streaks(await contributionDays(u.createdAt));
const stats = {
  stars: totalStars, lastYear: u.lastYear.contributionCalendar.totalContributions, year,
  commits: u.thisYear.totalCommitContributions + u.thisYear.restrictedContributionsCount,
  prs: u.thisYear.totalPullRequestContributions, repos: allRepos.length, accounts: OWNERS.length, followers: u.followers.totalCount,
};

await mkdir(OUT, { recursive: true });
for (const [name, t] of Object.entries(THEMES)) {
  await writeFile(`${OUT}/stats-${name}.svg`, statsCard(t, stats));
  await writeFile(`${OUT}/languages-${name}.svg`, langCard(t, langs));
  await writeFile(`${OUT}/streak-${name}.svg`, streakCard(t, streak));
  await writeFile(`${OUT}/stars-${name}.svg`, starsCard(t, owners, totalStars));
}
await writeFile(`${OUT}/stats.json`, JSON.stringify({ stats, owners, langs, streak: { total: streak.total, current: streak.current.len, longest: streak.longest.len } }, null, 2) + '\n');

let readme = await readFile('README.md', 'utf8');
readme = replaceSection(readme, 'RELEASES', releasesSection(allRepos));
try {
  readme = replaceSection(readme, 'BLOG', await blogSection());
} catch (e) {
  console.warn(`Blog feed skipped, keeping the previous list: ${e.message}`);
}
await writeFile('README.md', readme);
console.log(`stars=${totalStars} repos=${allRepos.length} langs=${langs.map((l) => l.name).join(',')} streak=${streak.current.len}/${streak.longest.len}`);
