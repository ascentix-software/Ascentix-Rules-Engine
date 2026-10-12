import * as React from "react";

interface History<T> { past: T[]; present: T; future: T[]; }
type Action<T> =
  | { type: "edit"; value: React.SetStateAction<T> }
  | { type: "reset"; value: T }
  | { type: "undo" }
  | { type: "redo" };

function reduce<T>(state: History<T>, action: Action<T>): History<T> {
  if (action.type === "reset") return { past: [], present: action.value, future: [] };
  if (action.type === "undo") {
    if (!state.past.length) return state;
    return { past: state.past.slice(0, -1), present: state.past[state.past.length - 1], future: [state.present, ...state.future] };
  }
  if (action.type === "redo") {
    if (!state.future.length) return state;
    return { past: [...state.past, state.present], present: state.future[0], future: state.future.slice(1) };
  }
  const value = typeof action.value === "function"
    ? (action.value as (current: T) => T)(state.present) : action.value;
  if (JSON.stringify(value) === JSON.stringify(state.present)) return state;
  return { past: [...state.past.slice(-99), state.present], present: value, future: [] };
}

export function useEditHistory<T>(initial: () => T) {
  const [state, dispatch] = React.useReducer(reduce<T>, undefined, () => ({ past: [], present: initial(), future: [] }));
  return {
    value: state.present,
    set: React.useCallback((value: React.SetStateAction<T>) => dispatch({ type: "edit", value }), []),
    reset: React.useCallback((value: T) => dispatch({ type: "reset", value }), []),
    undo: () => dispatch({ type: "undo" }),
    redo: () => dispatch({ type: "redo" }),
    canUndo: state.past.length > 0,
    canRedo: state.future.length > 0,
  };
}
