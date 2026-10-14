export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string) { super(message); }
}
export function requireThat(value: unknown, status: number, code: string, message: string): asserts value {
  if (!value) throw new ApiError(status, code, message);
}
