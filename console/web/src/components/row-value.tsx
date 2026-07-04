export function RowValue({ value, href }: { value: string; href?: string }) {
  if (href) {
    return (
      <a className="check-row-value" href={href} target="_blank" rel="noreferrer">
        <strong>{value}</strong>
      </a>
    )
  }
  return (
    <span className="check-row-value">
      <strong>{value}</strong>
    </span>
  )
}
