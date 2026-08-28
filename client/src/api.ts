import type { RulesEnvelope, RunRulesResult, FiredAction } from "./contract";

// Matches Xrm.WebApi.online.execute: takes a request with parameter properties
// and a getMetadata() descriptor, returns a fetch-like response with json().
export type ExecuteFn = (request: unknown) => Promise<{ json: () => Promise<any> }>;

export interface RulesApi {
  readRules(table: string, triggers: string): Promise<RulesEnvelope>;
  runRules(
    table: string,
    recordId: string | null,
    recordJson: string,
    triggers: string,
  ): Promise<RunRulesResult>;
}

const STRING_PARAM = { typeName: "Edm.String", structuralProperty: 1 };

export function createApi(execute: ExecuteFn): RulesApi {
  return {
    async readRules(table, triggers) {
      const request = {
        TableName: table,
        Triggers: triggers,
        getMetadata: () => ({
          boundParameter: null,
          operationType: 1, // Function
          operationName: "asx_ReadRules",
          parameterTypes: { TableName: STRING_PARAM, Triggers: STRING_PARAM },
        }),
      };
      const body = await (await execute(request)).json();
      if (body == null || body.Rules == null)
        throw new Error("asx_ReadRules returned no Rules payload");
      return JSON.parse(body.Rules) as RulesEnvelope;
    },

    async runRules(table, recordId, recordJson, triggers) {
      const params: Record<string, unknown> = {
        TableName: table,
        RecordJson: recordJson,
        Triggers: triggers,
      };
      const paramTypes: Record<string, unknown> = {
        TableName: STRING_PARAM,
        RecordJson: STRING_PARAM,
        Triggers: STRING_PARAM,
      };
      if (recordId !== null) {
        params.RecordId = recordId;
        paramTypes.RecordId = STRING_PARAM;
      }
      const request = {
        ...params,
        getMetadata: () => ({
          boundParameter: null,
          operationType: 0, // Action
          operationName: "asx_RunRules",
          parameterTypes: paramTypes,
        }),
      };
      const body = await (await execute(request)).json();
      // An absent `Results` output parameter means the server did not answer the question,
      // NOT "the rules ran and nothing fired". Defaulting it to "[]" makes those two
      // indistinguishable, and the empty list flows through to the applier, which clears
      // every notification and restores every governed control: a validation product failing
      // OPEN, silently, with nothing logged. Mirror readRules above and reject the shape, so
      // engine.ts's catch logs and retains the last state.
      if (body == null || body.Results == null)
        throw new Error("asx_RunRules returned no Results payload");
      const fired = JSON.parse(body.Results) as FiredAction[];
      // Assemble RunRulesResult from the three separate asx_RunRules output parameters:
      // IsValid and FailedRuleCount are scalar outputs; Results is a JSON-string array of
      // FiredAction objects. There is no single combined object returned by the server.
      return {
        isValid: body?.IsValid as boolean,
        failedRuleCount: body?.FailedRuleCount as number,
        firedActions: fired,
      };
    },
  };
}
