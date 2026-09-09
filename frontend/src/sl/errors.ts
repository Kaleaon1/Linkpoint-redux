// Local stand-in for FastAPI's HTTPException — thrown by login.ts/router.ts,
// caught by callers exactly like the old fetch()-based api.ts errors: the
// screens already do `catch (e: any) { e?.message }`.
export class ApiError extends Error {
  status: number;
  detail: any;
  constructor(status: number, detail: any) {
    super(typeof detail === "string" ? detail : JSON.stringify(detail));
    this.status = status;
    this.detail = detail;
    this.name = "ApiError";
  }
}
