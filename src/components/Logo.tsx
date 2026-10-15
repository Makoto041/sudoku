/** 3×3 の格子に、ひとつだけ色の付いたマス */
export function Logo({ size = 32 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 48 48" aria-hidden="true" className="logo">
      <rect
        x="1.5"
        y="1.5"
        width="45"
        height="45"
        rx="11"
        fill="var(--surface)"
        stroke="var(--ink)"
        strokeWidth="3"
      />
      <path d="M16.5 3v42M31.5 3v42M3 16.5h42M3 31.5h42" stroke="var(--ink)" strokeWidth="2" opacity="0.28" />
      <rect x="18" y="18" width="12" height="12" rx="3" fill="var(--accent)" />
    </svg>
  );
}
