/** "Skip to content": the first tab stop, visible only while focused (spec 09, item 5). */
export function SkipLink({ target = "main" }: { target?: string }) {
  return (
    <a
      className="skip-link"
      href={`#${target}`}
      onClick={(e) => {
        e.preventDefault();
        document.getElementById(target)?.focus();
      }}
    >
      Skip to content
    </a>
  );
}
