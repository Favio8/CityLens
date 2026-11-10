/** 统一的 API 错误结构（PRD 3.4）。 */
export class ApiError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly statusCode = 400,
    readonly retryAfterSec?: number,
  ) {
    super(message);
    this.name = 'ApiError';
  }

  toJSON(): { code: string; message: string; retryAfterSec?: number } {
    return this.retryAfterSec === undefined
      ? { code: this.code, message: this.message }
      : { code: this.code, message: this.message, retryAfterSec: this.retryAfterSec };
  }
}
