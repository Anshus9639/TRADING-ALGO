import React from 'react';

export default function BottomNav({ items, current, onSelect }) {
  return (
    <nav
      aria-label="Section navigation"
      className="safe-bottom fixed inset-x-0 bottom-0 z-30 flex border-t border-line-subtle/80 bg-graphite/95 backdrop-blur md:hidden"
    >
      {items.map(item => {
        const Icon = item.icon;
        const active = current === item.id;
        return (
          <button
            key={item.id}
            type="button"
            onClick={() => onSelect(item.id)}
            aria-current={active ? 'page' : undefined}
            className={`flex flex-1 flex-col items-center gap-1 py-2.5 text-[10px] font-semibold uppercase tracking-wider transition-colors ${
              active ? 'text-ultraviolet' : 'text-ink-muted'
            }`}
          >
            <Icon size={18} strokeWidth={1.9} aria-hidden="true" />
            {item.label}
          </button>
        );
      })}
    </nav>
  );
}
