"use client";

import { useMemo, useState } from "react";

export interface ReferencePickerOption {
  label: string;
  value: string;
  group?: string;
}

export interface ReferencePickerProps {
  /** 可选项列表 */
  options: ReferencePickerOption[];
  /** 当前选中值 */
  value?: string;
  /** 变更回调 */
  onChange: (value: string) => void;
  /** placeholder */
  placeholder?: string;
  /** 是否支持搜索（默认 true） */
  searchable?: boolean;
  /** 是否禁用 */
  disabled?: boolean;
}

const inputStyle: React.CSSProperties = {
  width: "100%",
  padding: 8,
  boxSizing: "border-box",
};

const listStyle: React.CSSProperties = {
  position: "absolute",
  top: "100%",
  left: 0,
  right: 0,
  maxHeight: 200,
  overflowY: "auto",
  background: "#fff",
  border: "1px solid #ccc",
  borderTop: "none",
  zIndex: 10,
  margin: 0,
  padding: 0,
  listStyle: "none",
};

const itemStyle: React.CSSProperties = {
  padding: "6px 8px",
  cursor: "pointer",
};

/**
 * 轻量级引用选择器：支持搜索过滤 + 分组显示。
 * 当 options 为空时退化为普通文本输入。
 */
export function ReferencePicker({
  options,
  value,
  onChange,
  placeholder,
  searchable = true,
  disabled,
}: ReferencePickerProps) {
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);

  const selectedLabel = useMemo(
    () => options.find((o) => o.value === value)?.label ?? "",
    [options, value],
  );

  const filtered = useMemo(() => {
    if (!searchable || !query) return options;
    const q = query.toLowerCase();
    return options.filter(
      (o) => o.label.toLowerCase().includes(q) || o.value.toLowerCase().includes(q),
    );
  }, [options, query, searchable]);

  // 无 options 时退化为纯文本输入
  if (!options.length) {
    return (
      <input
        type="text"
        style={inputStyle}
        value={value ?? ""}
        placeholder={placeholder}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
      />
    );
  }

  const displayText = open ? query : selectedLabel || (value ?? "");

  return (
    <div style={{ position: "relative" }}>
      <input
        type="text"
        style={inputStyle}
        value={displayText}
        placeholder={placeholder}
        disabled={disabled}
        readOnly={!searchable}
        onFocus={() => {
          setOpen(true);
          setQuery("");
        }}
        onBlur={() => setTimeout(() => setOpen(false), 150)}
        onChange={(e) => setQuery(e.target.value)}
      />
      {open && filtered.length > 0 && (
        <ul style={listStyle}>
          {filtered.map((o) => (
            <li
              key={o.value}
              style={{
                ...itemStyle,
                background: o.value === value ? "#e6f0ff" : undefined,
              }}
              onMouseDown={(e) => {
                e.preventDefault();
                onChange(o.value);
                setOpen(false);
              }}
            >
              {o.group ? <small style={{ color: "#888" }}>{o.group} / </small> : null}
              {o.label}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
