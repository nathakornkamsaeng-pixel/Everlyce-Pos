#!/usr/bin/env node
// Finds JSX components that are used but never imported or defined. A missing
// icon import crashes at render time with a blank white page, which is very
// hard to diagnose in a production bundle, so it is worth catching here.
import fs from 'node:fs';
import path from 'node:path';

const SRC = path.join(process.cwd(), 'src');

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (/\.jsx?$/.test(entry.name)) out.push(full);
  }
  return out;
}

// Names React provides without an import.
const BUILTINS = new Set([
  'React', 'Fragment', 'Suspense', 'StrictMode', 'Profiler',
  'useState', 'useEffect', 'useLayoutEffect', 'useMemo', 'useCallback', 'useRef',
  'useContext', 'useReducer', 'useId', 'useSyncExternalStore', 'useTransition',
  'useDeferredValue', 'useImperativeHandle', 'useDebugValue', 'useInsertionEffect',
  'memo', 'forwardRef', 'lazy', 'createContext', 'createElement', 'cloneElement',
  'Children', 'isValidElement', 'Component', 'PureComponent',
  'Navigate', 'Routes', 'Route', 'Link', 'NavLink', 'Outlet', 'useNavigate',
  'useLocation', 'useParams', 'useSearchParams', 'NavigateOptions',
]);

// Lower-case tags are DOM elements. <div className> is fine.
function isComponent(name) {
  return /^[A-Z]/.test(name);
}

let problems = 0;
const files = walk(SRC).sort();

for (const file of files) {
  const src = fs.readFileSync(file, 'utf8');

  // Every identifier bound by an import, require, function, class or const.
  const defined = new Set(BUILTINS);
  for (const m of src.matchAll(/^import\s+(?:([\w*\s{},]+))\s+from/gm)) {
    for (const raw of m[1].replace(/[{}]/g, ' ').split(',')) {
      const name = raw.trim().split(/\s+as\s+/).pop().trim();
      if (name && name !== '*') defined.add(name);
    }
  }
  for (const m of src.matchAll(/\b(?:function|class)\s+([A-Z][\w$]*)/g)) defined.add(m[1]);
  for (const m of src.matchAll(/(?:const|let|var)\s+([A-Z][\w$]*)\s*=/g)) defined.add(m[1]);
  for (const m of src.matchAll(/(?:const|let|var)\s+\{([^}]*)\}\s*=/g)) {
    for (const raw of m[1].split(',')) {
      const name = raw.split(':').pop().trim().split('=')[0].trim();
      if (name) defined.add(name);
    }
  }
  // Names pulled in by destructuring a function parameter, e.g.
  // function Empty({ icon: Icon }) renders <Icon />. Those are local, not
  // missing, so treat every destructured name as defined.
  // A `{ ... }` immediately before a `)` is a destructured parameter list, as in
  // function Empty({ icon: Icon, title }) { ... } or ({ icon: Icon }) => ...
  for (const m of src.matchAll(/\{([^{}]*)\}\s*\)/g)) {
    for (const raw of m[1].split(',')) {
      const name = raw.split(':').pop().trim().split('=')[0].trim();
      if (/^[A-Z]/.test(name)) defined.add(name);
    }
  }
  for (const m of src.matchAll(/<([A-Z][\w$.]*)/g)) {
    // only the root name matters; MemberExpression roots are props
    const root = m[1].split('.')[0];
    if (root && !defined.has(root)) {
      const line = src.slice(0, m.index).split('\n').length;
      console.log(`${path.relative(SRC, file)}:${line}  <${m[1]}> is used but never imported or defined`);
      problems += 1;
    }
  }
}

if (problems) {
  console.log(`\n${problems} problem(s). Each of these throws at render time.`);
  process.exit(1);
}
console.log('No undefined JSX components.');
