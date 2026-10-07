import * as React from "react";
import {
  Button, SplitButton, Menu, MenuTrigger, MenuPopover, MenuList, MenuItem, MenuGroup,
  MenuGroupHeader, MenuDivider, type MenuButtonProps,
} from "@fluentui/react-components";
import { Play16Regular, Beaker16Regular, Beaker20Regular, Play20Regular, History20Regular } from "@fluentui/react-icons";
import { color } from "../tokens";

const ItemText: React.FC<{ label: string; sub?: string }> = ({ label, sub }) => (
  <span style={{ display: "flex", flexDirection: "column", lineHeight: 1.3 }}>
    <span>{label}</span>
    {sub && <span style={{ fontSize: 11.5, color: color.inkMuted }}>{sub}</span>}
  </span>
);

/**
 * Run actions follow the PUBLISHED revision, never the draft's status. A rule that
 * was never published gets a plain Preview button (a dry run of the draft).
 */
export function RunMenuButton({
  everPublished, version, applyAvailable, disabled, onPreview, onApply, onViewRuns,
}: {
  everPublished: boolean;
  version: number;
  /** The published triggers include On demand and the rule is live. */
  applyAvailable: boolean;
  disabled?: boolean;
  onPreview(): void;
  onApply(): void;
  onViewRuns(): void;
}) {
  if (!everPublished) {
    return <Button icon={<Beaker16Regular />} disabled={disabled} onClick={onPreview}>Preview</Button>;
  }
  return (
    <Menu positioning="below-end">
      <MenuTrigger disableButtonEnhancement>
        {(triggerProps: MenuButtonProps) => (
          <SplitButton
            icon={<Play16Regular />}
            disabled={disabled}
            menuButton={{ ...triggerProps, "aria-label": "More run options" } as MenuButtonProps}
            primaryActionButton={{ onClick: onPreview }}
          >
            Run
          </SplitButton>
        )}
      </MenuTrigger>
      <MenuPopover>
        <MenuList>
          <MenuGroup>
            <MenuGroupHeader>Published v{version}</MenuGroupHeader>
            <MenuItem icon={<Beaker20Regular />} onClick={onPreview}>
              <ItemText label="Preview on a record…" sub="No changes are saved" />
            </MenuItem>
            {applyAvailable && (
              <MenuItem icon={<Play20Regular />} onClick={onApply}>
                <ItemText label="Apply to records…" sub="Runs actions and writes data" />
              </MenuItem>
            )}
          </MenuGroup>
          <MenuDivider />
          <MenuItem icon={<History20Regular />} onClick={onViewRuns}>View runs</MenuItem>
        </MenuList>
      </MenuPopover>
    </Menu>
  );
}
