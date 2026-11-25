import {
  type ComponentPropsWithoutRef,
  type ReactNode,
  type Ref,
  useLayoutEffect,
  useRef,
} from "react";
import "../../styles/replybox.css";

/**
 * The parts of the Desk composer (the reply box), shared by every place that writes a message to
 * an agent: the rounded box with its focus ring, the auto-growing textarea, errors, the toolbar of
 * chips, and the round send button. The look lives in replybox.css (`rc-*`).
 */

export const Glyph = ({ d }: { d: string }) => (
  <svg
    width="14"
    height="14"
    viewBox="0 0 14 14"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.4"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    <path d={d} />
  </svg>
);
export const ARROW_UP = "M7 11.5v-9M3 6.2 7 2.2l4 4";
export const CHEVRON_DOWN = "m3 5 4 4 4-4";
export const FOLDER =
  "M1.8 4.2c0-.6.4-1 1-1h2.6l1.2 1.4h4.6c.6 0 1 .4 1 1v4.8c0 .6-.4 1-1 1H2.8c-.6 0-1-.4-1-1z";
export const PLUS = "M7 2.8v8.4M2.8 7h8.4";

type BoxProps = { children: ReactNode; ref?: Ref<HTMLFormElement> } & (
  | ({ as: "form" } & ComponentPropsWithoutRef<"form">)
  | ({ as?: "div" } & ComponentPropsWithoutRef<"div">)
);

/** The rounded container. A `form` for a stand-alone composer, a `div` inside another form. */
export function ComposerBox(props: BoxProps) {
  if (props.as === "form") {
    const { as: _as, className, ...rest } = props;
    return <form {...rest} className={`rc-box${className ? ` ${className}` : ""}`} />;
  }
  const { as: _as, ref: _ref, className, ...rest } = props;
  return <div {...rest} className={`rc-box${className ? ` ${className}` : ""}`} />;
}

type TextProps = Omit<ComponentPropsWithoutRef<"textarea">, "className"> & {
  value: string;
  ref?: Ref<HTMLTextAreaElement>;
  /** Re-measure when this changes (e.g. the box opening). */
  measureOn?: unknown;
};

/** A borderless textarea that grows with its text, up to the CSS max-height. */
export function ComposerText({ ref, measureOn, value, ...rest }: TextProps) {
  const own = useRef<HTMLTextAreaElement | null>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: the text and `measureOn` are the triggers
  useLayoutEffect(() => {
    const el = own.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  }, [value, measureOn]);
  return (
    <textarea
      rows={1}
      {...rest}
      value={value}
      className="rc-text"
      ref={(el) => {
        own.current = el;
        if (typeof ref === "function") ref(el);
        else if (ref) ref.current = el;
      }}
    />
  );
}

export const ComposerNote = ({ children }: { children: ReactNode }) => (
  <p className="rc-note" role="status">
    {children}
  </p>
);

export const ComposerError = ({ children }: { children: ReactNode }) => (
  <div className="rc-error" role="alert">
    {children}
  </div>
);

/** The chips on the left, the actions (hint, send) on the right. */
export function ComposerToolbar({ chips, actions }: { chips: ReactNode; actions: ReactNode }) {
  return (
    <div className="rc-bottom">
      <div className="rc-chips">{chips}</div>
      <div className="rc-actions">{actions}</div>
    </div>
  );
}

/** The round send button; ready (filled) when it can send. */
export function SendButton({
  ready,
  sending,
  label,
  title,
  disabled,
}: {
  ready: boolean;
  sending: boolean;
  label: string;
  title: string;
  /** Defaults to "not ready". */
  disabled?: boolean;
}) {
  return (
    <button
      type="submit"
      className={`rc-send${ready ? " ready" : ""}`}
      disabled={disabled ?? !ready}
      aria-busy={sending || undefined}
      aria-label={label}
      title={title}
    >
      {sending ? <span className="rc-spin" aria-hidden="true" /> : <Glyph d={ARROW_UP} />}
    </button>
  );
}
