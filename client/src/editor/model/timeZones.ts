/**
 * Time zones a rule can evaluate dates in: Windows time zone ids, which the plug-in resolves with
 * TimeZoneInfo.FindSystemTimeZoneById, labelled as Dataverse labels them. The empty id is UTC,
 * the default (asx_evaluationtimezone blank).
 */
export const TIME_ZONE_OPTIONS: ReadonlyArray<{ id: string; label: string }> = [
  { id: "", label: "UTC (default)" },
  { id: "Hawaiian Standard Time", label: "(GMT-10:00) Hawaii" },
  { id: "Alaskan Standard Time", label: "(GMT-09:00) Alaska" },
  { id: "Pacific Standard Time", label: "(GMT-08:00) Pacific Time (US & Canada)" },
  { id: "Mountain Standard Time", label: "(GMT-07:00) Mountain Time (US & Canada)" },
  { id: "Central Standard Time", label: "(GMT-06:00) Central Time (US & Canada)" },
  { id: "Eastern Standard Time", label: "(GMT-05:00) Eastern Time (US & Canada)" },
  { id: "Atlantic Standard Time", label: "(GMT-04:00) Atlantic Time (Canada)" },
  { id: "Newfoundland Standard Time", label: "(GMT-03:30) Newfoundland" },
  { id: "E. South America Standard Time", label: "(GMT-03:00) Brasilia" },
  { id: "GMT Standard Time", label: "(GMT+00:00) Dublin, Edinburgh, Lisbon, London" },
  { id: "W. Europe Standard Time", label: "(GMT+01:00) Amsterdam, Berlin, Bern, Rome, Stockholm, Vienna" },
  { id: "Romance Standard Time", label: "(GMT+01:00) Brussels, Copenhagen, Madrid, Paris" },
  { id: "Central Europe Standard Time", label: "(GMT+01:00) Belgrade, Bratislava, Budapest, Ljubljana, Prague" },
  { id: "South Africa Standard Time", label: "(GMT+02:00) Harare, Pretoria" },
  { id: "Arabian Standard Time", label: "(GMT+04:00) Abu Dhabi, Muscat" },
  { id: "India Standard Time", label: "(GMT+05:30) Chennai, Kolkata, Mumbai, New Delhi" },
  { id: "Singapore Standard Time", label: "(GMT+08:00) Kuala Lumpur, Singapore" },
  { id: "China Standard Time", label: "(GMT+08:00) Beijing, Chongqing, Hong Kong, Urumqi" },
  { id: "Tokyo Standard Time", label: "(GMT+09:00) Osaka, Sapporo, Tokyo" },
  { id: "AUS Eastern Standard Time", label: "(GMT+10:00) Canberra, Melbourne, Sydney" },
  { id: "New Zealand Standard Time", label: "(GMT+12:00) Auckland, Wellington" },
];

/** Dropdown value for UTC: Fluent options need a non-empty value. */
export const UTC_OPTION = "utc";

export function timeZoneLabel(id: string | null | undefined): string {
  const key = id ?? "";
  return TIME_ZONE_OPTIONS.find((o) => o.id === key)?.label ?? key;
}

/** "UTC" or the zone's offset ("GMT-05:00"), for compact schedule text. */
export function timeZoneShort(id: string | null | undefined): string {
  if (!id) return "UTC";
  const m = /^\((GMT[^)]*)\)/.exec(timeZoneLabel(id));
  return m ? m[1] : id;
}
