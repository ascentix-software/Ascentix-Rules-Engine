export const publishedRuleId = "11111111-1111-1111-1111-111111111111";
export const publishedModelId = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
export const publishedDefinition = JSON.stringify({ Format: 1, RuleId: publishedRuleId, Rows: [
  { Entity: "asx_rule", Id: publishedRuleId, Attributes: [
    { Key: "asx_name", Value: { Kind: "string", Value: "Frozen version" } },
    { Key: "asx_tablelogicalname", Value: { Kind: "string", Value: "account" } },
    { Key: "statuscode", Value: { Kind: "option", Value: "753840000" } },
    { Key: "asx_triggers", Value: { Kind: "options", Value: "2,3" } },
    { Key: "asx_roottableconfig", Value: { Kind: "reference", Value: publishedModelId, Entity: "asx_tableconfig" } },
    { Key: "asx_effectiveto", Value: { Kind: "date", Value: "2026-09-30T23:59:42.1250000Z" } },
  ] },
  { Entity: "asx_tableconfig", Id: publishedModelId, Attributes: [
    { Key: "asx_name", Value: { Kind: "string", Value: "Frozen account model" } },
    { Key: "asx_tablelogicalname", Value: { Kind: "string", Value: "account" } },
    { Key: "asx_tableconfigtype", Value: { Kind: "option", Value: "1" } },
  ] },
] });
