import type * as React from "react";

// Shared Enter/Space activation for clickable non-button rows (GraphTree nodes,
// hub rows). Ignores events bubbling from inner interactive elements so nested
// buttons keep their own key handling.
export function activateOnKey(onActivate: () => void) {
  return (e: React.KeyboardEvent) => {
    if (e.target !== e.currentTarget) return; // let inner buttons handle their own keys
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      onActivate();
    }
  };
}
