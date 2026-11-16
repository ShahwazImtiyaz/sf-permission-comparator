// Shared helpers used across multiple tab components

export function isDiff(values) {
  return new Set(values.map(String)).size > 1;
}

export function Check({ value }) {
  return value
    ? <span className="check yes">✓</span>
    : <span className="check no">—</span>;
}
