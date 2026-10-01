// Seam assertions: a violated pre- or postcondition is a bug in ktx, never a
// user error, so it throws with the condition named rather than returning.
export class AssertionError extends Error {}

export function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new AssertionError(`assertion failed: ${message}`);
}
