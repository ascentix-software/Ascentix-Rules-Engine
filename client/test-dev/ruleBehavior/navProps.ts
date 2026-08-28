import { createDevApi } from "../devApi";

// The @odata.bind nav-property name for a lookup = the ManyToOne relationship's
// ReferencingEntityNavigationPropertyName. Resolve it live (sample nav props aren't hardcoded).
export async function resolveNavProp(
  entity: string, referencedEntity: string, referencingAttr: string,
): Promise<string> {
  const api = createDevApi();
  const path =
    `EntityDefinitions(LogicalName='${entity}')/ManyToOneRelationships` +
    `?$select=ReferencingEntityNavigationPropertyName,ReferencedEntity,ReferencingAttribute`;
  const r = await api.fetchJson(path);
  const rel = (r.value ?? []).find(
    (x: any) => x.ReferencedEntity === referencedEntity && x.ReferencingAttribute === referencingAttr,
  );
  if (!rel) throw new Error(`No M:1 ${entity}.${referencingAttr} -> ${referencedEntity}`);
  return rel.ReferencingEntityNavigationPropertyName as string;
}
