export function Lock() {
  return (
    <svg className="lock" viewBox="0 0 12 12" aria-label="Status owned by Jira" role="img">
      <title>Status owned by Jira</title>
      <rect x="2.5" y="5.2" width="7" height="5.5" rx="1" fill="currentColor" />
      <path
        d="M4.2 5.2V3.8a1.8 1.8 0 0 1 3.6 0v1.4"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.3"
      />
    </svg>
  );
}

/** Steward's icon, Facet: a diamond with its left half filled. */
export function Facet({ size = 16 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M8 1.5 14.5 8 8 14.5 1.5 8Z" />
      <path d="M8 1.5v13L1.5 8z" fill="currentColor" />
    </svg>
  );
}
