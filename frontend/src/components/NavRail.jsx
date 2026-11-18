import React from 'react';

export default function NavRail({ items, current, onSelect, onLogout, brand = 'N' }) {
  return (
    <aside
      aria-label="Primary navigation"
      className="hidden w-[76px] shrink-0 flex-col items-center border-r border-line-subtle/80 bg-graphite/70 py-4 backdrop-blur md:flex"
    >
      <div className="mb-6 flex h-10 w-10 items-center justify-center rounded-xl border border-violet/40 bg-violet/15 font-display text-lg font-bold text-ultraviolet text-glow-violet">
        {brand}
      </div>

      <nav className="flex flex-1 flex-col items-center gap-1">
        {items.map(item => {
          const Icon = item.icon;
          const active = current === item.id;
          return (
            <button
              key={item.id}
              type="button"
              onClick={() => onSelect(item.id)}
              aria-current={active ? 'page' : undefined}
              aria-label={item.label}
              title={item.label}
              className={`group relative flex h-11 w-11 items-center justify-center rounded-xl transition-colors duration-150 ${
                active
                  ? 'bg-violet/15 text-ultraviolet'
                  : 'text-ink-muted hover:bg-panel-2 hover:text-ink-primary'
              }`}
            >
              {active && (
                <span className="absolute -left-[13px] h-6 w-[2px] rounded-full bg-violet" aria-hidden="true" />
              )}
              <Icon size={19} strokeWidth={1.9} />
            </button>
          );
        })}
      </nav>

      <button
        type="button"
        onClick={onLogout}
        aria-label="Sign out"
        title="Sign out"
        className="flex h-11 w-11 items-center justify-center rounded-xl text-ink-muted transition-colors hover:bg-negative/10 hover:text-negative"
      >
        <svg viewBox="0 0 24 24" width="19" height="19" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
          <polyline points="16 17 21 12 16 7" />
          <line x1="21" y1="12" x2="9" y2="12" />
        </svg>
      </button>
    </aside>
  );
}
