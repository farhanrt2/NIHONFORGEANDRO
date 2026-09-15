interface SpinnerProps {
  text?: string;
  full?: boolean;
}

export default function Spinner({ text, full }: SpinnerProps) {
  const content = (
    <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 12, padding: 24 }}>
      <div
        style={{
          width: 32,
          height: 32,
          border: "3px solid rgba(47,230,230,0.2)",
          borderTopColor: "var(--cyan)",
          borderRadius: "50%",
          animation: "spin 0.7s linear infinite",
        }}
      />
      {text && <div style={{ color: "var(--cyan)", fontSize: 14 }}>{text}</div>}
    </div>
  );

  if (full) {
    return (
      <div style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center" }}>
        {content}
      </div>
    );
  }

  return content;
}
