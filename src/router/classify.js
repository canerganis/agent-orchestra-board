// Router task classifier. Pure: no I/O, no model calls.
// Rules follow ROUTER-PLAN.md section 2.2. Returns { type, group, difficulty, reasons }.

const GROUPS = {
  plan: 'code',
  arch: 'code',
  research: 'code',
  backend: 'code',
  refactor: 'code',
  security: 'security',
  ui: 'ui',
  tests: 'tests-docs',
  docs: 'tests-docs',
};
const TYPES = Object.keys(GROUPS);

const PLANNER_HINT_POINTS = 3;
const SECURITY_STICKY_POINTS = 3;
const HARD_PATH_COUNT = 9;

const SECURITY_SEGMENT = /secur|auth|sandbox|capab|contain|permission|crypto|token/;
const SECURITY_WORDS = /\b(secur|sandbox|injection|escape|secret|permission|containment)/;
const REFACTOR_WORDS = /\b(refactor|rename|extract|migrate|split)/;
const ARCH_WORDS = /\b(design|architecture|protocol|interface)|\badr\b/;
const RESEARCH_WORDS = /\b(investigate|compare|measure|benchmark)/;
const HARD_WORDS = /\b(race|lock|concurren|migration)/;

const RANK = { easy: 0, medium: 1, hard: 2 };

// Path segments are lowercased, backslashes normalized to '/'.
function splitPath(file) {
  return String(file).replace(/\\/g, '/').toLowerCase().split('/').filter(Boolean);
}

function extOf(name) {
  const i = name.lastIndexOf('.');
  return i > 0 ? name.slice(i) : '';
}

function isTestPath(segs) {
  const base = segs[segs.length - 1] || '';
  return segs.slice(0, -1).some((d) => d === 'test' || d === 'tests' || d === 'fixtures' || d === 'fixture')
    || /\.(test|spec)\./.test(base);
}

function isUiPath(segs) {
  const base = segs[segs.length - 1] || '';
  return segs.slice(0, -1).includes('public') || ['.css', '.html'].includes(extOf(base));
}

function isDocsPath(segs) {
  const base = segs[segs.length - 1] || '';
  return segs.slice(0, -1).includes('docs') || extOf(base) === '.md';
}

function isSecurityPath(segs) {
  return segs.some((s) => SECURITY_SEGMENT.test(s));
}

function isSrcPath(segs) {
  return segs.slice(0, -1).includes('src');
}

// Returns { type, group, difficulty, reasons }. Never throws on partial items.
function classify(item) {
  const it = item || {};
  const paths = Array.isArray(it.owns) ? it.owns.map(String) : [];
  const segs = paths.map(splitPath);
  const text = `${it.title || ''}\n${it.spec || ''}`.toLowerCase();

  const scores = {};
  const reasons = [];
  const add = (type, points, why) => {
    scores[type] = (scores[type] || 0) + points;
    reasons.push(`${type} +${points}: ${why}`);
  };

  // File rules count once per item, not once per file.
  if (segs.some(isTestPath)) add('tests', 2, 'owns a test, fixture or *.test.* path');
  if (segs.some(isUiPath)) add('ui', 2, 'owns a public/, CSS or HTML path');
  if (segs.some(isDocsPath)) add('docs', 2, 'owns a docs/ or *.md path');
  if (segs.some(isSecurityPath)) {
    add('security', 3, 'owns a path segment about security, auth, sandbox, capability, containment, permission, crypto or token');
  }

  // Keyword rules.
  if (SECURITY_WORDS.test(text)) add('security', 2, 'title or spec names a security term');
  if (REFACTOR_WORDS.test(text)) add('refactor', 2, 'title or spec names a refactor verb');
  if (ARCH_WORDS.test(text)) add('arch', 1, 'title or spec names a design, architecture, protocol or interface');
  if (RESEARCH_WORDS.test(text)) add('research', 1, 'title or spec names an investigate, compare, measure or benchmark verb');

  // Planner hint: counts only when the plan item carries a valid type.
  if (TYPES.includes(it.type)) add(it.type, PLANNER_HINT_POINTS, 'planner gave the type');

  if (Object.keys(scores).length === 0 && segs.some(isSrcPath)) {
    add('backend', 1, 'owns src/ and nothing else matched');
  }

  // Merge: security is sticky at 3 or more points, otherwise the highest total wins.
  let type;
  if ((scores.security || 0) >= SECURITY_STICKY_POINTS) {
    type = 'security';
    reasons.push(`security is sticky at ${scores.security} points`);
  } else {
    for (const t of TYPES) {
      if (scores[t] && (type === undefined || scores[t] > scores[type])) type = t;
    }
    if (type === undefined) {
      type = 'backend';
      reasons.push('no signals, defaulted to backend');
    }
  }
  reasons.push(`type ${type} (score ${scores[type] || 0})`);

  // Difficulty: rules only raise it, never lower it.
  let difficulty = 'easy';
  const raise = (level, why) => {
    if (RANK[level] > RANK[difficulty]) difficulty = level;
    reasons.push(`difficulty ${level}: ${why}`);
  };
  if (type === 'security' && paths.length > 0) raise('hard', 'security item that writes to owned paths');
  if (paths.length >= HARD_PATH_COUNT) raise('hard', `owns ${paths.length} paths (more than 8)`);
  if (HARD_WORDS.test(text)) raise('hard', 'spec mentions race, lock, concurrency or migration');
  if (difficulty === 'easy') reasons.push('difficulty easy: no raising signal');

  return { type, group: GROUPS[type], difficulty, reasons };
}

module.exports = { classify, GROUPS, TYPES };
