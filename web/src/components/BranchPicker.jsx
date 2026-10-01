import React, { useState } from 'react';
import { Building2, ChevronDown, Check } from 'lucide-react';
import { useBranch } from '../lib/branch';

// Only rendered when the store actually has more than one branch, so a
// single-location shop never sees it.
export default function BranchPicker({ compact = false }) {
  const { branches, branch, multi, select } = useBranch();
  const [open, setOpen] = useState(false);

  if (!multi || !branch) return null;

  return (
    <div className={`branch-picker${compact ? ' compact' : ''}`}>
      <button
        type="button"
        className="branch-btn"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="listbox"
        aria-expanded={open}
        title="Which branch are you working at"
      >
        <Building2 size={15} />
        <span className="branch-name">{branch.name}</span>
        <ChevronDown size={14} />
      </button>
      {open ? (
        <>
          <div className="branch-scrim" onClick={() => setOpen(false)} />
          <ul className="branch-menu" role="listbox">
            {branches.map((b) => (
              <li key={b.id}>
                <button
                  type="button"
                  role="option"
                  aria-selected={Number(b.id) === Number(branch.id)}
                  className={Number(b.id) === Number(branch.id) ? 'on' : ''}
                  onClick={() => { select(b.id); setOpen(false); }}
                >
                  <span className="bm-name">{b.name}</span>
                  {b.isDefault ? <span className="bm-tag">default</span> : null}
                  {Number(b.id) === Number(branch.id) ? <Check size={15} /> : null}
                </button>
              </li>
            ))}
          </ul>
        </>
      ) : null}
    </div>
  );
}
