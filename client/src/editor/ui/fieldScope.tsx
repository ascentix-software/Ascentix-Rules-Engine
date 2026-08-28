import * as React from "react";
import { FieldContextProvider } from "@fluentui/react-components";

/**
 * Ends the enclosing Fluent `<Field>`'s labelling scope for everything inside it.
 *
 * Fluent's `<Field>` does NOT wire its label to its child by cloning that child. It publishes
 * `{ generatedControlId, labelId, hintId, required, validationState }` on a React **context**,
 * and every Fluent form control (Input, Dropdown, Combobox, Checkbox, Switch, Textarea, …)
 * calls `useFieldControlProps_unstable()` and adopts `id = generatedControlId` when it has no
 * id of its own. Two consequences the docs don't spell out:
 *
 *  - the id reaches *every* field-aware control in the subtree, not just the first one, so a
 *    Field wrapping a composite hands the SAME id to all of them: duplicate ids, and the
 *    Field's `<label for>` binds to whichever the document-order lookup hits first;
 *  - React context flows through portals, so a `<Dialog>` or a `<Combobox>` popup rendered
 *    from inside a Field is still inside that Field as far as the id plumbing is concerned,
 *    even though its DOM lives at the document root.
 *
 * That is how the record picker's "Advanced filter" checkbox (wrapped in no Field anywhere in
 * our source) came to carry `id="field-rr__control"` and announce as "Value"
 * (see `test/editor/fluentFieldIds.dom.test.tsx` and `e2e/editorA11yIds.e2e.spec.ts`).
 *
 * Wrap the parts of a composite that are NOT the control the Field labels: the whole body of a
 * dialog (a dialog is its own labelling scope), the extra controls a picker renders next to or
 * inside its primary control. Leave the primary control outside the barrier so it still claims
 * the Field's id and its label keeps working. Controls placed inside must carry their own
 * accessible name (`aria-label` or a real label of their own).
 *
 * Rendering this outside any Field is a no-op.
 */
export const OutsideField: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <FieldContextProvider value={undefined}>{children}</FieldContextProvider>
);
