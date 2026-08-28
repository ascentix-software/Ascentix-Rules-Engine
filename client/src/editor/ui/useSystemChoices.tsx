import * as React from "react";
import { useMetadataService } from "./useMetadata";
import { humanize } from "./humanize";
import {
  SYSTEM_CHOICE_NAMES, buildChoiceMaps, resolveChoiceLabel, type ChoiceMaps,
} from "./choiceLabels";

const ChoiceMapsContext = React.createContext<ChoiceMaps>({});

export function SystemChoicesProvider({ children }: { children: React.ReactNode }) {
  const svc = useMetadataService();
  const [maps, setMaps] = React.useState<ChoiceMaps>({});
  React.useEffect(() => {
    let live = true;
    Promise.all(
      SYSTEM_CHOICE_NAMES.map((name) =>
        svc.globalOptionSet(name).then((options) => ({ name, options })).catch(() => ({ name, options: [] })),
      ),
    ).then((entries) => { if (live) setMaps(buildChoiceMaps(entries)); });
    return () => { live = false; };
  }, [svc]);
  return <ChoiceMapsContext.Provider value={maps}>{children}</ChoiceMapsContext.Provider>;
}

// Returns a stable resolver: (choiceName, value, fallbackToken) => localized label or humanized fallback.
export function useChoiceLabel(): (choiceName: string, value: number | null, fallbackToken: string) => string {
  const maps = React.useContext(ChoiceMapsContext);
  return React.useCallback(
    (choiceName, value, fallbackToken) =>
      resolveChoiceLabel(maps, choiceName, value, humanize(fallbackToken)),
    [maps],
  );
}
