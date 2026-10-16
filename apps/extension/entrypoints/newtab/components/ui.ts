import type { CSSProperties } from "react";

export const btn: CSSProperties = {
  padding: "8px 16px",
  borderRadius: 4,
  border: "none",
  backgroundColor: "#0066cc",
  color: "white",
  cursor: "pointer",
  fontSize: 14,
};

export const errorBox: CSSProperties = {
  background: "#fdeceb",
  border: "1px solid #f5c6cb",
  color: "#a02620",
  fontSize: 13,
};

export const fieldLabel: CSSProperties = {
  display: "block",
  marginTop: 16,
  color: "#333",
  fontSize: 14,
};

export const input: CSSProperties = {
  width: "100%",
  boxSizing: "border-box",
  marginTop: 6,
  padding: "8px 10px",
  fontSize: 14,
  borderRadius: 4,
  border: "1px solid #ddd",
  fontFamily: "inherit",
};

export const select: CSSProperties = {
  display: "block",
  width: "100%",
  boxSizing: "border-box",
  marginTop: 6,
  padding: "8px 10px",
  fontSize: 14,
  borderRadius: 4,
  border: "1px solid #ddd",
  backgroundColor: "white",
};

/** For a select sitting inline in a sentence, e.g. "Every [24 hours]". */
export const selectInline: CSSProperties = {
  padding: "4px 8px",
  fontSize: 14,
  borderRadius: 4,
  border: "1px solid #ddd",
  backgroundColor: "white",
};

/** Small grey note under a field. */
export const hint: CSSProperties = {
  color: "#888",
  fontSize: 12,
  margin: "6px 0 0",
};
