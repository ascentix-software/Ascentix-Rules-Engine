// Temp ids tag nodes created in the editor before their first save. The diff
// treats a node whose id passes isNewId() as a create; the batch builder maps
// each temp id to a $N Content-ID reference.
const PREFIX = "new-";
let counter = 0;

export function newTempId(): string {
  counter += 1;
  return PREFIX + counter;
}

export function isNewId(id: string): boolean {
  return id.startsWith(PREFIX);
}

export function resetTempIds(): void {
  counter = 0;
}
