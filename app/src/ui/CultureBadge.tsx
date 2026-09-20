import type { Culture } from '../lab/cultures';
export function CultureBadge({ c, extra }: { c: Culture; extra?: string }) {
  return (
    <span class="badge" style={{ '--c': c.color } as any}>
      <i /> {c.name}
      {extra ? <span style="color:var(--fg-3)"> {extra}</span> : null}
    </span>
  );
}
