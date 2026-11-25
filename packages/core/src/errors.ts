export type AxiomErrorCode = "not-found" | "permission" | "validation" | "conflict";

export class AxiomError extends Error {
  readonly code: AxiomErrorCode;
  constructor(code: AxiomErrorCode, message: string) {
    super(message);
    this.name = "AxiomError";
    this.code = code;
  }
}
