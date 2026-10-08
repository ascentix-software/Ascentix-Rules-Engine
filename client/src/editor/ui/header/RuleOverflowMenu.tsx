import {
  Button, Menu, MenuTrigger, MenuPopover, MenuList, MenuItem, MenuGroup, MenuGroupHeader, MenuDivider,
  CounterBadge,
} from "@fluentui/react-components";
import {
  MoreHorizontal20Regular, DocumentSearch20Regular, CheckmarkCircle20Regular, Eye20Regular,
  ArrowReset20Regular, ArrowClockwise20Regular, PauseCircle20Regular, Delete20Regular,
} from "@fluentui/react-icons";
import { color } from "../tokens";

/**
 * The header's ⋯ menu. Items that don't apply are left out (not disabled), except
 * Review changes, which stays visible and disables at zero changes.
 */
export function RuleOverflowMenu({
  dirtyCount, version, disabled,
  onReviewChanges, onCheckIssues, onViewPublished, onRestoreDraft, onDiscardDraft, onReload, onUnpublish,
}: {
  dirtyCount: number;
  version: number;
  disabled?: boolean;
  onReviewChanges(): void;
  /** Absent while nothing can be checked (viewing the published version). */
  onCheckIssues?: () => void;
  onViewPublished?: () => void;
  onRestoreDraft?: () => void;
  /** Deletes the working draft of a live rule. */
  onDiscardDraft?: () => void;
  onReload?: () => void;
  onUnpublish?: () => void;
}) {
  const publishedGroup = !!onViewPublished || !!onRestoreDraft || !!onDiscardDraft;
  return (
    <Menu positioning="below-end">
      <MenuTrigger disableButtonEnhancement>
        <Button appearance="outline" icon={<MoreHorizontal20Regular />} aria-label="More actions" disabled={disabled}
          style={{ minWidth: 32, width: 32, height: 32, padding: 0 }} />
      </MenuTrigger>
      <MenuPopover>
        <MenuList>
          <MenuItem icon={<DocumentSearch20Regular />} disabled={dirtyCount === 0} onClick={onReviewChanges}
            secondaryContent={dirtyCount > 0 ? <CounterBadge count={dirtyCount} appearance="ghost" color="informative" size="small" /> : undefined}>
            Review changes
          </MenuItem>
          {onCheckIssues && <MenuItem icon={<CheckmarkCircle20Regular />} onClick={onCheckIssues}>Check for issues</MenuItem>}
          {publishedGroup && (
            <>
              <MenuDivider />
              <MenuGroup>
                <MenuGroupHeader>Published v{version}</MenuGroupHeader>
                {onViewPublished && <MenuItem icon={<Eye20Regular />} onClick={onViewPublished}>View published</MenuItem>}
                {onRestoreDraft && <MenuItem icon={<ArrowReset20Regular />} onClick={onRestoreDraft}>Restore published to draft…</MenuItem>}
                {onDiscardDraft && (
                  <MenuItem icon={<Delete20Regular style={{ color: color.danger }} />} onClick={onDiscardDraft} style={{ color: color.danger }}>
                    Discard draft…
                  </MenuItem>
                )}
              </MenuGroup>
            </>
          )}
          {(onReload || onUnpublish) && <MenuDivider />}
          {onReload && <MenuItem icon={<ArrowClockwise20Regular />} onClick={onReload}>Reload from server</MenuItem>}
          {onUnpublish && (
            <MenuItem icon={<PauseCircle20Regular style={{ color: color.danger }} />} onClick={onUnpublish}
              style={{ color: color.danger }}>
              Unpublish…
            </MenuItem>
          )}
        </MenuList>
      </MenuPopover>
    </Menu>
  );
}
