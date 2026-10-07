import * as React from "react";
import {
  TagPicker, TagPickerControl, TagPickerGroup, TagPickerInput, TagPickerList, TagPickerOption, Tag,
  type TagPickerProps,
} from "@fluentui/react-components";
import { color } from "../tokens";

export interface TagOption { value: string; label: string; secondary?: string }

/**
 * A multi-select with the selection as dismissible tags inside the control (no separate badge
 * row). Typing filters the options by label, value and secondary text.
 */
export function TagMultiPicker({
  ariaLabel, options, selected, onChange, placeholder, disabled, noOptionsText = "No matches",
}: {
  ariaLabel: string;
  options: TagOption[];
  selected: string[];
  onChange(next: string[]): void;
  placeholder?: string;
  disabled?: boolean;
  noOptionsText?: string;
}) {
  const [query, setQuery] = React.useState("");
  const byValue = React.useMemo(() => new Map(options.map((o) => [o.value, o])), [options]);
  const onOptionSelect: TagPickerProps["onOptionSelect"] = (_e, data) => {
    setQuery("");
    onChange(data.selectedOptions);
  };
  const q = query.trim().toLowerCase();
  const available = options.filter((o) => !selected.includes(o.value)
    && (!q || o.label.toLowerCase().includes(q) || o.value.toLowerCase().includes(q) || !!o.secondary?.toLowerCase().includes(q)));
  return (
    <TagPicker selectedOptions={selected} onOptionSelect={onOptionSelect} disabled={disabled}>
      <TagPickerControl expandIcon={null} style={{ paddingRight: 6 }}>
        <TagPickerGroup aria-label={`Selected ${ariaLabel.toLowerCase()}`}>
          {selected.map((v) => (
            <Tag key={v} shape="rounded" size="extra-small" value={v} dismissible
              dismissIcon={{ "aria-label": `Remove ${byValue.get(v)?.label ?? v}` }}>
              {byValue.get(v)?.label ?? v}
            </Tag>
          ))}
        </TagPickerGroup>
        <TagPickerInput aria-label={ariaLabel} value={query} placeholder={selected.length ? undefined : placeholder}
          // Shrinks beside the tags instead of claiming a line of its own.
          style={{ minWidth: selected.length ? 24 : 120, width: 0, flex: "1 1 24px" }}
          onChange={(e) => setQuery(e.target.value)} />
      </TagPickerControl>
      <TagPickerList>
        {available.length === 0 ? (
          <div style={{ padding: "6px 10px", fontSize: 13, color: color.inkMuted }}>{noOptionsText}</div>
        ) : available.map((o) => (
          <TagPickerOption key={o.value} value={o.value} text={o.label}
            secondaryContent={o.secondary}>
            {o.label}
          </TagPickerOption>
        ))}
      </TagPickerList>
    </TagPicker>
  );
}
