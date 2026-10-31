/** A settings row that reads as a labelled switch. */
export function Switch({
  title,
  sub,
  on,
  onChange,
  disabled,
}: {
  title: string;
  sub?: string;
  on: boolean;
  onChange(value: boolean): void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      className="switch"
      data-on={on}
      onClick={() => onChange(!on)}
      role="switch"
      aria-checked={on}
      disabled={disabled}
    >
      <span className="switch-text">
        <span className="switch-title">{title}</span>
        {sub && <span className="switch-sub">{sub}</span>}
      </span>
      <span className="switch-track" />
    </button>
  );
}
